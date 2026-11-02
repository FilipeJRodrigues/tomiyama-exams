"""PUT /students/{id}: edges of the optimistic lock on the graduation (RN005, RN009, RN013).

Covers the expression sent to DynamoDB (every name and value is used, the
compared values have the stored types), the guardian before the first exam,
``federation_id`` null, two examiner PUTs racing, and races right before the
write (attendance, approval, delete).
"""

import re
from collections.abc import Callable
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    GUARDIAN,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.students import (
    MSG_GRADUATION_IN_PROGRESS,
    MSG_GRADUATION_LOCKED,
    MSG_STUDENT_CHANGED,
    MSG_STUDENT_NOT_FOUND,
    Student,
)
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import STUDENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
TODAY = date(2026, 11, 1)
EVENT_DATE = date(2027, 3, 20)
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


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
    return body | changes


def _stored(student_id: str) -> dict[str, Any]:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id})["Item"]


def _put(user: User, student: Student, **changes: Any) -> dict[str, Any]:
    return student_handlers.update_student(
        api_event(user, path={"id": student.id}, body=_body(student, **changes)), None
    )


def _before_write(monkeypatch: pytest.MonkeyPatch, action: Callable[[], None]) -> None:
    """Run ``action`` once, after every read of the PUT and right before its write."""
    real_save = student_repo.save_student
    done = {"ran": False}

    def save_after_action(*args: Any, **kwargs: Any) -> Student:
        if not done["ran"]:
            done["ran"] = True
            action()
        return real_save(*args, **kwargs)

    monkeypatch.setattr(student_repo, "save_student", save_after_action)


