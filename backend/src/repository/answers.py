"""Persistence of exam answers in the ``Answers`` table (RN006).

Keys: PK ``exam_id`` (the exam's UUID), SK ``requirement_id``: one answer per
(exam, item), as § 3.6 asks. Keying by the exam's UUID, not by
``event_id#student_id``, keeps answers of a deleted exam from showing up in a
new exam of the same student and event.

Every write is a transaction that also checks, at the same instant, that the
exam still exists and is in progress (RN010) and that the event is still open
(RN016). The first answer of an item adds 1 to the requirement's
``answer_count`` (unmarking subtracts 1), the counter the conditional delete of
a requirement reads, so an item with answers is never deleted nor moved to
another belt or kind (``repository.requirements.save_requirement``), even when
the two requests race. Replacing a mark also checks that the item is still in
the exam's target belt.

``TransactionConflict`` and throttling (low provisioned capacity) are retried
with backoff; if they persist the request ends in 409 or 503, never in 500.
"""

import logging
import random
import time
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from domain.answers import (
    MSG_BUSY_TRY_AGAIN,
    MSG_EXAM_DECIDED,
    MSG_ITEM_NOT_IN_BELT,
    MSG_MARK_TRY_AGAIN,
    ExamAnswer,
)
from domain.errors import (
    ConflictError,
    DomainError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from domain.events import EventStatus
from domain.exams import MSG_EVENT_CLOSED, MSG_EVENT_NOT_FOUND, MSG_EXAM_NOT_FOUND, Exam, ExamStatus
from domain.requirements import MSG_REQUIREMENT_NOT_FOUND
from repository.tables import (
    ANSWER_COUNT,
    ANSWERS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    REQUIREMENTS_TABLE_ENV,
    THROTTLING_ERRORS,
    paginate,
    table,
)

logger = logging.getLogger(__name__)

# Create/replace may alternate when another examiner marks or unmarks the same
# item at the same time; each switch uses one attempt.
_MAX_ATTEMPTS = 6
_BACKOFF_SECONDS = 0.05

# Order of the items in every answer transaction (CancellationReasons follow it).
# ``_CHECK_REQUIREMENT`` is the requirement update (insert, unmark) or check (replace).
_CHECK_EXAM, _CHECK_EVENT, _WRITE_ANSWER, _CHECK_REQUIREMENT = range(4)

_CANCELLED = "TransactionCanceledException"
_CONDITION_FAILED = "ConditionalCheckFailed"
_CONFLICT = "TransactionConflict"
# Cancellation reasons of an item throttled inside the transaction.
_THROTTLED_REASONS = frozenset({"ThrottlingError", "ProvisionedThroughputExceeded"})


def _from_item(item: dict[str, Any]) -> ExamAnswer:
    return ExamAnswer(
        exam_id=item["exam_id"],
        requirement_id=item["requirement_id"],
        correct=bool(item["correct"]),
        marked_by=item["marked_by"],
        marked_at=item["marked_at"],
    )


def list_by_exam(exam_id: str) -> dict[str, ExamAnswer]:
    """Return the answers of an exam indexed by requirement id (follows pagination).

    Strongly consistent on every page: the summary returned right after a mark
    (RN007) and the exam sheet (RN006) must include a mark another examiner
    wrote milliseconds before. Costs 1 RCU per 4 KB instead of 0.5.
    """
    items = paginate(
        table(ANSWERS_TABLE_ENV).query,
        KeyConditionExpression=Key("exam_id").eq(exam_id),
        ConsistentRead=True,
    )
    answers = (_from_item(item) for item in items)
    return {answer.requirement_id: answer for answer in answers}


def _guards(exam: Exam) -> list[dict[str, Any]]:
    """Checks of ``_CHECK_EXAM`` and ``_CHECK_EVENT``: exam in progress, event open."""
    return [
        {
            "ConditionCheck": {
                "TableName": table(EXAMS_TABLE_ENV).name,
                "Key": {"event_id": exam.event_id, "student_id": exam.student_id},
                "ConditionExpression": "id = :exam_id AND #status = :in_progress",
                "ExpressionAttributeNames": {"#status": "status"},
                "ExpressionAttributeValues": {
                    ":exam_id": exam.id,
                    ":in_progress": ExamStatus.IN_PROGRESS.value,
                },
            }
        },
        {
            "ConditionCheck": {
                "TableName": table(EVENTS_TABLE_ENV).name,
                "Key": {"id": exam.event_id},
                "ConditionExpression": "#status = :open",
                "ExpressionAttributeNames": {"#status": "status"},
                "ExpressionAttributeValues": {":open": EventStatus.OPEN.value},
            }
        },
    ]


def _answer_key(exam: Exam, requirement_id: str) -> dict[str, str]:
    return {"exam_id": exam.id, "requirement_id": requirement_id}


def _create_items(exam: Exam, answer: ExamAnswer) -> list[dict[str, Any]]:
    """First answer of the item: insert it and count it on the requirement."""
    item = {
        **_answer_key(exam, answer.requirement_id),
        "event_id": exam.event_id,
        "student_id": exam.student_id,
        "correct": answer.correct,
        "marked_by": answer.marked_by,
        "marked_at": answer.marked_at,
    }
    return [
        *_guards(exam),
        {
            "Put": {
                "TableName": table(ANSWERS_TABLE_ENV).name,
                "Item": item,
                "ConditionExpression": "attribute_not_exists(exam_id)",
            }
        },
        {
            "Update": {
                "TableName": table(REQUIREMENTS_TABLE_ENV).name,
                "Key": {"id": answer.requirement_id},
                "UpdateExpression": f"ADD {ANSWER_COUNT} :one",
                "ConditionExpression": "attribute_exists(id) AND belt_id = :belt",
                "ExpressionAttributeValues": {":one": 1, ":belt": exam.target_belt_id},
            }
        },
    ]


def _replace_items(exam: Exam, answer: ExamAnswer) -> list[dict[str, Any]]:
    """Item already answered: replace the mark (the counter stays as it is).

    The requirement is checked in the same transaction (it exists and is in
    the exam's target belt), so a mark is never written to an item that left
    the belt between the handler's read and the write.
    """
    return [
        *_guards(exam),
        {
            "Update": {
                "TableName": table(ANSWERS_TABLE_ENV).name,
                "Key": _answer_key(exam, answer.requirement_id),
                "UpdateExpression": "SET correct = :correct, marked_by = :by, marked_at = :at",
                "ConditionExpression": "attribute_exists(exam_id)",
                "ExpressionAttributeValues": {
                    ":correct": answer.correct,
                    ":by": answer.marked_by,
                    ":at": answer.marked_at,
                },
            }
        },
        {
            "ConditionCheck": {
                "TableName": table(REQUIREMENTS_TABLE_ENV).name,
                "Key": {"id": answer.requirement_id},
                "ConditionExpression": "attribute_exists(id) AND belt_id = :belt",
                "ExpressionAttributeValues": {":belt": exam.target_belt_id},
            }
        },
    ]


def _delete_items(exam: Exam, requirement_id: str) -> list[dict[str, Any]]:
    """Unmark: delete the answer and discount it from the requirement."""
    return [
        *_guards(exam),
        {
            "Delete": {
                "TableName": table(ANSWERS_TABLE_ENV).name,
                "Key": _answer_key(exam, requirement_id),
                "ConditionExpression": "attribute_exists(exam_id)",
            }
        },
        {
            "Update": {
                "TableName": table(REQUIREMENTS_TABLE_ENV).name,
                "Key": {"id": requirement_id},
                "UpdateExpression": f"ADD {ANSWER_COUNT} :minus_one",
                "ConditionExpression": "attribute_exists(id)",
                "ExpressionAttributeValues": {":minus_one": -1},
            }
        },
    ]


def _transact(items: list[dict[str, Any]]) -> None:
    table(ANSWERS_TABLE_ENV).meta.client.transact_write_items(TransactItems=items)


def _cancellation_reasons(exc: ClientError) -> list[str | None]:
    """Return the reason codes of a cancelled transaction, or re-raise other errors.

    Raises:
        ServiceUnavailableError: If the whole request was throttled; botocore
            already retried it, so another round here would only add latency.
    """
    code = exc.response["Error"]["Code"]
    if code in THROTTLING_ERRORS:
        logger.warning("Answer transaction throttled after botocore retries: %s", code)
        raise ServiceUnavailableError(MSG_BUSY_TRY_AGAIN) from exc
    if code != _CANCELLED:
        raise exc
    return [reason.get("Code") for reason in exc.response.get("CancellationReasons", [])]


def _retry_error(reasons: list[str | None]) -> DomainError | None:
    """Return the error to raise if a retryable cause persists, or None if not retryable.

    Throttling → 503 (capacity: the same request may pass later);
    ``TransactionConflict`` → 409 (another marking on the same items).
    """
    if _THROTTLED_REASONS.intersection(reasons):
        return ServiceUnavailableError(MSG_BUSY_TRY_AGAIN)
    if _CONFLICT in reasons:
        return ConflictError(MSG_MARK_TRY_AGAIN)
    return None


def _failed(reasons: list[str | None], index: int) -> bool:
    return index < len(reasons) and reasons[index] == _CONDITION_FAILED


def _guard_error(exam: Exam, reasons: list[str | None]) -> DomainError | None:
    """Translate a failed exam or event check, reading the item again.

    Exam deleted or replaced → 404; decided → 409 "Exame já decidido" (RN010).
    Event deleted → 404; closed → 400 "Evento encerrado" (RN016). The re-reads
    are strongly consistent, so they see the concurrent write that made the
    check fail.
    """
    if _failed(reasons, _CHECK_EXAM):
        key = {"event_id": exam.event_id, "student_id": exam.student_id}
        item = table(EXAMS_TABLE_ENV).get_item(Key=key, ConsistentRead=True).get("Item")
        if not item or item.get("id") != exam.id:
            return NotFoundError(MSG_EXAM_NOT_FOUND)
        return ConflictError(MSG_EXAM_DECIDED)
    if _failed(reasons, _CHECK_EVENT):
        item = (
            table(EVENTS_TABLE_ENV)
            .get_item(Key={"id": exam.event_id}, ConsistentRead=True)
            .get("Item")
        )
        return ValidationError(MSG_EVENT_CLOSED) if item else NotFoundError(MSG_EVENT_NOT_FOUND)
    return None


def _requirement_error(requirement_id: str) -> DomainError:
    """Translate a failed requirement condition: deleted (404) or moved to another belt (400).

    The re-read is strongly consistent, so a delete a moment ago is a 404.
    """
    item = (
        table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )
    if not item:
        return NotFoundError(MSG_REQUIREMENT_NOT_FOUND)
    return ValidationError(MSG_ITEM_NOT_IN_BELT)


def _backoff(attempt: int, error: DomainError) -> None:
    logger.info("Answer transaction retry %d after %s", attempt + 1, type(error).__name__)
    time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))


