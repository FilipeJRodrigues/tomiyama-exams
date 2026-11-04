"""O evento lido por chave podia estar defasado logo depois de gravado (RN016).

Observado: ``repository.events.get_event`` lia a tabela ``Events`` sem
``ConsistentRead``. A leitura eventualmente consistente pode, por cerca de 1 s
depois de uma gravação, devolver a versão anterior do item, ou nenhum item
quando ele acabou de ser criado. Ela decide o 404 de ``GET``/``PUT``/``DELETE
/events/{id}`` (``_get_or_404``) e de presença, ficha, marcação e decisão
(``_event_or_404`` em ``handlers/exams.py``). Assim, um ``PUT``, ``DELETE`` ou
presença logo depois do ``POST /events`` respondia 404 "Evento não encontrado"
(e o front tratava o evento como apagado), a ficha mostrava a situação antiga
logo depois de encerrar e a marcação logo depois de reabrir era recusada com
"Evento encerrado".

Esperado: a leitura por chave do evento usa ``ConsistentRead=True``. O moto é
sempre consistente; ``lag_eventual_reads`` (``conftest.py``) faz a tabela
responder como uma réplica uma gravação atrás às leituras sem
``ConsistentRead`` e registra os parâmetros de cada ``GetItem``.

Issue: #64
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, api_event, belt_id, lag_eventual_reads, make_student, response_json

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.requirements import Requirement, RequirementKind
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import EVENTS_TABLE_ENV

EVENT_DATE = "2027-03-20"
NOW = "2026-11-01T12:00:00+00:00"
STUDENT_ID = "student-1"
REQUIREMENT_ID = "t1"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2027-03-20T13:45:00+00:00")


@pytest.fixture
def student(seeded: None) -> str:
    """Aluno Cinza ativo e elegível para a faixa Cinza/Azul na data do evento."""
    student_repo.create_student(replace(make_student(), id=STUDENT_ID, full_name="Ana"))
    requirement_repo.create_requirement(
        Requirement(
            id=REQUIREMENT_ID,
            belt_id=belt_id("Cinza/Azul"),
            kind=RequirementKind.THEORY,
            category="Vocabulário",
            description="Item t1",
            expected_answer="Resposta",
            sort_order=1,
        )
    )
    return STUDENT_ID


def _create_event_via_api() -> str:
    response = event_handlers.create_event(
        api_event(EXAMINER, body={"name": "Exame março/2027", "exam_date": EVENT_DATE}), None
    )
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)["id"]


def _event_with_exam(status: EventStatus) -> str:
    """Evento já existente com a presença do aluno confirmada, na situação pedida."""
    event_repo.create_event(
        ExamEvent(
            id="event-1",
            name="Exame março/2027",
            exam_date=date.fromisoformat(EVENT_DATE),
            status=EventStatus.OPEN,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": "event-1"}, body={"student_id": STUDENT_ID}), None
    )
    assert response["statusCode"] == 201, response["body"]
    if status != EventStatus.OPEN:
        _put_status("event-1", status)
    return "event-1"


def _put_status(event_id: str, status: EventStatus) -> dict[str, Any]:
    response = event_handlers.update_event(
        api_event(
            EXAMINER,
            path={"id": event_id},
            body={"name": "Exame março/2027", "exam_date": EVENT_DATE, "status": status.value},
        ),
        None,
    )
    assert response["statusCode"] == 200, response["body"]
    return response


def _not_consistent(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [call for call in calls if call.get("ConsistentRead") is not True]


def test_rn016_get_event_reads_events_table_consistently(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    event_repo.create_event(
        ExamEvent(
            id="event-1",
            name="Exame março/2027",
            exam_date=date.fromisoformat(EVENT_DATE),
            status=EventStatus.OPEN,
            created_at=NOW,
            updated_at=NOW,
        )
    )

    found = event_repo.get_event("event-1")

    assert calls, "get_event deveria ler a tabela Events com GetItem"
    assert not _not_consistent(calls), (
        f"get_event deve usar ConsistentRead=True; leituras sem ele: {_not_consistent(calls)}"
    )
    assert found is not None and found.id == "event-1"


def test_rn016_get_right_after_create_finds_event(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    event_id = _create_event_via_api()

    response = event_handlers.get_event(api_event(EXAMINER, path={"id": event_id}), None)

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["id"] == event_id


def test_rn016_update_right_after_create_finds_event(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    event_id = _create_event_via_api()

    response = event_handlers.update_event(
        api_event(
            EXAMINER,
            path={"id": event_id},
            body={"name": "Exame março/2027 turma B", "exam_date": EVENT_DATE, "status": "CLOSED"},
        ),
        None,
    )

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["name"] == "Exame março/2027 turma B"
    assert body["status"] == "CLOSED"


def test_rn016_delete_right_after_create_removes_event(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    event_id = _create_event_via_api()

    response = event_handlers.delete_event(api_event(EXAMINER, path={"id": event_id}), None)

    assert response["statusCode"] == 204, response["body"]
    assert [item.id for item in event_repo.list_all()] == []


def test_rn016_attendance_right_after_create_is_confirmed(
    student: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    event_id = _create_event_via_api()

    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": student}), None
    )

    assert response["statusCode"] == 201, response["body"]


def test_rn016_sheet_shows_closed_status_right_after_closing(
    student: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    event_id = _event_with_exam(EventStatus.OPEN)
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    _put_status(event_id, EventStatus.CLOSED)

    response = exam_handlers.get_exam_sheet(
        api_event(EXAMINER, path={"id": event_id, "student_id": student}), None
    )

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["event"]["status"] == "CLOSED"


def test_rn016_marking_right_after_reopening_is_accepted(
    student: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    event_id = _event_with_exam(EventStatus.CLOSED)
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    _put_status(event_id, EventStatus.OPEN)

    response = exam_handlers.mark_answer(
        api_event(
            EXAMINER,
            path={"id": event_id, "student_id": student, "requirement_id": REQUIREMENT_ID},
            body={"correct": True},
        ),
        None,
    )

    assert response["statusCode"] == 200, response["body"]