def _spy_update_item(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    students_table = table(STUDENTS_TABLE_ENV)
    real_update = students_table.update_item

    def spy(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return real_update(**kwargs)

    monkeypatch.setattr(students_table, "update_item", spy)
    monkeypatch.setattr(student_repo, "table", lambda env: students_table)
    return calls


def _assert_every_placeholder_used(arguments: dict[str, Any]) -> None:
    expressions = arguments["UpdateExpression"] + " " + arguments.get("ConditionExpression", "")
    used = set(re.findall(r"[#:]\w+", expressions))
    assert set(arguments["ExpressionAttributeNames"]) <= used
    assert set(arguments.get("ExpressionAttributeValues", {})) <= used
    assert used <= set(arguments["ExpressionAttributeNames"]) | set(
        arguments.get("ExpressionAttributeValues", {})
    )


@pytest.fixture
def sensei(seeded: None) -> None:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    event_repo.create_event(ExamEvent("event-a", "Exame A", EVENT_DATE, EventStatus.OPEN, NOW, NOW))


def _confirm(student: Student) -> None:
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": "event-a"}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]


def _approve(student: Student) -> None:
    response = exam_handlers.decide_exam(
        api_event(
            SENSEI, path={"id": "event-a", "student_id": student.id}, body={"result": "APPROVED"}
        ),
        None,
    )
    assert response["statusCode"] == 200, response["body"]


# --- Expression sent to DynamoDB -------------------------------------------------


@pytest.mark.parametrize("user", [EXAMINER, GUARDIAN], ids=["examiner", "guardian"])
@pytest.mark.parametrize("federation_id", [None, "SP-123"], ids=["no-federation", "federation"])
def test_rn009_graduation_edit_uses_every_placeholder_and_stored_types(
    seeded: None, monkeypatch: pytest.MonkeyPatch, user: User, federation_id: str | None
) -> None:
    student = replace(make_student(), federation_id="OLD-1")
    student_repo.create_student(student)
    calls = _spy_update_item(monkeypatch)

    response = _put(
        user,
        student,
        stripes=2,
        current_belt_since="2026-04-30",
        federation_id=federation_id,
    )

    assert response["statusCode"] == 200, response["body"]
    assert len(calls) == 1
    arguments = calls[0]
    _assert_every_placeholder_used(arguments)
    names = arguments["ExpressionAttributeNames"]
    values = arguments["ExpressionAttributeValues"]
    compared = {
        names[name]: values[value]
        for name, value in re.findall(r"(#g\d+) = (:g\d+)", arguments["ConditionExpression"])
    }
    # The lock compares with the graduation read, serialized as stored.
    assert compared == {
        "current_belt_id": student.current_belt_id,
        "current_belt_since": "2026-03-14",
        "stripes": 0,
    }
    assert isinstance(compared["stripes"], int)
    stored = _stored(student.id)
    assert int(stored["stripes"]) == 2
    assert stored["current_belt_since"] == "2026-04-30"
    if federation_id is None:
        assert "federation_id" not in stored
        assert response_json(response)["federation_id"] is None
    else:
        assert stored["federation_id"] == federation_id


def test_rn009_edit_keeping_graduation_sends_no_lock(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    calls = _spy_update_item(monkeypatch)

    response = _put(EXAMINER, student, full_name="Ana Clara", federation_id=None)

    assert response["statusCode"] == 200, response["body"]
    _assert_every_placeholder_used(calls[0])
    assert "#g" not in calls[0]["ConditionExpression"]


# --- Guardian before the first exam ----------------------------------------------


def test_rn013_guardian_changes_graduation_before_first_exam(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)

    response = _put(GUARDIAN, student, current_belt_id=belt_id("Azul"), stripes=1)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["current_belt_id"] == belt_id("Azul")
    assert body["stripes"] == 1
    stored = _stored(student.id)
    assert stored["current_belt_id"] == belt_id("Azul")
    assert int(stored["stripes"]) == 1


def test_rn009_guardian_graduation_edit_over_concurrent_edit_is_409(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    _before_write(
        monkeypatch,
        lambda: student_repo.save_student(replace(student, stripes=3, full_name="Outro")),
    )

    response = _put(GUARDIAN, student, stripes=1)

    assert response["statusCode"] == 409, response["body"]
    assert response_json(response)["message"] == MSG_STUDENT_CHANGED
    stored = _stored(student.id)
    assert int(stored["stripes"]) == 3
    assert stored["full_name"] == "Outro"


def test_rn013_guardian_graduation_edit_with_attendance_before_write_is_403(
    sensei: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    _before_write(monkeypatch, lambda: _confirm(student))

    response = _put(GUARDIAN, student, stripes=1)

    assert response["statusCode"] == 403, response["body"]
    assert response_json(response)["message"] == MSG_GRADUATION_LOCKED
    assert int(_stored(student.id)["stripes"]) == 0


def test_rn013_guardian_graduation_edit_with_approval_before_write_is_403(
    sensei: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)

    def attend_and_approve() -> None:
        _confirm(student)
        _approve(student)

    _before_write(monkeypatch, attend_and_approve)

    response = _put(GUARDIAN, student, stripes=1)

    assert response["statusCode"] == 403, response["body"]
    stored = _stored(student.id)
    assert stored["current_belt_since"] == EVENT_DATE.isoformat()  # approval kept


# --- Examiner, races right before the write --------------------------------------


def test_rn005_examiner_graduation_edit_with_attendance_before_write_is_409(
    sensei: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    _before_write(monkeypatch, lambda: _confirm(student))

    response = _put(EXAMINER, student, stripes=1)

    assert response["statusCode"] == 409, response["body"]
    assert response_json(response)["message"] == MSG_GRADUATION_IN_PROGRESS
    assert int(_stored(student.id)["stripes"]) == 0


def test_rn009_examiner_graduation_edit_with_approval_before_write_is_409(
    sensei: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)

    def attend_and_approve() -> None:
        _confirm(student)
        _approve(student)

    _before_write(monkeypatch, attend_and_approve)

    response = _put(EXAMINER, student, stripes=1, full_name="Ana Clara")

    assert response["statusCode"] == 409, response["body"]
    assert response_json(response)["message"] == MSG_STUDENT_CHANGED
    stored = _stored(student.id)
    assert stored["current_belt_since"] == EVENT_DATE.isoformat()
    assert stored["current_belt_id"] != student.current_belt_id
    assert stored["full_name"] == "Ana"


def test_rn009_examiner_graduation_edit_with_delete_before_write_is_404(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    _before_write(monkeypatch, lambda: student_repo.delete_student(student.id))

    response = _put(EXAMINER, student, stripes=1)

    assert response["statusCode"] == 404, response["body"]
    assert response_json(response)["message"] == MSG_STUDENT_NOT_FOUND
    assert "Item" not in table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})


# --- Two examiner PUTs racing ----------------------------------------------------


@pytest.mark.parametrize(
    "first, second, status",
    [
        ({"stripes": 1}, {"stripes": 2}, 409),
        ({"stripes": 1}, {"stripes": 1}, 409),
        ({"stripes": 1}, {"full_name": "Ana Clara"}, 200),
        ({"full_name": "Outro"}, {"stripes": 2}, 200),
    ],
    ids=["both-change", "same-change", "second-keeps", "first-keeps"],
)
def test_rn009_two_examiner_puts_racing(
    seeded: None,
    monkeypatch: pytest.MonkeyPatch,
    first: dict[str, Any],
    second: dict[str, Any],
    status: int,
) -> None:
    student = make_student()
    student_repo.create_student(student)
    first_responses: list[dict[str, Any]] = []
    # The second PUT has read the student; the first one runs whole before it writes.
    _before_write(monkeypatch, lambda: first_responses.append(_put(EXAMINER, student, **first)))

    response = _put(EXAMINER, student, **second)

    assert first_responses[0]["statusCode"] == 200, first_responses[0]["body"]
    assert response["statusCode"] == status, response["body"]
    stored = _stored(student.id)
    if status == 409:
        assert response_json(response)["message"] == MSG_STUDENT_CHANGED
        assert int(stored["stripes"]) == first["stripes"]
    else:
        # Both edits stay; the graduation is never reverted to the one read.
        expected_stripes = second.get("stripes", first.get("stripes", 0))
        assert int(stored["stripes"]) == expected_stripes
        assert response_json(response)["stripes"] == expected_stripes
