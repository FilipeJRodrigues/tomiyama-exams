"""Persistence of exams in the ``Exams`` table.

Keys: PK ``event_id``, SK ``student_id`` (one exam per event and student);
GSI ``by_student`` (PK ``student_id``, SK ``event_id``) for a student's history.

Two transactions write here: the attendance (``create_exam``, RN005) and the
sensei's decision (``decide_exam``, RN008–RN010). Together they keep at most
one exam in progress per student through the ``exam_in_progress_id`` marker on
the student (RN005).

Every read by key here is strongly consistent (``ConsistentRead=True``): the
exam read by the handlers (``get_exam``) and the re-reads that pick the error
of a refused transaction. An eventually consistent read may return, for about
a second after a write, the item from before it (or none right after it was
created), which answered a false 404, or the wrong error, right after the
attendance or the decision (#78).
"""

import logging
import random
import time
from collections.abc import Callable
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
    MSG_IN_PROGRESS_ELSEWHERE,
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
    EXAM_IN_PROGRESS,
    EXAMS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    THROTTLING_ERRORS,
    get_item_or_busy,
    paginate,
    raise_if_throttled,
    table,
)

logger = logging.getLogger(__name__)

BY_STUDENT_INDEX = "by_student"

_MAX_ATTEMPTS = 4
_BACKOFF_SECONDS = 0.05

# Order of the items in the attendance transaction (CancellationReasons follow it).
_PUT_EXAM, _UPDATE_EVENT, _UPDATE_STUDENT = range(3)
# Order of the items in the decision transaction.
_DECIDE_EXAM, _UPDATE_STUDENT_DECISION, _CHECK_SENSEI = range(3)

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
    """Return whether the student has at least one exam.

    Raises:
        ServiceUnavailableError: If the ``by_student`` index kept throttling (503).
    """
    try:
        response = table(EXAMS_TABLE_ENV).query(
            IndexName=BY_STUDENT_INDEX,
            KeyConditionExpression=Key("student_id").eq(student_id),
            Limit=1,
        )
    except ClientError as exc:
        raise_if_throttled(exc, f"Query on Exams (index {BY_STUDENT_INDEX})")
        raise
    return bool(response.get("Items"))


def event_has_exams(event_id: str) -> bool:
    """Return whether the event has at least one exam.

    Raises:
        ServiceUnavailableError: If the exams table kept throttling (503).
    """
    try:
        response = table(EXAMS_TABLE_ENV).query(
            KeyConditionExpression=Key("event_id").eq(event_id),
            Limit=1,
        )
    except ClientError as exc:
        raise_if_throttled(exc, "Query on Exams")
        raise
    return bool(response.get("Items"))


def get_exam(event_id: str, student_id: str) -> Exam | None:
    """Return the exam of a student in an event, or None.

    Strongly consistent: the exam sheet, a marking or the decision right after
    the attendance must find the exam, and the sheet right after the decision
    must show it decided (RN005–RN010).

    Raises:
        ServiceUnavailableError: If the exams table kept throttling (503).
    """
    key = {"event_id": event_id, "student_id": student_id}
    item = get_item_or_busy(table(EXAMS_TABLE_ENV), key, ConsistentRead=True)
    return _from_item(item) if item else None


def list_by_event(event_id: str) -> list[Exam]:
    """Return every exam of an event (follows ``LastEvaluatedKey``)."""
    items = paginate(
        table(EXAMS_TABLE_ENV).query,
        KeyConditionExpression=Key("event_id").eq(event_id),
    )
    return [_from_item(item) for item in items]


def list_by_student(student_id: str) -> list[Exam]:
    """Return every exam of a student, from the ``by_student`` index (RN018).

    Follows ``LastEvaluatedKey`` to the last page, with no ``Limit``. A GSI
    only allows eventually consistent reads: an exam written about a second
    ago may still be missing.

    Raises:
        ServiceUnavailableError: If the index kept throttling (503).
    """
    items = paginate(
        table(EXAMS_TABLE_ENV).query,
        IndexName=BY_STUDENT_INDEX,
        KeyConditionExpression=Key("student_id").eq(student_id),
    )
    return [_from_item(item) for item in items]