def save_answer(exam: Exam, answer: ExamAnswer) -> None:
    """Write the mark of an item, replacing any previous one (RN006).

    Tries to insert the first answer; if the item is already answered (also
    when another examiner answered it a moment ago), replaces it instead, so
    the last mark wins. If the answer vanishes between the two (unmarked by
    someone else), goes back to inserting. ``TransactionConflict`` (two
    transactions on the same items at once) and throttling are retried with a
    short backoff.

    Raises:
        NotFoundError: If the exam, the event or the requirement was deleted.
        ValidationError: If the event was closed or the item moved to another
            belt meanwhile.
        ConflictError: If the exam was decided meanwhile (RN010) or the
            transaction kept conflicting after every retry.
        ServiceUnavailableError: If it kept being throttled after every retry.
    """
    create = True
    last_error: DomainError = ConflictError(MSG_MARK_TRY_AGAIN)
    for attempt in range(_MAX_ATTEMPTS):
        items = _create_items(exam, answer) if create else _replace_items(exam, answer)
        try:
            _transact(items)
            return
        except ClientError as exc:
            reasons = _cancellation_reasons(exc)
            error = _guard_error(exam, reasons)
            if error is not None:
                raise error from exc
            if _failed(reasons, _CHECK_REQUIREMENT):
                raise _requirement_error(answer.requirement_id) from exc
            if _failed(reasons, _WRITE_ANSWER):
                create = not create
                continue
            retry_error = _retry_error(reasons)
            if retry_error is None:
                raise
            last_error = retry_error
            if attempt + 1 < _MAX_ATTEMPTS:
                _backoff(attempt, retry_error)
    raise last_error


