"""Graduation locked while an exam is in progress (RN005, decision of 2026-11-02).

While the student carries the ``exam_in_progress_id`` marker, ``PUT
/students/{id}`` refuses a change of belt, belt date or stripes with 409, for
examiners and guardians, and writes nothing. For a guardian the RN013 lock
(403) comes first. The other fields stay editable, resending the same
graduation is accepted, and the decision frees the graduation again. The
condition is in the ``UpdateItem``, so an attendance confirmed between the
handler's check and the write still blocks the change.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, belt_id, make_student, response_json

from domain import dates
from domain.belts import SEED_BELTS
from domain.errors import ConflictError, ForbiddenError, NotFoundError
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam
from domain.settings import AcademySettings
from domain.students import Student, update_student
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EXAM_IN_PROGRESS, STUDENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
TODAY = date(2026, 11, 1)
IN_PROGRESS = "Não é possível alterar a graduação com exame em andamento. Decida o exame primeiro."
LOCKED = "Somente examinadores alteram a graduação após o primeiro exame"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
BELTS_BY_ID = {belt.id: belt for belt in SEED_BELTS}

# Each graduation field changed on its own.
GRADUATION_CHANGES = [
    {"current_belt_id": belt_id("Branca/Cinza")},
    {"current_belt_since": "2026-03-01"},
    {"stripes": 1},
]
# The other fields, with the graduation resent unchanged.
OTHER_CHANGES = [
    {"full_name": "Ana Maria"},
    {"birth_date": "2018-05-11"},
    {"federation_id": "SP-123"},
    {"active": False},
    {},
]


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


@pytest.fixture
def exam_event(seeded: None) -> ExamEvent:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    created = ExamEvent("event-a", "Exame A", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(created)
    return created


@pytest.fixture
def student(seeded: None) -> Student:
    created = make_student()
    student_repo.create_student(created)
    return created


def _body(student: Student, **changes: Any) -> dict[str, Any]:
    return {
        "full_name": student.full_name,
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "federation_id": student.federation_id,
        "active": student.active,
        **changes,
    }


def _put(user: User, student: Student, **changes: Any) -> dict[str, Any]:
    return student_handlers.update_student(
        api_event(user, path={"id": student.id}, body=_body(student, **changes)), None
    )


def _confirm(exam_event: ExamEvent, student: Student) -> Exam:
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    stored = exam_repo.get_exam(exam_event.id, student.id)
    assert stored is not None
    return stored


def _stored(student_id: str) -> dict[str, Any]:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id})["Item"]


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response) == {"message": message}


@pytest.mark.parametrize("change", GRADUATION_CHANGES)
def test_rn005_examiner_cannot_change_graduation_with_exam_in_progress(
    exam_event: ExamEvent, student: Student, change: dict[str, Any]
) -> None:
    _confirm(exam_event, student)
    before = _stored(student.id)

    _assert_rejected(_put(EXAMINER, student, full_name="Ana Maria", **change), 409, IN_PROGRESS)

    # Nothing is written, not even the other fields of the same request.
    assert _stored(student.id) == before


@pytest.mark.parametrize("change", GRADUATION_CHANGES)
def test_rn005_guardian_change_with_exam_in_progress_gets_the_rn013_403_first(
    exam_event: ExamEvent, student: Student, change: dict[str, Any]
) -> None:
    _confirm(exam_event, student)
    before = _stored(student.id)

    _assert_rejected(_put(GUARDIAN, student, **change), 403, LOCKED)

    assert _stored(student.id) == before


def test_rn005_domain_precedence_and_lock() -> None:
    student = make_student()
    payload = _body(student, stripes=1)
    # A guardian is refused with the permanent 403 before the 409.
    with pytest.raises(ForbiddenError, match=LOCKED):
        update_student(
            student, payload, GUARDIAN, BELTS_BY_ID, True, TODAY, NOW, exam_in_progress=True
        )
    # Even when the exams read is stale (attendance confirmed between the reads):
    # an exam in progress is an exam.
    with pytest.raises(ForbiddenError, match=LOCKED):
        update_student(
            student, payload, GUARDIAN, BELTS_BY_ID, False, TODAY, NOW, exam_in_progress=True
        )
    # The examiner passes the RN013 lock and meets the exam in progress.
    with pytest.raises(ConflictError, match=IN_PROGRESS):
        update_student(
            student, payload, EXAMINER, BELTS_BY_ID, True, TODAY, NOW, exam_in_progress=True
        )
    # Same graduation resent: accepted.
    updated = update_student(
        student,
        _body(student, full_name="Ana Maria"),
        EXAMINER,
        BELTS_BY_ID,
        True,
        TODAY,
        NOW,
        exam_in_progress=True,
    )
    assert updated.full_name == "Ana Maria"


@pytest.mark.parametrize("user", [EXAMINER, GUARDIAN], ids=["examiner", "guardian"])
@pytest.mark.parametrize("change", OTHER_CHANGES)
def test_rn005_other_fields_stay_editable_with_exam_in_progress(
    exam_event: ExamEvent, student: Student, user: User, change: dict[str, Any]
) -> None:
    exam = _confirm(exam_event, student)

    response = _put(user, student, **change)

    assert response["statusCode"] == 200, response["body"]
    stored = _stored(student.id)
    for field, value in change.items():
        assert stored.get(field) == value
    # The graduation and the marker are kept.
    assert stored["current_belt_id"] == student.current_belt_id
    assert stored["current_belt_since"] == student.current_belt_since.isoformat()
    assert stored["stripes"] == student.stripes
    assert stored[EXAM_IN_PROGRESS] == exam.id


@pytest.mark.parametrize("result", ["APPROVED", "FAILED"])
def test_rn005_examiner_changes_graduation_again_after_the_decision(
    exam_event: ExamEvent, student: Student, result: str
) -> None:
    exam = _confirm(exam_event, student)
    decided = exam_handlers.decide_exam(
        api_event(
            SENSEI,
            path={"id": exam.event_id, "student_id": exam.student_id},
            body={"result": result},
        ),
        None,
    )
    assert decided["statusCode"] == 200, decided["body"]
    current = student_repo.get_student(student.id)
    assert current is not None

    response = _put(EXAMINER, current, current_belt_since="2026-10-01")

    assert response["statusCode"] == 200, response["body"]
    assert _stored(student.id)["current_belt_since"] == "2026-10-01"


def test_rn005_attendance_confirmed_during_the_examiner_edit_blocks_the_change(
    exam_event: ExamEvent, student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The handler sees no exam in progress; the attendance lands before the write."""
    real_check = student_repo.has_exam_in_progress

    def confirm_in_between(student_id: str) -> bool:
        seen = real_check(student_id)
        _confirm(exam_event, student)
        return seen

    monkeypatch.setattr(student_repo, "has_exam_in_progress", confirm_in_between)
    monkeypatch.setattr(exam_repo, "student_has_exams", lambda student_id: False)

    response = _put(EXAMINER, student, full_name="Ana Maria", stripes=1)

    _assert_rejected(response, 409, IN_PROGRESS)
    stored = _stored(student.id)
    assert stored["full_name"] == student.full_name
    assert stored["stripes"] == student.stripes
    # The attendance stands, on the graduation it read.
    exam = exam_repo.get_exam(exam_event.id, student.id)
    assert exam is not None
    assert stored[EXAM_IN_PROGRESS] == exam.id
    assert exam.source is not None
    assert exam.source.stripes == student.stripes


