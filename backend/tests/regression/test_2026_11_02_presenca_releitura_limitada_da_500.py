"""Presença recusada com releitura limitada pelo DynamoDB respondia 500, e não 503.

Erro observado: quando uma condição da transação da confirmação de presença
(``POST /events/{id}/exams``, ``repository.exams.create_exam``) falha, o
``repository.exams._condition_error`` relê ``Events`` (para separar evento
apagado, 404, de encerrado, 400) ou ``Students`` (para separar aluno apagado,
inativo ou com graduação alterada) direto com ``get_item``. Essa releitura não
trata o limite de capacidade: um ``ProvisionedThroughputExceededException``
que persiste depois das tentativas do botocore sai como ``ClientError`` cru e
vira 500 "Erro interno".

Esperado (RN005, contrato do ``backend/README.md``): "limite de capacidade do
DynamoDB que persistiu" → 503 "Sistema ocupado no momento. Tente de novo em
instantes.", como já acontece na releitura da decisão
(``test_2026_11_02_decisao_releitura_limitada_da_500.py``), e nada é gravado.

O limite vale só para a releitura de ``_condition_error``: ele é ativado
dentro da transação falsa, logo antes do ``TransactionCanceledException``, e
desligado antes das asserções. Assim as leituras anteriores do handler (evento,
aluno, exame já existente) e as checagens finais usam a tabela real.

A transação falsa não depende da posição dos itens: ela marca como
``ConditionalCheckFailed`` o item (``Put``, ``Update`` ou ``ConditionCheck``)
cuja ``TableName`` é a tabela relida e os demais como ``None``. Um aluno só
pode aparecer uma vez numa transação, então há um único item em ``Students``
mesmo que a condição "um exame em andamento por vez" seja acrescentada.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, make_student

from domain.events import EventStatus, ExamEvent
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo
from repository.tables import (
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    table,
)

NOW = "2026-11-01T12:00:00+00:00"
BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


def _table_name(transact_item: dict[str, Any]) -> str:
    (operation,) = transact_item.values()
    return operation["TableName"]


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


@pytest.mark.parametrize("reread_env", [EVENTS_TABLE_ENV, STUDENTS_TABLE_ENV])
def test_rn005_throttled_reread_after_failed_condition_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, reread_env: str
) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1")
    student_repo.create_student(student)
    event_before = table(EVENTS_TABLE_ENV).get_item(Key={"id": exam_event.id})["Item"]
    student_before = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]

    real_table = exam_repo.table
    failed_table = real_table(reread_env).name
    throttling = [False]
    failed_items: list[int] = []

    def cancelled(transact_items: list[dict[str, Any]]) -> None:
        codes = [
            "ConditionalCheckFailed" if _table_name(item) == failed_table else "None"
            for item in transact_items
        ]
        failed_items.extend(i for i, code in enumerate(codes) if code != "None")
        # Throttle only the re-read made after the failed transaction.
        throttling[0] = True
        raise ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                "CancellationReasons": [{"Code": code} for code in codes],
            },
            "TransactWriteItems",
        )

    monkeypatch.setattr(exam_repo, "_transact_create", cancelled)
    monkeypatch.setattr(
        exam_repo,
        "table",
        lambda env: (
            _ThrottledTable(real_table(env), throttling) if env == reread_env else real_table(env)
        ),
    )

    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    reached_transaction = throttling[0]
    throttling[0] = False

    assert reached_transaction, response["body"]
    assert len(failed_items) == 1, failed_items
    assert response["statusCode"] == 503, response["body"]
    assert BUSY in response["body"]
    assert exam_repo.get_exam(exam_event.id, student.id) is None
    assert table(EXAMS_TABLE_ENV).scan()["Items"] == []
    assert table(EVENTS_TABLE_ENV).get_item(Key={"id": exam_event.id})["Item"] == event_before
    assert table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"] == student_before
