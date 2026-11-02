"""PUT /students/{id}: throttling is a 503 and an unchanged graduation is not written.

The reads of the edit (the student and its exam-in-progress marker, RN005) and
the write itself answer 503 when DynamoDB kept throttling after botocore's
retries. An edit that keeps the graduation writes only the other fields and
answers with the student as stored (RN009).
"""

from dataclasses import replace
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, GUARDIAN, api_event, belt_id, make_student, response_json

from domain.errors import MSG_SERVICE_BUSY
from domain.students import Student
from domain.users import User
from handlers import students as student_handlers
from repository import students as student_repo
from repository.tables import STUDENTS_TABLE_ENV, table


def _throttled(operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
        operation,
    )


class _ThrottledTable:
    """The real table, with ``get_item`` (full or projected) or ``update_item`` throttled."""

    def __init__(self, real: Any, target: str) -> None:
        self._real = real
        self._target = target

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def get_item(self, **kwargs: Any) -> Any:
        projected = "ProjectionExpression" in kwargs
        if (self._target == "marker" and projected) or (
            self._target == "student" and not projected
        ):
            raise _throttled("GetItem")
        return self._real.get_item(**kwargs)

    def update_item(self, **kwargs: Any) -> Any:
        if self._target == "write":
            raise _throttled("UpdateItem")
        return self._real.update_item(**kwargs)


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


@pytest.mark.parametrize("target", ["student", "marker", "write"])
@pytest.mark.parametrize("user", [EXAMINER, GUARDIAN], ids=["examiner", "guardian"])
def test_rn005_throttled_student_update_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, target: str, user: User
) -> None:
    student = make_student()
    student_repo.create_student(student)
    before = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]

    real_table = student_repo.table
    monkeypatch.setattr(
        student_repo,
        "table",
        lambda env: (
            _ThrottledTable(real_table(env), target)
            if env == STUDENTS_TABLE_ENV
            else real_table(env)
        ),
    )

    response = student_handlers.update_student(
        api_event(user, path={"id": student.id}, body=_body(student, full_name="Ana Maria")),
        None,
    )
    monkeypatch.undo()

    assert response["statusCode"] == 503, response["body"]
    assert MSG_SERVICE_BUSY in response["body"]
    assert table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"] == before


def test_rn005_throttled_student_read_on_detail_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    real_table = student_repo.table
    monkeypatch.setattr(
        student_repo, "table", lambda env: _ThrottledTable(real_table(env), "student")
    )

    response = student_handlers.get_student(api_event(EXAMINER, path={"id": student.id}), None)

    assert response["statusCode"] == 503, response["body"]


@pytest.mark.parametrize("user", [EXAMINER, GUARDIAN], ids=["examiner", "guardian"])
def test_rn009_edit_keeping_graduation_answers_stored_graduation(
    seeded: None, monkeypatch: pytest.MonkeyPatch, user: User
) -> None:
    student = make_student()
    student_repo.create_student(student)
    # Another writer (e.g. an approval) changes the graduation after the PUT read it.
    real_get = student_repo.get_student

    def read_then_promote(student_id: str) -> Student | None:
        read = real_get(student_id)
        promoted = replace(student, current_belt_id=belt_id("Cinza/Azul"), stripes=0)
        student_repo.save_student(promoted)
        return read

    monkeypatch.setattr(student_repo, "get_student", read_then_promote)

    response = student_handlers.update_student(
        api_event(user, path={"id": student.id}, body=_body(student, full_name="Ana Maria")),
        None,
    )

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["full_name"] == "Ana Maria"
    assert body["current_belt_id"] == belt_id("Cinza/Azul")
    stored = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]
    assert stored["full_name"] == "Ana Maria"
    assert stored["current_belt_id"] == belt_id("Cinza/Azul")


def test_rn009_save_student_without_graduation_keeps_stored_graduation(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)
    stale = replace(student, full_name="Ana Maria", stripes=student.stripes + 1)

    stored = student_repo.save_student(stale, write_graduation=False)

    assert stored.full_name == "Ana Maria"
    assert stored.stripes == student.stripes
    assert student_repo.get_student(student.id) == stored
