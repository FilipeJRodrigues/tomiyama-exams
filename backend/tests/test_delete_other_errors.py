"""Errors other than throttling on the student and event deletes keep their old behavior.

The 503 of issue #18 applies only to ``THROTTLING_ERRORS``: any other
``ClientError`` in the exams query or in the conditional ``DeleteItem`` still
becomes the generic 500, and nothing is deleted. A failed condition is still 409.
"""

from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, make_student, response_json

from domain.students import MSG_STUDENT_HAS_EXAMS
from handlers import events as event_handlers
from handlers import students as student_handlers
from repository import exams as exam_repo
from repository import students as student_repo
from repository.tables import EVENTS_TABLE_ENV, EXAMS_TABLE_ENV, STUDENTS_TABLE_ENV, table

MSG_INTERNAL = "Erro interno. Tente de novo."


class _FailingTable:
    """The real table, with ``operation`` always failing with ``code``."""

    def __init__(self, real: Any, operation: str, code: str) -> None:
        self._real = real
        self._operation = operation
        self._code = code

    def __getattr__(self, name: str) -> Any:
        if name != self._operation:
            return getattr(self._real, name)

        def failing(**kwargs: Any) -> Any:
            raise ClientError({"Error": {"Code": self._code, "Message": "x"}}, name)

        return failing


def _fail(
    monkeypatch: pytest.MonkeyPatch, module: Any, env: str, operation: str, code: str
) -> None:
    real_table = module.table
    monkeypatch.setattr(
        module,
        "table",
        lambda name: (
            _FailingTable(real_table(name), operation, code) if name == env else real_table(name)
        ),
    )


def _student_item(student_id: str) -> dict[str, Any] | None:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id}).get("Item")


@pytest.mark.parametrize(
    ("module", "env", "operation"),
    [
        (exam_repo, EXAMS_TABLE_ENV, "query"),
        (student_repo, STUDENTS_TABLE_ENV, "delete_item"),
    ],
    ids=["student_has_exams", "delete_item"],
)
def test_rn018_delete_student_other_error_is_500_and_keeps_student(
    seeded: None, monkeypatch: pytest.MonkeyPatch, module: Any, env: str, operation: str
) -> None:
    student = make_student()
    student_repo.create_student(student)
    _fail(monkeypatch, module, env, operation, "ValidationException")

    response = student_handlers.delete_student(api_event(EXAMINER, path={"id": student.id}), None)

    assert response["statusCode"] == 500
    assert response_json(response)["message"] == MSG_INTERNAL
    assert _student_item(student.id) is not None


def test_rn018_delete_student_failed_condition_is_still_409(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = make_student()
    student_repo.create_student(student)
    _fail(
        monkeypatch,
        student_repo,
        STUDENTS_TABLE_ENV,
        "delete_item",
        "ConditionalCheckFailedException",
    )

    response = student_handlers.delete_student(api_event(EXAMINER, path={"id": student.id}), None)

    assert response["statusCode"] == 409
    assert response_json(response)["message"] == MSG_STUDENT_HAS_EXAMS
    assert _student_item(student.id) is not None


def test_rn016_delete_event_other_error_is_500_and_keeps_event(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = event_handlers.create_event(
        api_event(EXAMINER, body={"name": "Exame março/2027", "exam_date": "2027-03-20"}), None
    )
    event_id = response_json(created)["id"]
    _fail(monkeypatch, exam_repo, EXAMS_TABLE_ENV, "query", "ValidationException")

    response = event_handlers.delete_event(api_event(EXAMINER, path={"id": event_id}), None)

    assert response["statusCode"] == 500
    assert response_json(response)["message"] == MSG_INTERNAL
    assert table(EVENTS_TABLE_ENV).get_item(Key={"id": event_id}).get("Item") is not None