def test_rn005_attendance_confirmed_during_the_guardian_edit_keeps_the_403(
    exam_event: ExamEvent, student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_check = student_repo.has_exam_in_progress

    def confirm_in_between(student_id: str) -> bool:
        seen = real_check(student_id)
        _confirm(exam_event, student)
        return seen

    monkeypatch.setattr(student_repo, "has_exam_in_progress", confirm_in_between)
    before_put = _stored(student.id)

    response = _put(GUARDIAN, student, stripes=1)

    _assert_rejected(response, 403, LOCKED)
    stored = _stored(student.id)
    assert stored["stripes"] == before_put["stripes"]


def test_rn005_other_fields_are_saved_when_attendance_lands_during_the_edit(
    exam_event: ExamEvent, student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without a graduation change the write has no marker condition."""
    real_check = student_repo.has_exam_in_progress

    def confirm_in_between(student_id: str) -> bool:
        seen = real_check(student_id)
        _confirm(exam_event, student)
        return seen

    monkeypatch.setattr(student_repo, "has_exam_in_progress", confirm_in_between)

    response = _put(EXAMINER, student, full_name="Ana Maria")

    assert response["statusCode"] == 200, response["body"]
    stored = _stored(student.id)
    assert stored["full_name"] == "Ana Maria"
    assert EXAM_IN_PROGRESS in stored


def test_rn005_repository_marker_condition(exam_event: ExamEvent, student: Student) -> None:
    _confirm(exam_event, student)
    with pytest.raises(ConflictError, match=IN_PROGRESS):
        student_repo.save_student(replace(student, stripes=1), require_no_exam_in_progress=True)
    with pytest.raises(ForbiddenError, match=LOCKED):
        student_repo.save_student(
            replace(student, stripes=1), require_no_exams=True, require_no_exam_in_progress=True
        )
    table(STUDENTS_TABLE_ENV).delete_item(Key={"id": student.id})
    with pytest.raises(NotFoundError):
        student_repo.save_student(replace(student, stripes=1), require_no_exam_in_progress=True)