def create_exam(exam: Exam, student: Student | None = None) -> None:
    """Insert the exam born from an attendance confirmation (RN005).

    One transaction writes the exam only if it does not exist yet, the event
    still exists and is open, and the student still exists, is active and has
    no exam in progress (no ``exam_in_progress_id``; the same transaction sets
    it to the new exam's id, RN005). The same transaction adds 1 to
    ``exam_count`` on the event and on the student,
    the counter that the conditional deletes (RN016, RN018) and the guardian's
    graduation lock (RN013) read; the marker is what blocks a graduation edit
    while the exam is in progress (RN005). This closes the race with a
    concurrent confirmation, closing, deletion or graduation edit.
    ``TransactionConflict`` and throttling inside the transaction are retried
    with a short backoff; throttling of the whole request is a 503 at once.

    Args:
        exam: Exam to insert.
        student: Student as read when the target belt and kind were computed.
            When given, the exam is written only if the student's belt, belt
            date and stripes are still those values (RN003, RN004).

    Raises:
        ConflictError: If the attendance was already confirmed, the student
            has an exam in progress in another event, the student's graduation
            changed meanwhile, or the transaction kept conflicting after every
            retry.
        NotFoundError: If the event or the student was deleted meanwhile.
        ValidationError: If the event was closed or the student deactivated meanwhile.
        ServiceUnavailableError: If the transaction or the re-read of the event
            or student kept throttling (503).
    """
    items = _attendance_items(exam, student)
    _run_transaction(
        "Attendance",
        lambda: _transact_create(items),
        lambda reasons: _condition_error(exam, student, reasons),
        MSG_TRY_AGAIN,
    )


def _run_transaction(
    label: str,
    transact: Callable[[], None],
    translate: Callable[[list[str | None]], DomainError | None],
    try_again: str,
) -> None:
    """Run a transaction, translating failed conditions and retrying transient causes.

    Shared by the attendance and the decision. Throttling of the whole request
    (``THROTTLING_ERRORS``) already outlasted botocore's retries and becomes a
    503 at once. A cancelled transaction goes to ``translate`` first; with no
    failed condition, ``TransactionConflict`` and throttled items are retried
    with a short backoff and, if they persist, become 409 ``try_again`` and 503.

    Args:
        label: Name of the transaction, for the log.
        transact: Sends the transaction.
        translate: Turns the cancellation reasons (in item order) into the
            error of a failed condition, or None when no condition failed.
        try_again: Message of the 409 when the conflicts persist.

    Raises:
        DomainError: From ``translate``, or 409/503 after every retry.
        ClientError: Any other DynamoDB error, unchanged.
    """
    last_error: DomainError = ConflictError(try_again)
    for attempt in range(_MAX_ATTEMPTS):
        try:
            transact()
            return
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code in THROTTLING_ERRORS:
                logger.warning("%s transaction throttled after botocore retries: %s", label, code)
                raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc
            if code != _CANCELLED:
                raise
            reasons = [reason.get("Code") for reason in exc.response.get("CancellationReasons", [])]
            error = translate(reasons)
            if error is not None:
                raise error from exc
            if _THROTTLED_REASONS.intersection(reasons):
                last_error = ServiceUnavailableError(MSG_SERVICE_BUSY)
            elif _CONFLICT in reasons:
                last_error = ConflictError(try_again)
            else:
                raise
            if attempt + 1 < _MAX_ATTEMPTS:
                logger.info("%s transaction retry %d after %s", label, attempt + 1, reasons)
                time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))
    raise last_error


