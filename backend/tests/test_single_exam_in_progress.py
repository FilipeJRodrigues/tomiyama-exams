"""One exam in progress per student (RN005, decision of 2026-11-02).

The attendance transaction writes the ``exam_in_progress_id`` marker on the
student only while it is absent; the decision transaction removes it, on
approval and on failure, only when it is the decided exam's. A confirmation in
another event while the marker exists is refused with 409 and writes nothing,
even when two confirmations race. Edits of the student keep the marker.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, make_student, response_json

from domain import dates
from domain.belts import SEED_BELTS
from domain.errors import ConflictError
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, confirm_attendance
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import exams as handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import (
    EVENTS_TABLE_ENV,
    EXAM_COUNT,
    EXAM_IN_PROGRESS,
    STUDENTS_TABLE_ENV,
    table,
)

NOW = "2026-11-01T12:00:00+00:00"
ELSEWHERE = "O aluno já tem um exame em andamento em outro evento."
ALREADY = "Presença já confirmada neste evento"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


def _event(event_id: str, exam_date: date) -> ExamEvent:
    exam_event = ExamEvent(event_id, f"Exame {event_id}", exam_date, EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(exam_event)
    return exam_event


@pytest.fixture
def events(seeded: None) -> tuple[ExamEvent, ExamEvent]:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    return _event("event-a", date(2027, 3, 20)), _event("event-b", date(2030, 6, 1))


@pytest.fixture
def student(seeded: None) -> Student:
    created = make_student()
    student_repo.create_student(created)
    return created


def _confirm(event_id: str, student_id: str) -> dict[str, Any]:
    return handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": student_id}), None
    )


def _decide(exam: Exam, result: str) -> dict[str, Any]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    return handlers.decide_exam(api_event(SENSEI, path=path, body={"result": result}), None)


def _item(env_var: str, item_id: str) -> dict[str, Any]:
    return table(env_var).get_item(Key={"id": item_id})["Item"]


def _exam(exam_event: ExamEvent, student_id: str) -> Exam:
    stored = exam_repo.get_exam(exam_event.id, student_id)
    assert stored is not None
    return stored


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response) == {"message": message}


def test_rn005_attendance_sets_the_marker(
    events: tuple[ExamEvent, ExamEvent], student: Student
) -> None:
    first, _ = events
    response = _confirm(first.id, student.id)
    assert response["statusCode"] == 201, response["body"]
    assert _item(STUDENTS_TABLE_ENV, student.id)[EXAM_IN_PROGRESS] == response_json(response)["id"]
    # The marker is internal: the exam view and the student view do not carry it.
    assert EXAM_IN_PROGRESS not in response_json(response)
    view = student_handlers.get_student(api_event(EXAMINER, path={"id": student.id}), None)
    assert EXAM_IN_PROGRESS not in response_json(view)


def test_rn005_exam_in_progress_in_another_event_is_409(
    events: tuple[ExamEvent, ExamEvent], student: Student
) -> None:
    first, second = events
    assert _confirm(first.id, student.id)["statusCode"] == 201
    before = _item(STUDENTS_TABLE_ENV, student.id)

    _assert_rejected(_confirm(second.id, student.id), 409, ELSEWHERE)

    # Nothing is written: no exam, no counters, the marker still the first exam's.
    assert exam_repo.get_exam(second.id, student.id) is None
    assert EXAM_COUNT not in _item(EVENTS_TABLE_ENV, second.id)
    assert _item(STUDENTS_TABLE_ENV, student.id) == before


def test_rn005_same_event_is_still_already_confirmed(
    events: tuple[ExamEvent, ExamEvent], student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, _ = events
    assert _confirm(first.id, student.id)["statusCode"] == 201
    _assert_rejected(_confirm(first.id, student.id), 409, ALREADY)
    # Without the handler's early check, the duplicate still wins over the marker.
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: None)
    _assert_rejected(_confirm(first.id, student.id), 409, ALREADY)


@pytest.mark.parametrize("result", ["APPROVED", "FAILED"])
def test_rn005_student_is_free_again_after_the_decision(
    events: tuple[ExamEvent, ExamEvent], student: Student, result: str
) -> None:
    first, second = events
    assert _confirm(first.id, student.id)["statusCode"] == 201
    exam = _exam(first, student.id)

    response = _decide(exam, result)

    assert response["statusCode"] == 200, response["body"]
    after = _item(STUDENTS_TABLE_ENV, student.id)
    assert EXAM_IN_PROGRESS not in after
    assert after[EXAM_COUNT] == 1
    confirmed = _confirm(second.id, student.id)
    assert confirmed["statusCode"] == 201, confirmed["body"]
    assert (
        _item(STUDENTS_TABLE_ENV, student.id)[EXAM_IN_PROGRESS] == (response_json(confirmed)["id"])
    )
    assert _item(STUDENTS_TABLE_ENV, student.id)[EXAM_COUNT] == 2


def test_rn005_race_between_two_events_gives_one_201_and_one_409(
    events: tuple[ExamEvent, ExamEvent], student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both requests read the student before either writes; the transaction decides."""
    first, second = events
    monkeypatch.setattr(student_repo, "get_student", lambda student_id: student)
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: None)

    responses = [_confirm(first.id, student.id), _confirm(second.id, student.id)]

    assert [r["statusCode"] for r in responses] == [201, 409]
    assert response_json(responses[1]) == {"message": ELSEWHERE}
    assert len(exam_repo.list_by_event(first.id)) == 1
    assert exam_repo.list_by_event(second.id) == []
    stored = _item(STUDENTS_TABLE_ENV, student.id)
    assert stored[EXAM_COUNT] == 1
    assert stored[EXAM_IN_PROGRESS] == response_json(responses[0])["id"]


