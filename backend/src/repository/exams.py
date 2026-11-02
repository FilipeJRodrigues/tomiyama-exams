"""Persistence of exams in the ``Exams`` table.

Keys: PK ``event_id``, SK ``student_id`` (one exam per event and student);
GSI ``by_student`` (PK ``student_id``, SK ``event_id``) for a student's history.
"""

import logging
import random
import time
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from domain.eligibility import ExamKind
from domain.errors import ConflictError, DomainError, NotFoundError, ValidationError
from domain.events import EventStatus
from domain.exams import (
    MSG_ALREADY_CONFIRMED,
    MSG_EVENT_CLOSED,
    MSG_EVENT_NOT_FOUND,
    MSG_STUDENT_CHANGED,
    MSG_STUDENT_INACTIVE,
    MSG_STUDENT_NOT_FOUND,
    MSG_TRY_AGAIN,
    Exam,
    ExamStatus,
)
from domain.students import Student
from repository.tables import (
    EVENTS_TABLE_ENV,
    EXAM_COUNT,
    EXAMS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    paginate,
    table,
)

logger = logging.getLogger(__name__)

BY_STUDENT_INDEX = "by_student"

_MAX_ATTEMPTS = 4
_BACKOFF_SECONDS = 0.05

# Order of the items in the attendance transaction (CancellationReasons follow it).
_PUT_EXAM, _UPDATE_EVENT, _UPDATE_STUDENT = range(3)


def _to_item(exam: Exam) -> dict[str, Any]:
    return {key: value for key, value in exam.to_dict().items() if value is not None}


def _from_item(item: dict[str, Any]) -> Exam:
    return Exam(
        id=item["id"],
        event_id=item["event_id"],
        student_id=item["student_id"],
        target_belt_id=item["target_belt_id"],
        kind=ExamKind(item["kind"]),
        status=ExamStatus(item["status"]),
        decided_by_id=item.get("decided_by_id"),
        decided_at=item.get("decided_at"),
        notes=item.get("notes"),
        created_by=item["created_by"],
        created_at=item["created_at"],
    )


def student_has_exams(student_id: str) -> bool:
    """Return whether the student has at least one exam."""
    response = table(EXAMS_TABLE_ENV).query(
        IndexName=BY_STUDENT_INDEX,
        KeyConditionExpression=Key("student_id").eq(student_id),
        Limit=1,
    )
    return bool(response.get("Items"))


def event_has_exams(event_id: str) -> bool:
    """Return whether the event has at least one exam."""
    response = table(EXAMS_TABLE_ENV).query(
        KeyConditionExpression=Key("event_id").eq(event_id),
        Limit=1,
    )
    return bool(response.get("Items"))


def get_exam(event_id: str, student_id: str) -> Exam | None:
    """Return the exam of a student in an event, or None."""
    key = {"event_id": event_id, "student_id": student_id}
    item = table(EXAMS_TABLE_ENV).get_item(Key=key).get("Item")
    return _from_item(item) if item else None


def list_by_event(event_id: str) -> list[Exam]:
    """Return every exam of an event (follows ``LastEvaluatedKey``)."""
    items = paginate(
        table(EXAMS_TABLE_ENV).query,
        KeyConditionExpression=Key("event_id").eq(event_id),
    )
    return [_from_item(item) for item in items]


