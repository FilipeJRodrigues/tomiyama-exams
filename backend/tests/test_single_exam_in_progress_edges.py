"""Single exam in progress (RN005, decision of 2026-11-02): extra edges.

The marker never reaches the responses, an inactive student with an exam in
progress is still decided and freed, and field validation (400) comes before
the graduation lock (409).
"""

from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, belt_id, make_student

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EXAM_IN_PROGRESS, STUDENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
TODAY = date(2026, 11, 1)
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


@pytest.fixture
def setup(seeded: None) -> tuple[ExamEvent, ExamEvent, Student]:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    a = ExamEvent("event-a", "A", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
    b = ExamEvent("event-b", "B", date(2027, 4, 20), EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(a)
    event_repo.create_event(b)
    s = make_student()
    student_repo.create_student(s)
    return a, b, s


def _confirm(ev: ExamEvent, s: Student) -> dict[str, Any]:
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": ev.id}, body={"student_id": s.id}), None
    )


def _decide(ev: ExamEvent, s: Student, result: str) -> dict[str, Any]:
    return exam_handlers.decide_exam(
        api_event(SENSEI, path={"id": ev.id, "student_id": s.id}, body={"result": result}), None
    )


def _body(s: Student, **changes: Any) -> dict[str, Any]:
    return {
        "full_name": s.full_name,
        "birth_date": s.birth_date.isoformat(),
        "current_belt_id": s.current_belt_id,
        "current_belt_since": s.current_belt_since.isoformat(),
        "stripes": s.stripes,
        "federation_id": s.federation_id,
        "active": s.active,
        **changes,
    }


def _item(sid: str) -> dict[str, Any]:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": sid})["Item"]


def test_rn005_marker_is_not_in_the_responses(setup: tuple[ExamEvent, ExamEvent, Student]) -> None:
    a, _, s = setup
    assert _confirm(a, s)["statusCode"] == 201
    r = student_handlers.get_student(api_event(EXAMINER, path={"id": s.id}), None)
    assert EXAM_IN_PROGRESS not in r["body"]
    r = student_handlers.list_students(api_event(EXAMINER), None)
    assert EXAM_IN_PROGRESS not in r["body"]
    r = student_handlers.update_student(
        api_event(EXAMINER, path={"id": s.id}, body=_body(s, full_name="X Y")), None
    )
    assert r["statusCode"] == 200
    assert EXAM_IN_PROGRESS not in r["body"]
    assert _item(s.id)[EXAM_IN_PROGRESS]


def test_rn005_inactive_student_with_exam_in_progress_is_decided_and_freed(
    setup: tuple[ExamEvent, ExamEvent, Student],
) -> None:
    a, _, s = setup
    assert _confirm(a, s)["statusCode"] == 201
    for user in (EXAMINER, GUARDIAN):
        r = student_handlers.update_student(
            api_event(user, path={"id": s.id}, body=_body(s, active=False)), None
        )
        assert r["statusCode"] == 200, r["body"]
    # Inactive student with an exam in progress can still be decided.
    r = _decide(a, s, "APPROVED")
    assert r["statusCode"] == 200, r["body"]
    assert EXAM_IN_PROGRESS not in _item(s.id)


def test_rn005_invalid_belt_is_400_before_the_lock(
    setup: tuple[ExamEvent, ExamEvent, Student],
) -> None:
    a, _, s = setup
    assert _confirm(a, s)["statusCode"] == 201
    r = student_handlers.update_student(
        api_event(EXAMINER, path={"id": s.id}, body=_body(s, current_belt_id="nope")), None
    )
    assert r["statusCode"] == 400, r["body"]
    r = student_handlers.update_student(
        api_event(EXAMINER, path={"id": s.id}, body=_body(s, current_belt_id=belt_id("Amarela"))),
        None,
    )
    assert r["statusCode"] == 409, r["body"]
