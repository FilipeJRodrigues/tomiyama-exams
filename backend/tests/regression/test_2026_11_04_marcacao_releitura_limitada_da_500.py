"""Marcação recusada com releitura limitada pelo DynamoDB respondia 500, e não 503.

Erro observado: quando a transação da marcação (``PUT .../answers/{requirement_id}``)
ou da desmarcação (``DELETE .../answers/{requirement_id}``) é recusada por uma
condição, ``repository.answers._guard_error`` relê o exame (``Exams``) ou o
evento (``Events``) e ``_requirement_error`` relê o requisito
(``Requirements``) para escolher o erro. Essas releituras chamam
``table(...).get_item`` direto, sem ``get_item_or_busy``: um
``ProvisionedThroughputExceededException`` que persiste depois das tentativas do
botocore sai como ``ClientError`` cru e o ``api_handler`` responde 500 "Erro
interno. Tente de novo.". No dev, ``Exams`` e ``Events`` têm 2 RCU e
``Requirements`` 3, e desde o #78 cada releitura consistente custa 1 RCU.

Esperado (RN006, RN010, RN016, contrato do ``backend/README.md``: "limite de
capacidade do DynamoDB que persistiu" → 503 "Sistema ocupado no momento. Tente
de novo em instantes."), como já acontece nas releituras da presença e da
decisão (``repository.exams``, via ``get_item_or_busy``), e nada é gravado.

O limite vale só para a releitura: ele é ativado dentro da transação falsa,
logo antes do ``TransactionCanceledException``, e desligado antes das
asserções. Assim as leituras do handler antes da gravação (evento, exame e
requisito) usam a tabela real, e cada caso chega de fato à releitura.

Achado no QA do #78 (pendência que já existia antes dele).
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, belt_id, make_student

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.requirements import Requirement, RequirementKind
from handlers import exams as exam_handlers
from repository import answers as answer_repo
from repository import events as event_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import (
    ANSWERS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    REQUIREMENTS_TABLE_ENV,
    table,
)

EVENT_ID = "event-1"
STUDENT_ID = "student-1"
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
BUSY = "Sistema ocupado no momento. Tente de novo em instantes."
REQUIREMENT = Requirement(
    id="t1",
    belt_id=belt_id("Cinza/Azul"),
    kind=RequirementKind.THEORY,
    category="Vocabulário",
    description="Item t1",
    expected_answer="Resposta",
    sort_order=1,
)

# Order of the answer transaction items (repository.answers):
# exam check, event check, answer write, requirement update/check.
_EXAM, _EVENT, _REQUIREMENT = 0, 1, 3


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


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


@pytest.fixture
def exam_ready(seeded: None) -> None:
    """Evento aberto, aluno Cinza com presença confirmada e o item t1 da Cinza/Azul."""
    event_repo.create_event(
        ExamEvent(EVENT_ID, "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
    )
    student_repo.create_student(replace(make_student(), id=STUDENT_ID, full_name="Ana"))
    requirement_repo.create_requirement(REQUIREMENT)
    confirmed = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": EVENT_ID}, body={"student_id": STUDENT_ID}), None
    )
    assert confirmed["statusCode"] == 201, confirmed["body"]


def _call(route: str) -> dict[str, Any]:
    path = {"id": EVENT_ID, "student_id": STUDENT_ID, "requirement_id": REQUIREMENT.id}
    if route == "mark":
        return exam_handlers.mark_answer(
            api_event(EXAMINER, path=path, body={"correct": True}), None
        )
    return exam_handlers.unmark_answer(api_event(EXAMINER, path=path), None)


@pytest.mark.parametrize(
    ("route", "failed_item", "reread_env"),
    [
        ("mark", _EXAM, EXAMS_TABLE_ENV),  # exam decided/deleted: _guard_error
        ("mark", _EVENT, EVENTS_TABLE_ENV),  # event closed/deleted: _guard_error
        ("mark", _REQUIREMENT, REQUIREMENTS_TABLE_ENV),  # item deleted/moved: _requirement_error
        ("unmark", _EXAM, EXAMS_TABLE_ENV),
        ("unmark", _EVENT, EVENTS_TABLE_ENV),
    ],
)
def test_rn006_throttled_reread_after_refused_marking_is_503(
    exam_ready: None,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    failed_item: int,
    reread_env: str,
) -> None:
    requirement_before = table(REQUIREMENTS_TABLE_ENV).get_item(
        Key={"id": REQUIREMENT.id}, ConsistentRead=True
    )["Item"]
    codes = ["None", "None", "None", "None"]
    codes[failed_item] = "ConditionalCheckFailed"
    throttling = [False]

    def cancelled(items: list[dict[str, Any]]) -> None:
        # Throttle only the re-read made after the refused transaction.
        throttling[0] = True
        raise _cancelled(*codes)

    real_table = answer_repo.table
    monkeypatch.setattr(answer_repo, "_transact", cancelled)
    monkeypatch.setattr(
        answer_repo,
        "table",
        lambda env: (
            _ThrottledTable(real_table(env), throttling) if env == reread_env else real_table(env)
        ),
    )

    response = _call(route)
    reached_transaction = throttling[0]
    throttling[0] = False

    assert reached_transaction, response["body"]
    assert response["statusCode"] == 503, response["body"]
    assert BUSY in response["body"]
    assert table(ANSWERS_TABLE_ENV).scan()["Items"] == []
    requirement_after = table(REQUIREMENTS_TABLE_ENV).get_item(
        Key={"id": REQUIREMENT.id}, ConsistentRead=True
    )["Item"]
    assert requirement_after == requirement_before