def _attendance_items(exam: Exam, student: Student | None) -> list[dict[str, Any]]:
    """Return the items of the attendance transaction, in ``_PUT_EXAM`` order."""
    student_condition = (
        f"attribute_exists(id) AND active = :true AND attribute_not_exists({EXAM_IN_PROGRESS})"
    )
    student_values: dict[str, Any] = {":one": 1, ":true": True, ":exam_id": exam.id}
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
                "UpdateExpression": f"SET {EXAM_IN_PROGRESS} = :exam_id ADD {EXAM_COUNT} :one",
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
    student, from "exam in progress in another event" and "graduation
    changed" (both 409). Returns None when no condition failed (e.g. only a
    transaction conflict). The re-reads are strongly consistent, so they see
    the concurrent write that made the condition fail.

    Raises:
        ServiceUnavailableError: If a re-read kept throttling (503).
    """

    def failed(index: int) -> bool:
        return index < len(reasons) and reasons[index] == "ConditionalCheckFailed"

    if failed(_PUT_EXAM):
        return ConflictError(MSG_ALREADY_CONFIRMED)
    if failed(_UPDATE_EVENT):
        item = get_item_or_busy(table(EVENTS_TABLE_ENV), {"id": exam.event_id}, ConsistentRead=True)
        return ValidationError(MSG_EVENT_CLOSED) if item else NotFoundError(MSG_EVENT_NOT_FOUND)
    if failed(_UPDATE_STUDENT):
        item = get_item_or_busy(
            table(STUDENTS_TABLE_ENV), {"id": exam.student_id}, ConsistentRead=True
        )
        if not item:
            return NotFoundError(MSG_STUDENT_NOT_FOUND)
        if not item.get("active", True):
            return ValidationError(MSG_STUDENT_INACTIVE)
        if item.get(EXAM_IN_PROGRESS):
            return ConflictError(MSG_IN_PROGRESS_ELSEWHERE)
        if student is None:
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
    # The marker is removed only if it is this exam's, or absent (exams
    # confirmed before the marker existed); never another exam's (RN005).
    condition += f" AND (attribute_not_exists({EXAM_IN_PROGRESS}) OR {EXAM_IN_PROGRESS} = :exam_id)"
    values[":exam_id"] = decided.id
    update = f"REMOVE {EXAM_IN_PROGRESS}"
    if approved is not None:
        # Only the graduation fields: exam_count and the rest are kept.
        update = (
            "SET current_belt_id = :new_belt, current_belt_since = :new_since,"
            " stripes = :new_stripes, updated_at = :updated " + update
        )
        values |= {
            ":new_belt": approved.current_belt_id,
            ":new_since": approved.current_belt_since.isoformat(),
            ":new_stripes": approved.stripes,
            ":updated": approved.updated_at,
        }
    student_item = {
        "Update": {
            "TableName": table(STUDENTS_TABLE_ENV).name,
            "Key": {"id": decided.student_id},
            "UpdateExpression": update,
            "ConditionExpression": condition,
            "ExpressionAttributeValues": values,
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
    → 404; marked with another exam in progress (only possible with data from
    before the marker) → 409; graduation changed since the attendance → 409.
    Returns None when no condition failed (e.g. only a transaction conflict).
    The re-reads are strongly consistent, so they see the concurrent write that
    made the condition fail.

    Raises:
        ServiceUnavailableError: If a re-read kept throttling (503).
    """

    def failed(index: int) -> bool:
        return index < len(reasons) and reasons[index] == _CONDITION_FAILED

    if failed(_CHECK_SENSEI):
        # Read the table directly: the settings are read again, never cached.
        item = get_item_or_busy(table(SETTINGS_TABLE_ENV), {"id": SETTINGS_ID}, ConsistentRead=True)
        if not item or not item.get("sensei_user_id"):
            return ConflictError(MSG_NO_SENSEI)
        return ForbiddenError(MSG_ONLY_SENSEI)

    if failed(_DECIDE_EXAM):
        key = {"event_id": exam.event_id, "student_id": exam.student_id}
        item = get_item_or_busy(table(EXAMS_TABLE_ENV), key, ConsistentRead=True)
        if not item or item.get("id") != exam.id:
            return NotFoundError(MSG_EXAM_NOT_FOUND)
        return ConflictError(MSG_EXAM_DECIDED)
    if failed(_UPDATE_STUDENT_DECISION):
        item = get_item_or_busy(
            table(STUDENTS_TABLE_ENV), {"id": exam.student_id}, ConsistentRead=True
        )
        if not item:
            return NotFoundError(MSG_STUDENT_NOT_FOUND)
        if item.get(EXAM_IN_PROGRESS, exam.id) != exam.id:
            return ConflictError(MSG_IN_PROGRESS_ELSEWHERE)
        return ConflictError(MSG_GRADUATION_CHANGED)
    return None


def _transact_decision(items: list[dict[str, Any]]) -> None:
    table(EXAMS_TABLE_ENV).meta.client.transact_write_items(TransactItems=items)


def decide_exam(decided: Exam, expected: Graduation, approved: Student | None) -> None:
    """Record the sensei's decision and, if approved, the new graduation (RN008–RN010).

    One transaction updates the exam only if it is still the same exam and in
    progress and, at the same instant, checks that the student still has the
    graduation the decision was based on and that the one deciding is still
    the sensei in the settings (RN008). The student's ``UpdateItem`` removes
    the ``exam_in_progress_id`` marker (only if it is this exam's or absent),
    freeing the student for another attendance (RN005); on approval it also
    writes the new belt, belt date and stripes (RN009). ``exam_count`` and
    every other attribute are kept. The event is not checked: a closed
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
    _run_transaction(
        "Decision",
        lambda: _transact_decision(items),
        lambda reasons: _decision_error(decided, reasons),
        MSG_DECISION_TRY_AGAIN,
    )
