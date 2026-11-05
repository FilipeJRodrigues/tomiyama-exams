"""O exame lido por chave podia estar defasado logo depois de gravado (RN005–RN010).

Observado: ``repository.exams.get_exam`` lia a tabela ``Exams`` sem
``ConsistentRead``. A leitura eventualmente consistente pode, por cerca de 1 s
depois de uma gravação, devolver a versão anterior do item, ou nenhum item
quando ele acabou de ser criado. Ela decide o 404 de ``_exam_or_404`` em
``handlers/exams.py``: ficha ``GET /events/{id}/exams/{student_id}``, marcação
``PUT``/``DELETE .../answers/{requirement_id}`` e ``POST .../decision``. Assim, no
Dia do exame, abrir a ficha, marcar ou desmarcar um item ou decidir logo depois
de confirmar a presença respondia 404 "Exame não encontrado"; a ficha aberta
logo depois da decisão ainda mostrava o exame "Em andamento"; e uma segunda
decisão logo depois de uma aprovação respondia 409 "A graduação do aluno mudou
desde a presença" em vez de "Exame já decidido" (RN010).

Esperado: a leitura por chave do exame usa ``ConsistentRead=True``. O moto é
sempre consistente; ``lag_eventual_reads`` (``conftest.py``) faz a tabela
responder como uma réplica uma gravação atrás às leituras sem
``ConsistentRead``, inclusive às gravações feitas dentro de transações (a
presença e a decisão), e registra os parâmetros de cada ``GetItem``.

Issue: #78
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, api_event, belt_id, lag_eventual_reads, make_student, response_json

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.requirements import Requirement, RequirementKind
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EXAMS_TABLE_ENV

EVENT_ID = "event-1"
EVENT_DATE = date(2027, 3, 20)
NOW = "2026-11-01T12:00:00+00:00"
STUDENT_ID = "student-1"
REQUIREMENT_ID = "t1"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2027-03-20T13:45:00+00:00")


@pytest.fixture
def ready(seeded: None) -> None:
    """Evento aberto, sensei definido e aluno Cinza elegível para a Cinza/Azul (item t1)."""
    event_repo.create_event(
        ExamEvent(EVENT_ID, "Exame março/2027", EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    )
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
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


def _confirm() -> dict[str, Any]:
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": EVENT_ID}, body={"student_id": STUDENT_ID}), None
    )
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)


def _exam_path(**extra: str) -> dict[str, str]:
    return {"id": EVENT_ID, "student_id": STUDENT_ID, **extra}


def _decide(result: str) -> dict[str, Any]:
    return exam_handlers.decide_exam(
        api_event(SENSEI, path=_exam_path(), body={"result": result}), None
    )


def _sheet() -> dict[str, Any]:
    return exam_handlers.get_exam_sheet(api_event(EXAMINER, path=_exam_path()), None)


def _not_consistent(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [call for call in calls if call.get("ConsistentRead") is not True]


def test_rn005_get_exam_reads_exams_table_consistently(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV)
    confirmed = _confirm()

    found = exam_repo.get_exam(EVENT_ID, STUDENT_ID)

    assert found is not None and found.id == confirmed["id"], (
        "get_exam logo depois da presença deveria achar o exame"
    )
    assert not _not_consistent(calls), (
        f"get_exam deve usar ConsistentRead=True; leituras sem ele: {_not_consistent(calls)}"
    )


def test_rn006_sheet_right_after_attendance_finds_exam(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV)
    confirmed = _confirm()

    response = _sheet()

    assert response["statusCode"] == 200, response["body"]
    exam = response_json(response)["exam"]
    assert (exam["id"], exam["status"]) == (confirmed["id"], "IN_PROGRESS")


def test_rn006_marking_right_after_attendance_finds_exam(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV)
    _confirm()

    response = exam_handlers.mark_answer(
        api_event(EXAMINER, path=_exam_path(requirement_id=REQUIREMENT_ID), body={"correct": True}),
        None,
    )

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["summary"]["THEORY"]["correct"] == 1


def test_rn006_unmarking_right_after_attendance_finds_exam(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV)
    _confirm()

    response = exam_handlers.unmark_answer(
        api_event(EXAMINER, path=_exam_path(requirement_id=REQUIREMENT_ID)), None
    )

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["answer"] is None


def test_rn008_decision_right_after_attendance_finds_exam(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV)
    confirmed = _confirm()

    response = _decide("APPROVED")

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert (body["exam"]["id"], body["exam"]["status"]) == (confirmed["id"], "APPROVED")
    assert body["student"]["current_belt_id"] == belt_id("Cinza/Azul")


def test_rn010_sheet_right_after_decision_shows_decided_status(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _confirm()
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV)
    decided = _decide("FAILED")
    assert decided["statusCode"] == 200, decided["body"]

    response = _sheet()

    assert response["statusCode"] == 200, response["body"]
    exam = response_json(response)["exam"]
    assert (exam["status"], exam["decided_by_id"]) == ("FAILED", SENSEI.sub)


def test_rn010_second_decision_right_after_approval_answers_already_decided(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _confirm()
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV)
    approved = _decide("APPROVED")
    assert approved["statusCode"] == 200, approved["body"]

    response = _decide("FAILED")

    assert response["statusCode"] == 409, response["body"]
    assert response_json(response) == {"message": "Exame já decidido"}
