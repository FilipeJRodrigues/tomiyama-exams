"""Exams counter (``exam_count``) on events and students.

The attendance transaction (RN005) adds 1 to the counter of the event and of
the student. The deletes (RN016, RN018) and the guardian's graduation lock
(RN013) are conditional writes on that counter, so they hold even when an
attendance is confirmed after the handler's own check.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, belt_id, make_student, response_json

from domain import dates
from domain.errors import ConflictError, NotFoundError
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EVENTS_TABLE_ENV, STUDENTS_TABLE_ENV, table

TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
LOCKED = "Somente examinadores alteram a graduação após o primeiro exame"


@pytest.fixture(autouse=True)
def _fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)


def _event(event_id: str = "event-1") -> ExamEvent:
    exam_event = ExamEvent(
        event_id, "Exame março/2027", date(2027, 3, 13), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    return exam_event


def _student() -> Student:
    student = replace(make_student(), id="student-1")
    student_repo.create_student(student)
    return student


def _confirm(event_id: str, student_id: str) -> dict[str, Any]:
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": student_id}), None
    )


def _count(env_var: str, item_id: str) -> int:
    item = table(env_var).get_item(Key={"id": item_id})["Item"]
    return int(item.get("exam_count", 0))


def _decide_failed(event_id: str, student_id: str) -> None:
    """Have the sensei fail the exam, so it is no longer in progress (RN005)."""
    sensei = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=sensei.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    path = {"id": event_id, "student_id": student_id}
    response = exam_handlers.decide_exam(
        api_event(sensei, path=path, body={"result": "FAILED"}), None
    )
    assert response["statusCode"] == 200, response["body"]


def _student_payload(student: Student, **changes: Any) -> dict[str, Any]:
    payload = {
        "full_name": student.full_name,
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "federation_id": student.federation_id,
        "active": student.active,
    }
    return payload | changes


def test_rn005_attendance_increments_counters(seeded: None) -> None:
    exam_event = _event()
    student = _student()
    assert _confirm(exam_event.id, student.id)["statusCode"] == 201
    assert _count(EVENTS_TABLE_ENV, exam_event.id) == 1
    assert _count(STUDENTS_TABLE_ENV, student.id) == 1


def test_rn005_same_student_in_two_open_events(seeded: None) -> None:
    """Decision of 2026-11-02: one exam in progress per student; nothing is counted."""
    first = _event("event-1")
    second = _event("event-2")
    student = _student()
    assert _confirm(first.id, student.id)["statusCode"] == 201
    response = _confirm(second.id, student.id)
    assert response["statusCode"] == 409, response["body"]
    assert response_json(response)["message"] == (
        "O aluno já tem um exame em andamento em outro evento."
    )
    assert _count(STUDENTS_TABLE_ENV, student.id) == 1
    assert _count(EVENTS_TABLE_ENV, first.id) == 1
    assert _count(EVENTS_TABLE_ENV, second.id) == 0


def test_rn005_graduation_changed_between_read_and_write_is_409(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _event()
    stale = _student()
    student_repo.save_student(replace(stale, stripes=1))
    monkeypatch.setattr(student_repo, "get_student", lambda student_id: stale)

    response = _confirm(exam_event.id, stale.id)

    assert response["statusCode"] == 409, response["body"]
    assert response_json(response)["message"] == "Os dados do aluno mudaram. Tente de novo."
    assert exam_repo.get_exam(exam_event.id, stale.id) is None
    assert _count(EVENTS_TABLE_ENV, exam_event.id) == 0
    assert _count(STUDENTS_TABLE_ENV, stale.id) == 0


def test_rn016_rn018_edits_keep_exam_count(seeded: None) -> None:
    """Editing the event and the student never resets the counter."""
    exam_event = _event()
    student = _student()
    assert _confirm(exam_event.id, student.id)["statusCode"] == 201

    response = event_handlers.update_event(
        api_event(
            EXAMINER, path={"id": exam_event.id}, body={"name": "Exame 2", "status": "CLOSED"}
        ),
        None,
    )
    assert response["statusCode"] == 200, response["body"]
    for user, name in ((GUARDIAN, "Ana Maria"), (EXAMINER, "Ana M.")):
        response = student_handlers.update_student(
            api_event(
                user, path={"id": student.id}, body=_student_payload(student, full_name=name)
            ),
            None,
        )
        assert response["statusCode"] == 200, response["body"]
    # Direct repository writes (other edit paths) keep it too.
    event_repo.save_event(replace(exam_event, name="Exame 3"))
    student_repo.save_student(replace(student, full_name="Ana"))

    assert _count(EVENTS_TABLE_ENV, exam_event.id) == 1
    assert _count(STUDENTS_TABLE_ENV, student.id) == 1
    # The conditional writes themselves refuse, not only the handlers' checks.
    with pytest.raises(ConflictError, match="Evento possui exames registrados"):
        event_repo.delete_event(exam_event.id)
    with pytest.raises(ConflictError, match="Aluno possui exames registrados"):
        student_repo.delete_student(student.id)
    response = event_handlers.delete_event(api_event(EXAMINER, path={"id": exam_event.id}), None)
    assert response["statusCode"] == 409
    response = student_handlers.delete_student(api_event(GUARDIAN, path={"id": student.id}), None)
    assert response["statusCode"] == 409
    assert event_repo.get_event(exam_event.id) is not None
    assert student_repo.get_student(student.id) is not None


def test_rn013_guardian_graduation_change_racing_with_attendance(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Attendance confirmed between the lock check and the guardian's write."""
    exam_event = _event()
    student = _student()
    original_check = exam_repo.student_has_exams
    raced: list[int] = []

    def check_then_concurrent_attendance(student_id: str) -> bool:
        has_exams = original_check(student_id)
        if not raced:
            raced.append(_confirm(exam_event.id, student_id)["statusCode"])
        return has_exams

    monkeypatch.setattr(exam_repo, "student_has_exams", check_then_concurrent_attendance)
    change = _student_payload(student, stripes=1)

    response = student_handlers.update_student(
        api_event(GUARDIAN, path={"id": student.id}, body=change), None
    )

    assert raced == [201], "a presença concorrente deveria ter sido gravada"
    assert response["statusCode"] == 403, response["body"]
    assert response_json(response)["message"] == LOCKED
    assert student_repo.get_student(student.id).stripes == 0

    # Resending the same graduation stays allowed for the guardian.
    same = _student_payload(student, full_name="Ana Maria")
    response = student_handlers.update_student(
        api_event(GUARDIAN, path={"id": student.id}, body=same), None
    )
    assert response["statusCode"] == 200, response["body"]

    # Examiners still change the graduation after the first exam, once it is
    # decided (while it is in progress nobody does, RN005).
    _decide_failed(exam_event.id, student.id)
    response = student_handlers.update_student(
        api_event(EXAMINER, path={"id": student.id}, body=change), None
    )
    assert response["statusCode"] == 200, response["body"]
    assert student_repo.get_student(student.id).stripes == 1
    assert _count(STUDENTS_TABLE_ENV, student.id) == 1


def test_rn013_guardian_graduation_change_without_exams_is_allowed(seeded: None) -> None:
    student = _student()
    response = student_handlers.update_student(
        api_event(
            GUARDIAN,
            path={"id": student.id},
            body=_student_payload(student, current_belt_id=belt_id("Cinza/Azul")),
        ),
        None,
    )
    assert response["statusCode"] == 200, response["body"]
    assert student_repo.get_student(student.id).current_belt_id == belt_id("Cinza/Azul")


def test_save_of_deleted_event_or_student_is_not_found(seeded: None) -> None:
    exam_event = _event()
    student = _student()
    event_repo.delete_event(exam_event.id)
    student_repo.delete_student(student.id)
    with pytest.raises(NotFoundError, match="Evento não encontrado"):
        event_repo.save_event(exam_event)
    with pytest.raises(NotFoundError, match="Aluno não encontrado"):
        student_repo.save_student(student)
    assert event_repo.get_event(exam_event.id) is None
    assert student_repo.get_student(student.id) is None