def delete_answer(exam: Exam, requirement_id: str) -> bool:
    """Unmark an item, back to "not marked", with the same locks as marking.

    Returns:
        True if an answer was deleted, False if the item was not marked.

    Raises:
        NotFoundError: If the exam or the event was deleted meanwhile.
        ValidationError: If the event was closed meanwhile.
        ConflictError: If the exam was decided meanwhile (RN010) or the
            transaction kept conflicting after every retry.
        ServiceUnavailableError: If it kept being throttled after every retry.
    """
    last_error: DomainError = ConflictError(MSG_MARK_TRY_AGAIN)
    for attempt in range(_MAX_ATTEMPTS):
        try:
            _transact(_delete_items(exam, requirement_id))
            return True
        except ClientError as exc:
            reasons = _cancellation_reasons(exc)
            error = _guard_error(exam, reasons)
            if error is not None:
                raise error from exc
            if _failed(reasons, _WRITE_ANSWER):
                return False
            if _failed(reasons, _CHECK_REQUIREMENT):
                raise NotFoundError(MSG_REQUIREMENT_NOT_FOUND) from exc
            retry_error = _retry_error(reasons)
            if retry_error is None:
                raise
            last_error = retry_error
            if attempt + 1 < _MAX_ATTEMPTS:
                _backoff(attempt, retry_error)
    raise last_error
