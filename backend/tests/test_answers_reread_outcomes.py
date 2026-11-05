"""Releitura da marcação recusada: o erro escolhido sem throttling (RN006, RN010, RN016, #78).

Desde o #78, ``repository.answers._guard_error`` e ``_requirement_error`` releem
o exame, o evento e o requisito com ``get_item_or_busy(..., ConsistentRead=True)``
para que o throttling persistente responda 503. Estes testes garantem que o
resultado das releituras sem throttling não mudou: exame ausente ou trocado →
404, exame presente → 409 "Exame já decidido"; evento ausente → 404, presente →
400 "Evento encerrado"; requisito ausente → 404, presente → 400 "Item não
pertence à faixa do exame". Um erro do DynamoDB que não é de capacidade na
releitura continua saindo como 500, e não como 503. Em todos os casos nada é
gravado.

A transação é substituída por uma que aplica a mudança concorrente na tabela
real e é recusada pela condição correspondente, então cada caso chega de fato
à releitura.
"""

from collections.abc import Callable
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


def _cancelled(failed_item: int) -> ClientError:
    codes = ["None", "None", "None", "None"]
    codes[failed_item] = "ConditionalCheckFailed"
    return ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )


def _exam_key() -> dict[str, str]:
    return {"event_id": EVENT_ID, "student_id": STUDENT_ID}


def _delete_exam() -> None:
    table(EXAMS_TABLE_ENV).delete_item(Key=_exam_key())


def _replace_exam() -> None:
    table(EXAMS_TABLE_ENV).update_item(
        Key=_exam_key(),
        UpdateExpression="SET id = :other",
        ExpressionAttributeValues={":other": "another-exam"},
    )


def _delete_event() -> None:
    table(EVENTS_TABLE_ENV).delete_item(Key={"id": EVENT_ID})


def _delete_requirement() -> None:
    table(REQUIREMENTS_TABLE_ENV).delete_item(Key={"id": REQUIREMENT.id})


def _keep() -> None:
    """The item stays: the condition failed for its state (decided, closed, other belt)."""


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


def _refuse_after(
    monkeypatch: pytest.MonkeyPatch, change: Callable[[], None], failed_item: int
) -> list[bool]:
    reached = [False]

    def refused(items: list[dict[str, Any]]) -> None:
        reached[0] = True
        change()
        raise _cancelled(failed_item)

    monkeypatch.setattr(answer_repo, "_transact", refused)
    return reached


@pytest.mark.parametrize("route", ["mark", "unmark"])
@pytest.mark.parametrize(
    ("change", "failed_item", "status", "message"),
    [
        (_delete_exam, _EXAM, 404, "Exame não encontrado"),
        (_replace_exam, _EXAM, 404, "Exame não encontrado"),
        (_keep, _EXAM, 409, "Exame já decidido"),
        (_delete_event, _EVENT, 404, "Evento não encontrado"),
        (_keep, _EVENT, 400, "Evento encerrado"),
    ],
)
def test_rn010_rn016_refused_guard_reread_picks_the_same_error(
    exam_ready: None,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    change: Callable[[], None],
    failed_item: int,
    status: int,
    message: str,
) -> None:
    reached = _refuse_after(monkeypatch, change, failed_item)

    response = _call(route)

    assert reached[0], response["body"]
    assert response["statusCode"] == status, response["body"]
    assert message in response["body"]
    assert table(ANSWERS_TABLE_ENV).scan()["Items"] == []


@pytest.mark.parametrize(
    ("change", "status", "message"),
    [
        (_delete_requirement, 404, "Requisito não encontrado"),
        (_keep, 400, "Item não pertence à faixa do exame"),
    ],
)
def test_rn006_refused_requirement_reread_picks_the_same_error(
    exam_ready: None,
    monkeypatch: pytest.MonkeyPatch,
    change: Callable[[], None],
    status: int,
    message: str,
) -> None:
    reached = _refuse_after(monkeypatch, change, _REQUIREMENT)

    response = _call("mark")

    assert reached[0], response["body"]
    assert response["statusCode"] == status, response["body"]
    assert message in response["body"]
    assert table(ANSWERS_TABLE_ENV).scan()["Items"] == []


class _FailingTable:
    """The real table, except that ``get_item`` fails with a non-throttling error."""

    def __init__(self, real: Any) -> None:
        self._real = real

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def get_item(self, **kwargs: Any) -> Any:
        raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "x"}}, "GetItem")


@pytest.mark.parametrize(
    ("route", "failed_item", "reread_env"),
    [
        ("mark", _EXAM, EXAMS_TABLE_ENV),
        ("mark", _EVENT, EVENTS_TABLE_ENV),
        ("mark", _REQUIREMENT, REQUIREMENTS_TABLE_ENV),
        ("unmark", _EXAM, EXAMS_TABLE_ENV),
        ("unmark", _EVENT, EVENTS_TABLE_ENV),
    ],
)
def test_rn006_non_throttling_error_on_reread_stays_500(
    exam_ready: None,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    failed_item: int,
    reread_env: str,
) -> None:
    failing = [False]
    real_table = answer_repo.table

    def change() -> None:
        failing[0] = True

    reached = _refuse_after(monkeypatch, change, failed_item)
    monkeypatch.setattr(
        answer_repo,
        "table",
        lambda env: (
            _FailingTable(real_table(env)) if failing[0] and env == reread_env else real_table(env)
        ),
    )

    response = _call(route)
    failing[0] = False

    assert reached[0], response["body"]
    assert response["statusCode"] == 500, response["body"]
    assert "Erro interno. Tente de novo." in response["body"]
    assert table(ANSWERS_TABLE_ENV).scan()["Items"] == []
