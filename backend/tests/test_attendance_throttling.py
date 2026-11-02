"""Throttling of the attendance transaction itself (RN005).

Like the decision, a throttled ``TransactWriteItems`` (after botocore's own
retries) is a 503 at once, and throttled items inside a cancelled transaction
are retried and, if they persist, become a 503. Nothing is written.
"""

from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, make_student, response_json

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.students import Student
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo
from repository.tables import EXAMS_TABLE_ENV, STUDENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)
    monkeypatch.setattr(exam_repo.time, "sleep", lambda seconds: None)


@pytest.fixture
def exam_event(seeded: None) -> ExamEvent:
    created = ExamEvent("event-a", "Exame A", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(created)
    return created


@pytest.fixture
def student(seeded: None) -> Student:
    created = make_student()
    student_repo.create_student(created)
    return created


def _confirm(exam_event: ExamEvent, student: Student) -> dict[str, Any]:
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )


def _assert_nothing_written(student: Student) -> None:
    assert table(EXAMS_TABLE_ENV).scan()["Items"] == []
    assert (
        "exam_in_progress_id"
        not in (table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"])
    )


@pytest.mark.parametrize(
    "code",
    ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"],
)
def test_rn005_throttled_attendance_transaction_is_503(
    exam_event: ExamEvent, student: Student, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    calls: list[int] = []

    def throttled(items: list[dict[str, Any]]) -> None:
        calls.append(1)
        raise ClientError({"Error": {"Code": code, "Message": "x"}}, "TransactWriteItems")

    monkeypatch.setattr(exam_repo, "_transact_create", throttled)

    response = _confirm(exam_event, student)

    assert response["statusCode"] == 503, response["body"]
    assert response_json(response) == {"message": BUSY}
    # Botocore already retried the request: no extra round here.
    assert len(calls) == 1
    _assert_nothing_written(student)


@pytest.mark.parametrize("reason", ["ThrottlingError", "ProvisionedThroughputExceeded"])
def test_rn005_throttled_item_in_attendance_is_retried_then_503(
    exam_event: ExamEvent, student: Student, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    calls: list[int] = []

    def always(items: list[dict[str, Any]]) -> None:
        calls.append(1)
        raise ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "x"},
                "CancellationReasons": [{"Code": "None"}, {"Code": reason}, {"Code": "None"}],
            },
            "TransactWriteItems",
        )

    monkeypatch.setattr(exam_repo, "_transact_create", always)

    response = _confirm(exam_event, student)

    assert response["statusCode"] == 503, response["body"]
    assert response_json(response) == {"message": BUSY}
    assert len(calls) == exam_repo._MAX_ATTEMPTS
    _assert_nothing_written(student)


def test_rn005_throttled_item_in_attendance_passes_on_retry(
    exam_event: ExamEvent, student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = exam_repo._transact_create
    calls: list[int] = []

    def flaky(items: list[dict[str, Any]]) -> None:
        calls.append(1)
        if len(calls) == 1:
            raise ClientError(
                {
                    "Error": {"Code": "TransactionCanceledException", "Message": "x"},
                    "CancellationReasons": [
                        {"Code": "ThrottlingError"},
                        {"Code": "None"},
                        {"Code": "None"},
                    ],
                },
                "TransactWriteItems",
            )
        real(items)

    monkeypatch.setattr(exam_repo, "_transact_create", flaky)

    response = _confirm(exam_event, student)

    assert response["statusCode"] == 201, response["body"]
    assert len(calls) == 2