def test_rn005_repository_refuses_without_the_read_student(
    events: tuple[ExamEvent, ExamEvent], student: Student
) -> None:
    first, second = events
    exam_repo.create_exam(confirm_attendance(first, student, SEED_BELTS, EXAMINER.sub, NOW))
    other = confirm_attendance(second, student, SEED_BELTS, EXAMINER.sub, NOW)
    with pytest.raises(ConflictError, match=ELSEWHERE):
        exam_repo.create_exam(other)
    with pytest.raises(ConflictError, match=ELSEWHERE):
        exam_repo.create_exam(other, student)


def test_rn005_student_edits_keep_the_marker(
    events: tuple[ExamEvent, ExamEvent], student: Student
) -> None:
    first, second = events
    assert _confirm(first.id, student.id)["statusCode"] == 201
    marker = _item(STUDENTS_TABLE_ENV, student.id)[EXAM_IN_PROGRESS]
    for user, name in ((GUARDIAN, "Ana Maria"), (EXAMINER, "Ana M.")):
        body = {
            "full_name": name,
            "birth_date": student.birth_date.isoformat(),
            "current_belt_id": student.current_belt_id,
            "current_belt_since": student.current_belt_since.isoformat(),
            "stripes": student.stripes,
            "federation_id": None,
            "active": True,
        }
        response = student_handlers.update_student(
            api_event(user, path={"id": student.id}, body=body), None
        )
        assert response["statusCode"] == 200, response["body"]
        assert _item(STUDENTS_TABLE_ENV, student.id)[EXAM_IN_PROGRESS] == marker
    student_repo.save_student(replace(student, full_name="Ana"))
    assert _item(STUDENTS_TABLE_ENV, student.id)[EXAM_IN_PROGRESS] == marker
    _assert_rejected(_confirm(second.id, student.id), 409, ELSEWHERE)


def _drop_marker(student_id: str) -> None:
    """Turn the student into data from before the marker (dev only)."""
    table(STUDENTS_TABLE_ENV).update_item(
        Key={"id": student_id}, UpdateExpression=f"REMOVE {EXAM_IN_PROGRESS}"
    )


def test_rn005_decision_never_removes_another_exams_marker(
    events: tuple[ExamEvent, ExamEvent], student: Student
) -> None:
    """Legacy data: an exam in progress without the marker does not block, and
    deciding it does not free the student from the exam that holds the marker."""
    first, second = events
    assert _confirm(first.id, student.id)["statusCode"] == 201
    legacy = _exam(first, student.id)
    _drop_marker(student.id)
    assert _confirm(second.id, student.id)["statusCode"] == 201
    current = _exam(second, student.id)
    before = _item(STUDENTS_TABLE_ENV, student.id)
    assert before[EXAM_IN_PROGRESS] == current.id

    _assert_rejected(_decide(legacy, "FAILED"), 409, ELSEWHERE)
    assert _exam(first, student.id) == legacy
    assert _item(STUDENTS_TABLE_ENV, student.id) == before

    # Once the exam holding the marker is decided, the legacy one can be too.
    assert _decide(current, "FAILED")["statusCode"] == 200
    assert _decide(legacy, "FAILED")["statusCode"] == 200
    assert EXAM_IN_PROGRESS not in _item(STUDENTS_TABLE_ENV, student.id)


def test_rn005_legacy_exam_without_marker_is_decided(
    events: tuple[ExamEvent, ExamEvent], student: Student
) -> None:
    first, _ = events
    assert _confirm(first.id, student.id)["statusCode"] == 201
    _drop_marker(student.id)
    assert _decide(_exam(first, student.id), "APPROVED")["statusCode"] == 200
    assert EXAM_IN_PROGRESS not in _item(STUDENTS_TABLE_ENV, student.id)
