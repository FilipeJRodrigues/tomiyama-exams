"""Persistence of exams in the ``Exams`` table.

Keys: PK ``event_id``, SK ``student_id`` (one exam per event and student);
GSI ``by_student`` (PK ``student_id``, SK ``event_id``) for a student's history.

Two transactions write here: the attendance (``create_exam``, RN005) and the
sensei's decision (``decide_exam``, RN008–RN010).
"""

import logging
import random
import time
from datetime import date
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from domain.decisions import (
    MSG_DECISION_TRY_AGAIN,
    MSG_GRADUATION_CHANGED,
    MSG_NO_SENSEI,
    MSG_ONLY_SENSEI,
)
from domain.eligibility import ExamKind
from domain.errors import (
    MSG_SERVICE_BUSY,
    ConflictError,
    DomainError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from domain.events import EventStatus
from domain.exams import (
    MSG_ALREADY_CONFIRMED,
    MSG_EVENT_CLOSED,
    MSG_EVENT_NOT_FOUND,
    MSG_EXAM_DECIDED,
    MSG_EXAM_NOT_FOUND,
    MSG_STUDENT_CHANGED,
    MSG_STUDENT_INACTIVE,
    MSG_STUDENT_NOT_FOUND,
    MSG_TRY_AGAIN,
    Exam,
    ExamStatus,
    Graduation,
)
from domain.settings import SETTINGS_ID
from domain.students import Student
from repository.tables import (
    EVENTS_TABLE_ENV,
    EXAM_COUNT,
    EXAMS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    THROTTLING_ERRORS,
    get_item_or_busy,
    paginate,
    table,
)

logger = logging.getLogger(__name__)

BY_STUDENT_INDEX = "by_student"

_MAX_ATTEMPTS = 4
_BACKOFF_SECONDS = 0.05

# Order of the items in the attendance transaction (CancellationReasons follow it).
_PUT_EXAM, _UPDATE_EVENT, _UPDATE_STUDENT = range(3)
# Order of the items in the decision transaction.
_DECIDE_EXAM, _CHECK_STUDENT, _CHECK_SENSEI = range(3)

_CANCELLED = "TransactionCanceledException"
_CONDITION_FAILED = "ConditionalCheckFailed"
_CONFLICT = "TransactionConflict"
# Cancellation reasons of an item throttled inside the transaction.
_THROTTLED_REASONS = frozenset({"ThrottlingError", "ProvisionedThroughputExceeded"})


def _to_item(exam: Exam) -> dict[str, Any]:
    return {key: value for key, value in exam.to_dict().items() if value is not None}


def _source(item: dict[str, Any]) -> Graduation | None:
    """Graduation of the attendance; None for exams confirmed before it was stored."""
    if "source_belt_id" not in item:
        return None
    return Graduation(
        belt_id=item["source_belt_id"],
        belt_since=date.fromisoformat(item["source_belt_since"]),
        stripes=int(item["source_stripes"]),
    )


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
        source=_source(item),
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
    """Return the exam of a student in an event, or None.

    Raises:
        ServiceUnavailableError: If the exams table kept throttling (503).
    """
    key = {"event_id": event_id, "student_id": student_id}
    item = get_item_or_busy(table(EXAMS_TABLE_ENV), key)
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


def _graduation_condition(expected: Graduation) -> tuple[str, dict[str, Any]]:
    """Condition that the student still exists with the expected graduation.

    Same serialization as ``repository.students._to_item``.
    """
    condition = (
        "attribute_exists(id) AND current_belt_id = :belt"
        " AND current_belt_since = :since AND stripes = :stripes"
    )
    values = {
        ":belt": expected.belt_id,
        ":since": expected.belt_since.isoformat(),
        ":stripes": expected.stripes,
    }
    return condition, values


def _decision_items(
    decided: Exam, expected: Graduation, approved: Student | None
) -> list[dict[str, Any]]:
    """Return the items of the decision transaction, in ``_DECIDE_EXAM`` order."""
    sets = ["#status = :result", "decided_by_id = :by", "decided_at = :at"]
    exam_values: dict[str, Any] = {
        ":result": decided.status.value,
        ":by": decided.decided_by_id,
        ":at": decided.decided_at,
        ":exam_id": decided.id,
        ":in_progress": ExamStatus.IN_PROGRESS.value,
    }
    if decided.notes is not None:
        sets.append("notes = :notes")
        exam_values[":notes"] = decided.notes
    exam_update = {
        "Update": {
            "TableName": table(EXAMS_TABLE_ENV).name,
            "Key": {"event_id": decided.event_id, "student_id": decided.student_id},
            "UpdateExpression": "SET " + ", ".join(sets),
            "ConditionExpression": "id = :exam_id AND #status = :in_progress",
            "ExpressionAttributeNames": {"#status": "status"},
            "ExpressionAttributeValues": exam_values,
        }
    }
    condition, values = _graduation_condition(expected)
    students_table = table(STUDENTS_TABLE_ENV).name
    key = {"id": decided.student_id}
    if approved is None:
        student_item = {
            "ConditionCheck": {
                "TableName": students_table,
                "Key": key,
                "ConditionExpression": condition,
                "ExpressionAttributeValues": values,
            }
        }
    else:
        # Only the graduation fields: exam_count and the rest are kept.
        student_item = {
            "Update": {
                "TableName": students_table,
                "Key": key,
                "UpdateExpression": (
                    "SET current_belt_id = :new_belt, current_belt_since = :new_since,"
                    " stripes = :new_stripes, updated_at = :updated"
                ),
                "ConditionExpression": condition,
                "ExpressionAttributeValues": values
                | {
                    ":new_belt": approved.current_belt_id,
                    ":new_since": approved.current_belt_since.isoformat(),
                    ":new_stripes": approved.stripes,
                    ":updated": approved.updated_at,
                },
            }
        }
    # The sensei who decides must still be the configured one at write time (RN008).
    sensei_check = {
        "ConditionCheck": {
            "TableName": table(SETTINGS_TABLE_ENV).name,
            "Key": {"id": SETTINGS_ID},
            "ConditionExpression": "#sensei = :sub",
            "ExpressionAttributeNames": {"#sensei": "sensei_user_id"},
            "ExpressionAttributeValues": {":sub": decided.decided_by_id},
        }
    }
    return [exam_update, student_item, sensei_check]


def _decision_error(exam: Exam, reasons: list[str | None]) -> DomainError | None:
    """Translate the failed conditions of the decision transaction.

    The sensei comes first, so whoever is no longer the sensei learns nothing
    about the exam: sensei removed → 409; another sensei → 403 (RN008). Exam
    deleted or replaced → 404; already decided → 409 (RN010). Student deleted
    → 404; graduation changed since the attendance → 409. Returns None when no
    condition failed (e.g. only a transaction conflict).
    """

    def failed(index: int) -> bool:
        return index < len(reasons) and reasons[index] == _CONDITION_FAILED

    if failed(_CHECK_SENSEI):
        # Read the table directly: the settings are read again, never cached.
        item = get_item_or_busy(table(SETTINGS_TABLE_ENV), {"id": SETTINGS_ID})
        if not item or not item.get("sensei_user_id"):
            return ConflictError(MSG_NO_SENSEI)
        return ForbiddenError(MSG_ONLY_SENSEI)

    if failed(_DECIDE_EXAM):
        key = {"event_id": exam.event_id, "student_id": exam.student_id}
        item = get_item_or_busy(table(EXAMS_TABLE_ENV), key)
        if not item or item.get("id") != exam.id:
            return NotFoundError(MSG_EXAM_NOT_FOUND)
        return ConflictError(MSG_EXAM_DECIDED)
    if failed(_CHECK_STUDENT):
        item = get_item_or_busy(table(STUDENTS_TABLE_ENV), {"id": exam.student_id})
        if not item:
            return NotFoundError(MSG_STUDENT_NOT_FOUND)
        return ConflictError(MSG_GRADUATION_CHANGED)
    return None


def _transact_decision(items: list[dict[str, Any]]) -> None:
    table(EXAMS_TABLE_ENV).meta.client.transact_write_items(TransactItems=items)


def decide_exam(decided: Exam, expected: Graduation, approved: Student | None) -> None:
    """Record the sensei's decision and, if approved, the new graduation (RN008–RN010).

    One transaction updates the exam only if it is still the same exam and in
    progress and, at the same instant, checks that the student still has the
    graduation the decision was based on and that the one deciding is still
    the sensei in the settings (RN008). On approval the same transaction
    writes the student's new belt, belt date and stripes (RN009) with
    ``UpdateItem``, keeping ``exam_count`` and every other attribute; on
    failure the student is only checked. The event is not checked: a closed
    event still accepts decisions (RN008a), and an event with exams is never
    deleted. The marking transactions check the same exam status, so a mark
    never lands after the decision (RN010).

    ``TransactionConflict`` and throttling inside the transaction are retried
    with a short backoff.

    Args:
        decided: The exam with the decision applied (``domain.decisions.decide``).
        expected: Graduation the student must still have.
        approved: The student after approval, or None when the exam failed.

    Raises:
        ForbiddenError: If the sensei was replaced by another user.
        NotFoundError: If the exam or the student was deleted or replaced.
        ConflictError: If the sensei was removed, the exam was already
            decided, the graduation changed or the transaction kept conflicting
            after every retry.
        ServiceUnavailableError: If it kept being throttled.
    """
    items = _decision_items(decided, expected, approved)
    last_error: DomainError = ConflictError(MSG_DECISION_TRY_AGAIN)
    for attempt in range(_MAX_ATTEMPTS):
        try:
            _transact_decision(items)
            return
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code in THROTTLING_ERRORS:
                # Botocore already retried the whole request.
                logger.warning("Decision transaction throttled after botocore retries: %s", code)
                raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc
            if code != _CANCELLED:
                raise
            reasons = [reason.get("Code") for reason in exc.response.get("CancellationReasons", [])]
            error = _decision_error(decided, reasons)
            if error is not None:
                raise error from exc
            if _THROTTLED_REASONS.intersection(reasons):
                last_error = ServiceUnavailableError(MSG_SERVICE_BUSY)
            elif _CONFLICT in reasons:
                last_error = ConflictError(MSG_DECISION_TRY_AGAIN)
            else:
                raise
            if attempt + 1 < _MAX_ATTEMPTS:
                logger.info("Decision transaction retry %d after %s", attempt + 1, reasons)
                time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))
    raise last_error
