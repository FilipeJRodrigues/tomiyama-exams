"""Decisão recusada com releitura limitada pelo DynamoDB respondia 500, e não 503.

Erro observado: quando uma condição da transação da decisão
(``POST /events/{id}/exams/{student_id}/decision``) falha, o
``repository.exams._decision_error`` relê a tabela direto com ``get_item``
(``Settings`` para separar a troca de sensei da remoção, ``Exams`` e
``Students`` para separar 404 de 409). Essa releitura não trata o limite de
capacidade: um ``ProvisionedThroughputExceededException`` que persiste depois
das tentativas do botocore sai como ``ClientError`` cru e vira 500 "Erro
interno". A ``SettingsTable`` de dev tem 1 RCU, e a decisão também a lê antes
da gravação, então o limite é plausível justamente na releitura nova.

Esperado (RN008, contrato do ``backend/README.md``): "limite de capacidade do
DynamoDB que persistiu" → 503 "Sistema ocupado no momento. Tente de novo em
instantes.", como já acontece na leitura das configurações
(``repository.settings._raise_busy``), e nada é gravado.

O limite vale só para a releitura de ``_decision_error``: ele é ativado dentro
da transação falsa, logo antes do ``TransactionCanceledException``, e desligado
antes das asserções. Assim as leituras anteriores do handler (por exemplo
``get_exam`` na tabela ``Exams``) e as checagens finais do teste usam a tabela
real, e os três casos chegam de fato à releitura.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, make_student

from domain.events import EventStatus, ExamEvent
from domain.exams import ExamStatus
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import (
    EXAMS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    table,
)

NOW = "2026-11-01T12:00:00+00:00"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


def _cancelled(*codes: str) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )


class _ThrottledTable:
    """The real table, except that ``get_item`` is throttled while ``active[0]`` is set."""

    def __init__(self, real: Any, active: list[bool]) -> None:
        self._real = real
        self._active = active

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def get_item(self, **kwargs: Any) -> Any:
        if not self._active[0]:
            return self._real.get_item(**kwargs)
        raise ClientError(
            {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
            "GetItem",
        )


@pytest.mark.parametrize(
    ("failed_item", "reread_env"),
    [
        (2, SETTINGS_TABLE_ENV),  # sensei check
        (0, EXAMS_TABLE_ENV),  # exam update
        (1, STUDENTS_TABLE_ENV),  # student check
    ],
)
def test_rn008_throttled_reread_after_failed_condition_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, failed_item: int, reread_env: str
) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1")
    student_repo.create_student(student)
    confirmed = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert confirmed["statusCode"] == 201, confirmed["body"]
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    student_before = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]

    codes = ["None", "None", "None"]
    codes[failed_item] = "ConditionalCheckFailed"

    throttling = [False]

    def cancelled(transact_items: list[dict[str, Any]]) -> None:
        # Throttle only the re-read made after the failed transaction.
        throttling[0] = True
        raise _cancelled(*codes)

    real_table = exam_repo.table
    monkeypatch.setattr(exam_repo, "_transact_decision", cancelled)
    monkeypatch.setattr(
        exam_repo,
        "table",
        lambda env: (
            _ThrottledTable(real_table(env), throttling) if env == reread_env else real_table(env)
        ),
    )

    response = exam_handlers.decide_exam(
        api_event(
            SENSEI,
            path={"id": exam_event.id, "student_id": student.id},
            body={"result": "APPROVED"},
        ),
        None,
    )
    reached_transaction = throttling[0]
    throttling[0] = False

    assert reached_transaction, response["body"]
    assert response["statusCode"] == 503, response["body"]
    assert BUSY in response["body"]
    exam = exam_repo.get_exam(exam_event.id, student.id)
    assert exam is not None
    assert exam.status == ExamStatus.IN_PROGRESS
    assert table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"] == student_before