def create_exam(exam: Exam, student: Student | None = None) -> None:
    """Insert the exam born from an attendance confirmation (RN005).

    One transaction writes the exam only if it does not exist yet, the event
    still exists and is open, and the student still exists and is active. The
    same transaction adds 1 to ``exam_count`` on the event and on the student,
    the counter that the conditional deletes (RN016, RN018) and the guardian's
    graduation lock (RN013) read. This closes the race with a concurrent
    confirmation, closing, deletion or graduation edit. Transactions that touch
    the same items at the same time may be cancelled with
    ``TransactionConflict``; those are retried with a short backoff.

    Args:
        exam: Exam to insert.
        student: Student as read when the target belt and kind were computed.
            When given, the exam is written only if the student's belt, belt
            date and stripes are still those values (RN003, RN004).

    Raises:
        ConflictError: If the attendance was already confirmed, the student's
            graduation changed meanwhile, or the transaction kept conflicting
            after every retry.
        NotFoundError: If the event or the student was deleted meanwhile.
        ValidationError: If the event was closed or the student deactivated meanwhile.
    """
    items = _attendance_items(exam, student)
    for attempt in range(_MAX_ATTEMPTS):
        try:
            _transact_create(items)
            return
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            reasons = [reason.get("Code") for reason in exc.response.get("CancellationReasons", [])]
            error = _condition_error(exam, student, reasons)
            if error is not None:
                raise error from exc
            if "TransactionConflict" not in reasons:
                raise
            logger.info("Attendance transaction conflict (attempt %d)", attempt + 1)
            time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))
    raise ConflictError(MSG_TRY_AGAIN)


def _attendance_items(exam: Exam, student: Student | None) -> list[dict[str, Any]]:
    """Return the items of the attendance transaction, in ``_PUT_EXAM`` order."""
    student_condition = "attribute_exists(id) AND active = :true"
    student_values: dict[str, Any] = {":one": 1, ":true": True}
    if student is not None:
        # Same serialization as repository.students._to_item.
        student_condition += (
            " AND current_belt_id = :belt AND current_belt_since = :since AND stripes = :stripes"
        )
        student_values |= {
            ":belt": student.current_belt_id,
            ":since": student.current_belt_since.isoformat(),
            ":stripes": student.stripes,
        }
    exams_table = table(EXAMS_TABLE_ENV)
    return [
        {
            "Put": {
                "TableName": exams_table.name,
                "Item": _to_item(exam),
                "ConditionExpression": "attribute_not_exists(event_id)",
            }
        },
        {
            "Update": {
                "TableName": table(EVENTS_TABLE_ENV).name,
                "Key": {"id": exam.event_id},
                "UpdateExpression": f"ADD {EXAM_COUNT} :one",
                "ConditionExpression": "attribute_exists(id) AND #status = :open",
                "ExpressionAttributeNames": {"#status": "status"},
                "ExpressionAttributeValues": {":one": 1, ":open": EventStatus.OPEN.value},
            }
        },
        {
            "Update": {
                "TableName": table(STUDENTS_TABLE_ENV).name,
                "Key": {"id": exam.student_id},
                "UpdateExpression": f"ADD {EXAM_COUNT} :one",
                "ConditionExpression": student_condition,
                "ExpressionAttributeValues": student_values,
            }
        },
    ]


def _transact_create(items: list[dict[str, Any]]) -> None:
    table(EXAMS_TABLE_ENV).meta.client.transact_write_items(TransactItems=items)


def _condition_error(
    exam: Exam, student: Student | None, reasons: list[str | None]
) -> DomainError | None:
    """Translate the failed conditions of the attendance transaction.

    ``reasons`` follows the order of the transaction items. A duplicate wins
    over the other reasons; for the event and the student the item is read
    again to tell "deleted" (404) from "closed"/"inactive" (400) and, for the
    student, from "graduation changed" (409). Returns None when no condition
    failed (e.g. only a transaction conflict).
    """

    def failed(index: int) -> bool:
        return index < len(reasons) and reasons[index] == "ConditionalCheckFailed"

    if failed(_PUT_EXAM):
        return ConflictError(MSG_ALREADY_CONFIRMED)
    if failed(_UPDATE_EVENT):
        item = table(EVENTS_TABLE_ENV).get_item(Key={"id": exam.event_id}).get("Item")
        return ValidationError(MSG_EVENT_CLOSED) if item else NotFoundError(MSG_EVENT_NOT_FOUND)
    if failed(_UPDATE_STUDENT):
        item = table(STUDENTS_TABLE_ENV).get_item(Key={"id": exam.student_id}).get("Item")
        if not item:
            return NotFoundError(MSG_STUDENT_NOT_FOUND)
        if not item.get("active", True) or student is None:
            return ValidationError(MSG_STUDENT_INACTIVE)
        return ConflictError(MSG_STUDENT_CHANGED)
    return None
