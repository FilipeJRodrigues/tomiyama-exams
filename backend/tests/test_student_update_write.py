"""PUT /students/{id}: fields written, condition and answer (RN005, RN009, RN013)."""

from datetime import date
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    GUARDIAN,
    OTHER_GUARDIAN,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain.events import EventStatus, ExamEvent
from domain.students import MSG_GRADUATION_IN_PROGRESS, MSG_GRADUATION_LOCKED, Student
from domain.users import User
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import students as student_repo
from repository.tables import EXAM_IN_PROGRESS, STUDENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"


def _body(student: Student, **changes: Any) -> dict[str, Any]:
    body = {
        "full_name": student.full_name,
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "federation_id": student.federation_id,
        "active": student.active,
    }
    return {**body, **changes}


def _stored(student_id: str) -> dict[str, Any] | None:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id}).get("Item")


def _put(user: User, student: Student, **changes: Any) -> dict[str, Any]:
    return student_handlers.update_student(
        api_event(user, path={"id": student.id}, body=_body(student, **changes)), None
    )


@pytest.fixture
def in_progress(seeded: None) -> Student:
    event = ExamEvent("event-a", "Exame A", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(event)
    student = make_student()
    student_repo.create_student(student)
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event.id}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    return student


class _Spy:
    def __init__(self, real: Any, calls: list[dict[str, Any]]) -> None:
        self._real = real
        self._calls = calls

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def update_item(self, **kwargs: Any) -> Any:
        self._calls.append(kwargs)
        return self._real.update_item(**kwargs)


def _spy(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    real = student_repo.table
    monkeypatch.setattr(
        student_repo,
        "table",
        lambda env: _Spy(real(env), calls) if env == STUDENTS_TABLE_ENV else real(env),
    )
    return calls


@pytest.mark.parametrize("change_graduation", [False, True])
def test_rn013_deleted_between_read_and_write_is_404_and_creates_nothing(
    seeded: None, monkeypatch: pytest.MonkeyPatch, change_graduation: bool
) -> None:
    student = make_student()
    student_repo.create_student(student)
    real_check = student_repo.has_exam_in_progress

    def delete_in_between(student_id: str) -> bool:
        seen = real_check(student_id)
        table(STUDENTS_TABLE_ENV).delete_item(Key={"id": student_id})
        return seen

    monkeypatch.setattr(student_repo, "has_exam_in_progress", delete_in_between)
    changes: dict[str, Any] = {"full_name": "Ana Maria"}
    if change_graduation:
        changes["stripes"] = 1
    response = _put(EXAMINER, student, **changes)
    assert response["statusCode"] == 404, response["body"]
    assert _stored(student.id) is None


def test_rn009_update_item_arguments_keep_graduation(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    calls = _spy(monkeypatch)
    response = _put(EXAMINER, student, full_name="Ana Maria")
    assert response["statusCode"] == 200
    (call,) = calls
    assert call["ReturnValues"] == "ALL_NEW"
    assert call["ConditionExpression"] == "attribute_exists(id)"
    names = set(call["ExpressionAttributeNames"].values())
    assert not names & {"current_belt_id", "current_belt_since", "stripes"}
    assert EXAM_IN_PROGRESS not in names and "exam_count" not in names


def test_rn005_update_item_arguments_change_graduation(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    calls = _spy(monkeypatch)
    response = _put(GUARDIAN, student, full_name="Ana Maria", stripes=2)
    assert response["statusCode"] == 200, response["body"]
    (call,) = calls
    assert call["ReturnValues"] == "ALL_NEW"
    assert call["ConditionExpression"].startswith("attribute_exists(id) AND (")
    assert f"attribute_not_exists({EXAM_IN_PROGRESS})" in call["ConditionExpression"]
    names = set(call["ExpressionAttributeNames"].values())
    assert {"current_belt_id", "current_belt_since", "stripes"} <= names
    stored = _stored(student.id)
    assert stored is not None
    assert stored["full_name"] == "Ana Maria" and int(stored["stripes"]) == 2
    body = response_json(response)
    assert body["full_name"] == "Ana Maria" and body["stripes"] == 2


def test_rn013_only_graduation_changes(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)
    response = _put(EXAMINER, student, current_belt_id=belt_id("Cinza/Azul"), stripes=0)
    assert response["statusCode"] == 200, response["body"]
    stored = _stored(student.id)
    assert stored is not None and stored["current_belt_id"] == belt_id("Cinza/Azul")
    assert stored["full_name"] == student.full_name


def test_rn005_name_edit_during_exam_hides_marker_and_keeps_it(in_progress: Student) -> None:
    before = _stored(in_progress.id)
    assert before is not None and before.get(EXAM_IN_PROGRESS)
    for user in (EXAMINER, GUARDIAN):
        response = _put(user, in_progress, full_name="Ana Maria")
        assert response["statusCode"] == 200, response["body"]
        body = response_json(response)
        assert EXAM_IN_PROGRESS not in body and "exam_count" not in body
    after = _stored(in_progress.id)
    assert after is not None
    assert after[EXAM_IN_PROGRESS] == before[EXAM_IN_PROGRESS]
    assert after["exam_count"] == before["exam_count"]
    assert after["full_name"] == "Ana Maria"


def test_rn005_graduation_change_during_exam(in_progress: Student) -> None:
    before = _stored(in_progress.id)
    response = _put(EXAMINER, in_progress, full_name="X", stripes=1)
    assert response["statusCode"] == 409
    assert response_json(response)["message"] == MSG_GRADUATION_IN_PROGRESS
    response = _put(GUARDIAN, in_progress, full_name="X", stripes=1)
    assert response["statusCode"] == 403
    assert response_json(response)["message"] == MSG_GRADUATION_LOCKED
    assert _stored(in_progress.id) == before


def test_rn013_inactive_student_edits(seeded: None) -> None:
    student = make_student(active=False)
    student_repo.create_student(student)
    response = _put(GUARDIAN, student, full_name="Ana Maria")
    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["active"] is False
    response = _put(GUARDIAN, student, active=True)
    assert response["statusCode"] == 200, response["body"]
    stored = _stored(student.id)
    assert stored is not None and stored["active"] is True
    response = _put(EXAMINER, student, active=False, stripes=1)
    assert response["statusCode"] == 200, response["body"]
    stored = _stored(student.id)
    assert stored is not None and stored["active"] is False and int(stored["stripes"]) == 1


def test_rn005_inactive_student_with_exam_in_progress(in_progress: Student) -> None:
    response = _put(EXAMINER, in_progress, active=False)
    assert response["statusCode"] == 200, response["body"]
    response = _put(EXAMINER, in_progress, active=False, stripes=1)
    assert response["statusCode"] == 409


def test_rn013_federation_id_removed_without_graduation(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)
    assert _put(EXAMINER, student, federation_id="FPJ-1")["statusCode"] == 200
    stored = _stored(student.id)
    assert stored is not None and stored["federation_id"] == "FPJ-1"
    response = _put(EXAMINER, student, federation_id=None)
    assert response["statusCode"] == 200, response["body"]
    stored = _stored(student.id)
    assert stored is not None and "federation_id" not in stored
    assert response_json(response)["federation_id"] is None


def test_rn013_other_guardian_gets_404(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)
    before = _stored(student.id)
    response = _put(OTHER_GUARDIAN, student, full_name="Hack")
    assert response["statusCode"] == 404
    assert _stored(student.id) == before
