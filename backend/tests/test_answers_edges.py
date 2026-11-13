"""Edge cases of marking (RN006), score (RN007) and requirement edits (RN017)
not covered by ``test_answers.py``: stripe exams, the answers counter after
repeated unmarks, the ``PUT /requirements`` behaviour kept by ``UpdateItem``,
kind changes, the belt and kind lock of answered items and what a guardian
gets back.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    GUARDIAN,
    MASTER,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, ExamKind
from domain.requirements import Requirement, RequirementKind
from handlers import exams as handlers
from handlers import requirements as requirement_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import REQUIREMENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


def _requirement(
    req_id: str, *, belt: str = TARGET, kind: RequirementKind = RequirementKind.THEORY
) -> Requirement:
    requirement = Requirement(
        id=req_id,
        belt_id=belt_id(belt),
        kind=kind,
        category="Vocabulário",
        description=f"Item {req_id}",
        expected_answer=None,
        sort_order=1,
    )
    requirement_repo.create_requirement(requirement)
    return requirement


def _exam_for(student_id: str, **student: Any) -> Exam:
    if event_repo.get_event("event-1") is None:
        event_repo.create_event(
            ExamEvent(
                id="event-1",
                name="Exame março/2027",
                exam_date=date(2027, 3, 20),
                status=EventStatus.OPEN,
                created_at=NOW,
                updated_at=NOW,
            )
        )
    student_repo.create_student(replace(make_student(**student), id=student_id))
    response = handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": "event-1"}, body={"student_id": student_id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    exam = exam_repo.get_exam("event-1", student_id)
    assert exam is not None
    return exam


@pytest.fixture
def exam(seeded: None) -> Exam:
    return _exam_for("student-1")


def _path(exam: Exam, requirement_id: str | None = None) -> dict[str, str]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    if requirement_id is not None:
        path["requirement_id"] = requirement_id
    return path


def _mark(exam: Exam, req_id: str, correct: bool, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.mark_answer(
        api_event(user, path=_path(exam, req_id), body={"correct": correct}), None
    )


def _unmark(exam: Exam, req_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.unmark_answer(api_event(user, path=_path(exam, req_id)), None)


def _sheet(exam: Exam, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.get_exam_sheet(api_event(user, path=_path(exam)), None)


def _answer_count(req_id: str) -> int:
    item = table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": req_id})["Item"]
    return int(item.get("answer_count", 0))


def _put_requirement(req_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    # Items of the main profile: only the admin master writes them (#144).
    return requirement_handlers.update_requirement(
        api_event(MASTER, path={"id": req_id}, body=payload), None
    )


def test_rn006_stripe_exam_marks_items_of_the_target_belt(seeded: None) -> None:
    # Green without stripes: stripe exam towards Purple (the items are Purple's).
    exam = _exam_for(
        "student-verde", belt_name="Verde", birth=date(2012, 6, 1), since=date(2026, 8, 1)
    )
    assert exam.kind == ExamKind.STRIPE
    _requirement("roxa-1", belt="Roxa")
    _requirement("verde-1", belt="Verde")

    assert _mark(exam, "roxa-1", True)["statusCode"] == 200
    rejected = _mark(exam, "verde-1", True)
    assert rejected["statusCode"] == 400
    assert response_json(rejected)["message"] == "Item não pertence à faixa do exame"
    assert [item["id"] for item in response_json(_sheet(exam))["items"]] == ["roxa-1"]


def test_rn006_answer_counter_never_goes_below_zero(exam: Exam) -> None:
    _requirement("t1")
    assert _mark(exam, "t1", True)["statusCode"] == 200
    assert _unmark(exam, "t1")["statusCode"] == 200
    assert _unmark(exam, "t1")["statusCode"] == 200
    assert _answer_count("t1") == 0

    assert _mark(exam, "t1", False)["statusCode"] == 200
    assert _mark(exam, "t1", True)["statusCode"] == 200
    assert _answer_count("t1") == 1


def test_rn017_put_keeps_the_old_behaviour(exam: Exam) -> None:
    _requirement("t1")
    payload = {
        "belt_id": belt_id(TARGET),
        "kind": "PRACTICE",
        "category": "Nova",
        "description": "Desc",
        "expected_answer": "R",
        "sort_order": 7,
    }
    assert _put_requirement("t1", payload)["statusCode"] == 200

    # Omitted optional field is removed, as the old put_item did.
    payload.pop("expected_answer")
    response = _put_requirement("t1", payload)
    assert response["statusCode"] == 200
    assert response_json(response)["expected_answer"] is None
    assert "expected_answer" not in table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": "t1"})["Item"]

    # Without sort_order the item keeps its place.
    payload.pop("sort_order")
    assert response_json(_put_requirement("t1", payload))["sort_order"] == 7

    missing = _put_requirement("missing", payload)
    assert missing["statusCode"] == 404
    assert response_json(missing)["message"] == "Requisito não encontrado"
    assert requirement_repo.get_requirement("missing") is None


def test_rn017_put_of_item_deleted_meanwhile_is_404_and_does_not_recreate(
    exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    _requirement("t1")
    real_get = requirement_repo.get_requirement

    def deleted_after_read(req_id: str) -> Requirement | None:
        requirement = real_get(req_id)
        table(REQUIREMENTS_TABLE_ENV).delete_item(Key={"id": req_id})
        return requirement

    monkeypatch.setattr(requirement_repo, "get_requirement", deleted_after_read)
    payload = {"belt_id": belt_id(TARGET), "kind": "THEORY", "category": "c", "description": "d"}
    response = _put_requirement("t1", payload)
    monkeypatch.undo()

    assert response["statusCode"] == 404
    assert response_json(response)["message"] == "Requisito não encontrado"
    assert requirement_repo.get_requirement("t1") is None


def test_rn017_kind_change_of_answered_item_is_409_and_keeps_the_answer(exam: Exam) -> None:
    _requirement("t1")
    _requirement("p1", kind=RequirementKind.PRACTICE)
    assert _mark(exam, "t1", True)["statusCode"] == 200
    payload = {
        "belt_id": belt_id(TARGET),
        "kind": "PRACTICE",
        "category": "c",
        "description": "d",
        "sort_order": 1,
    }
    response = _put_requirement("t1", payload)
    assert response["statusCode"] == 409
    assert response_json(response)["message"] == (
        "Não é possível trocar a faixa ou o tipo de um requisito com respostas registradas"
    )

    summary = response_json(_sheet(exam))["summary"]
    assert (summary["THEORY"]["total"], summary["THEORY"]["correct"]) == (1, 1)
    assert summary["THEORY"]["percent"] == 100.0
    assert (summary["PRACTICE"]["total"], summary["PRACTICE"]["correct"]) == (1, 0)
    assert requirement_repo.get_requirement("t1").kind == RequirementKind.THEORY


def test_rn006_guardian_gets_only_the_message(exam: Exam) -> None:
    _requirement("t1")
    assert _mark(exam, "t1", True)["statusCode"] == 200
    other = replace(exam, student_id="no-such-student")

    for response in (
        _sheet(exam, user=GUARDIAN),
        _sheet(other, user=GUARDIAN),
        _mark(exam, "t1", False, user=GUARDIAN),
        _unmark(exam, "t1", user=GUARDIAN),
    ):
        assert response["statusCode"] == 403
        assert response_json(response) == {"message": "Esta área é dos examinadores"}
    assert response_json(_sheet(exam))["items"][0]["answer"]["correct"] is True


def _locked_payload(**overrides: Any) -> dict[str, Any]:
    payload = {
        "belt_id": belt_id(TARGET),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Item t1",
        "sort_order": 1,
    }
    payload.update(overrides)
    return payload


def test_rn017_unknown_belt_on_answered_item_is_400_and_keeps_the_answer(exam: Exam) -> None:
    _requirement("t1")
    assert _mark(exam, "t1", True)["statusCode"] == 200

    response = _put_requirement("t1", _locked_payload(belt_id="no-such-belt"))

    assert response["statusCode"] == 400, response["body"]
    assert requirement_repo.get_requirement("t1").belt_id == belt_id(TARGET)
    assert _answer_count("t1") == 1


@pytest.mark.parametrize("kind", ["practice", "theory", "Theory"])
def test_rn017_kind_in_other_case_never_moves_an_answered_item(exam: Exam, kind: str) -> None:
    _requirement("t1")
    assert _mark(exam, "t1", True)["statusCode"] == 200

    response = _put_requirement("t1", _locked_payload(kind=kind))

    assert response["statusCode"] in (400, 409), response["body"]
    assert requirement_repo.get_requirement("t1").kind == RequirementKind.THEORY
    assert response_json(_sheet(exam))["summary"]["THEORY"]["correct"] == 1


def test_rn017_edit_of_answered_item_keeps_the_counter_and_the_lock(exam: Exam) -> None:
    _requirement("t1")
    assert _mark(exam, "t1", True)["statusCode"] == 200

    response = _put_requirement(
        "t1",
        _locked_payload(description="Nova", category="Outra", expected_answer="X", sort_order=9),
    )

    assert response["statusCode"] == 200, response["body"]
    assert "answer_count" not in response_json(response)
    assert _answer_count("t1") == 1
    item = next(i for i in response_json(_sheet(exam))["items"] if i["id"] == "t1")
    assert (item["description"], item["answer"]["correct"]) == ("Nova", True)
    deleted = requirement_handlers.delete_requirement(api_event(MASTER, path={"id": "t1"}), None)
    assert deleted["statusCode"] == 409
    assert _put_requirement("t1", _locked_payload(belt_id=belt_id("Cinza")))["statusCode"] == 409


def test_rn017_guardian_cannot_move_an_answered_item(exam: Exam) -> None:
    _requirement("t1")
    assert _mark(exam, "t1", True)["statusCode"] == 200

    response = requirement_handlers.update_requirement(
        api_event(GUARDIAN, path={"id": "t1"}, body=_locked_payload(belt_id=belt_id("Cinza"))),
        None,
    )

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": "Esta área é dos examinadores"}
    assert requirement_repo.get_requirement("t1").belt_id == belt_id(TARGET)
