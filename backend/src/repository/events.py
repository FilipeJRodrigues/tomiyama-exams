"""Persistence of exam events in the ``Events`` table (PK ``id``).

An event holds the id of its requirement profile (``profile_id``; absent on
events stored before the profiles existed, read as the main profile). Two
rules are kept by the writes themselves, not by an earlier read (#144):

- **The profile changes only while the event has no exams.** The write that
  changes ``profile_id`` (``change_event_profile``) is conditioned on the
  ``exam_count`` kept by the attendance transaction, like the delete. Every
  other edit (``save_event``) does not write ``profile_id`` at all, so a slow
  edit of the name never brings an old profile back.
- **An event never starts using a stored profile that is missing or not
  ready.** The write that makes an event use a profile other than the main
  one (creation or change) is a transaction with a ``ConditionCheck`` on the
  profiles item of ``Settings``: ``profiles.<id>.status`` is ``READY`` at the
  instant the event is written. So whoever takes a profile out of ``READY``
  first (a conditional write on the same item) and reads the events
  afterwards finds every event that uses it: no event can be written with
  that profile after the status changed. The main profile is not stored and
  is never deleted, so an event of the main profile needs no transaction.
"""

import logging
import random
import time
from collections.abc import Iterable
from datetime import date
from typing import Any

from botocore.exceptions import ClientError

from domain.errors import (
    MSG_SERVICE_BUSY,
    ConflictError,
    DomainError,
    NotFoundError,
    ServiceUnavailableError,
)
from domain.events import (
    MSG_EVENT_HAS_EXAMS,
    MSG_EVENT_NOT_FOUND,
    MSG_EVENT_PROFILE_LOCKED,
    MSG_EVENT_TRY_AGAIN,
    EventStatus,
    ExamEvent,
    check_profile_usable,
)
from domain.requirement_profiles import MAIN_PROFILE_ID, MSG_PROFILE_NOT_FOUND
from repository import requirement_profiles as profile_repo
from repository.tables import (
    EVENTS_TABLE_ENV,
    NO_EXAMS_CONDITION,
    THROTTLING_ERRORS,
    batch_get,
    get_item_or_busy,
    paginate,
    raise_if_throttled,
    replace_fields,
    table,
)

logger = logging.getLogger(__name__)

_PROFILE_ID = "profile_id"

_MAX_ATTEMPTS = 4
_BACKOFF_SECONDS = 0.05

# Order of the items in the transaction of an event that uses a stored
# profile (CancellationReasons follow it).
_WRITE_EVENT, _CHECK_PROFILE = range(2)

_CANCELLED = "TransactionCanceledException"
_CONDITION_FAILED = "ConditionalCheckFailed"
_CONFLICT = "TransactionConflict"
# Cancellation reasons of an item throttled inside the transaction.
_THROTTLED_REASONS = frozenset({"ThrottlingError", "ProvisionedThroughputExceeded"})


def _from_item(item: dict[str, Any]) -> ExamEvent:
    return ExamEvent(
        id=item["id"],
        name=item["name"],
        exam_date=date.fromisoformat(item["exam_date"]),
        status=EventStatus(item["status"]),
        created_at=item["created_at"],
        updated_at=item["updated_at"],
        # Events stored before the profiles existed have no profile: the main one.
        profile_id=item.get(_PROFILE_ID) or MAIN_PROFILE_ID,
    )


def get_event(event_id: str) -> ExamEvent | None:
    """Return an event by id, or None (strongly consistent).

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    item = get_item_or_busy(table(EVENTS_TABLE_ENV), {"id": event_id}, ConsistentRead=True)
    return _from_item(item) if item else None


def get_events(event_ids: Iterable[str]) -> dict[str, ExamEvent]:
    """Return ``{id: event}`` for the given ids; missing events are left out.

    One ``BatchGetItem`` per 100 ids, eventually consistent: used only to show
    names and dates, which never decide a route's status code (``exam_date``
    never changes after creation).

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    keys = [{"id": event_id} for event_id in sorted(set(event_ids))]
    items = batch_get(table(EVENTS_TABLE_ENV), keys)
    return {item["id"]: _from_item(item) for item in items}


def list_all() -> list[ExamEvent]:
    """Return every event (unordered; a few per year)."""
    return [_from_item(item) for item in paginate(table(EVENTS_TABLE_ENV).scan)]


def any_event_uses_profile(profile_id: str) -> bool:
    """Return whether some event, open or closed, uses the stored profile ``profile_id``.

    A strongly consistent ``Scan`` of every page of the table (a few events
    per year), unlike ``list_all``: the deletion of a profile depends on it.
    Run **after** the profile left ``READY``, it finds every event that uses
    the profile, because no event starts using a profile that is not
    ``READY`` (see the module docstring). An event without ``profile_id``
    (or with a blank one) is an event of the main profile and never matches.

    Raises:
        ServiceUnavailableError: If a page kept throttling (503).
    """
    items = paginate(
        table(EVENTS_TABLE_ENV).scan,
        ConsistentRead=True,
        ProjectionExpression="#id, #profile",
        ExpressionAttributeNames={"#id": "id", "#profile": _PROFILE_ID},
    )
    return any(item.get(_PROFILE_ID) == profile_id for item in items)


def create_event(event: ExamEvent) -> None:
    """Insert a new event.

    An event of a profile other than the main one is written in a transaction
    that checks, at the same instant, that the profile exists and is
    ``READY`` (see the module docstring).

    Raises:
        NotFoundError: If the event's profile does not exist (any more).
        ConflictError: If the event's profile is not ready, or the
            transaction kept conflicting after every retry.
        ServiceUnavailableError: If the write kept throttling (503).
    """
    if event.profile_id != MAIN_PROFILE_ID:
        put = {
            "Put": {
                "TableName": table(EVENTS_TABLE_ENV).name,
                "Item": event.to_dict(),
                "ConditionExpression": "attribute_not_exists(id)",
            }
        }
        _write_with_profile(event, put, "Event creation")
        return
    try:
        table(EVENTS_TABLE_ENV).put_item(
            Item=event.to_dict(), ConditionExpression="attribute_not_exists(id)"
        )
    except ClientError as exc:
        raise_if_throttled(exc, "PutItem on Events")
        raise


def save_event(event: ExamEvent) -> None:
    """Rewrite an existing event's attributes, keeping its ``exam_count`` and its profile.

    ``profile_id`` is not written (only ``change_event_profile`` writes it):
    an edit that read the event before a concurrent change of profile does
    not undo that change, and an event with exams keeps its profile.

    Raises:
        NotFoundError: If the event was deleted meanwhile.
        ServiceUnavailableError: If the write kept throttling (503).
    """
    fields = {key: value for key, value in event.to_dict().items() if key != _PROFILE_ID}
    try:
        table(EVENTS_TABLE_ENV).update_item(
            **replace_fields(fields), ConditionExpression="attribute_exists(id)"
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise_if_throttled(exc, "UpdateItem on Events")
            raise
        raise NotFoundError(MSG_EVENT_NOT_FOUND) from exc


def change_event_profile(event: ExamEvent) -> None:
    """Rewrite an existing event's attributes, ``profile_id`` included, only if it has no exams.

    The condition reads the ``exam_count`` kept by the attendance transaction
    (RN005), so an attendance confirmed after any earlier check still blocks
    the change, and nothing of the edit is written (RN016). When the new
    profile is not the main one, the same transaction checks that it exists
    and is ``READY`` (see the module docstring).

    Raises:
        NotFoundError: If the event was deleted meanwhile, or the new profile
            does not exist (any more).
        ConflictError: If the event has exams, the new profile is not ready,
            or the transaction kept conflicting after every retry.
        ServiceUnavailableError: If the write or a re-read kept throttling (503).
    """
    arguments = replace_fields(event.to_dict())
    arguments["ConditionExpression"] = f"attribute_exists(id) AND ({NO_EXAMS_CONDITION})"
    arguments["ExpressionAttributeValues"][":zero"] = 0
    if event.profile_id != MAIN_PROFILE_ID:
        update = {"Update": {"TableName": table(EVENTS_TABLE_ENV).name, **arguments}}
        _write_with_profile(event, update, "Event profile change")
        return
    try:
        table(EVENTS_TABLE_ENV).update_item(**arguments)
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise_if_throttled(exc, "UpdateItem on Events")
            raise
        raise _refused_change(event.id) from exc


def _refused_change(event_id: str) -> DomainError:
    """Tell why the conditional change of profile failed: event deleted (404) or with exams (409).

    The re-read is strongly consistent, so it sees the concurrent write.

    Raises:
        ServiceUnavailableError: If the re-read kept throttling (503).
    """
    item = get_item_or_busy(table(EVENTS_TABLE_ENV), {"id": event_id}, ConsistentRead=True)
    if not item:
        return NotFoundError(MSG_EVENT_NOT_FOUND)
    return ConflictError(MSG_EVENT_PROFILE_LOCKED)


def _profile_error(profile_id: str) -> DomainError:
    """Tell why the profile check of the transaction failed, reading the profile again.

    Raises:
        ServiceUnavailableError: If the re-read kept throttling (503).
    """
    profile = profile_repo.get_profile(profile_id)
    if profile is None:
        return NotFoundError(MSG_PROFILE_NOT_FOUND)
    try:
        check_profile_usable(profile)
    except ConflictError as error:
        # Still copying, or being deleted: the message of its status.
        return error
    # Ready by the time of the re-read: the request may simply be repeated.
    return ConflictError(MSG_EVENT_TRY_AGAIN)


def _condition_error(
    event: ExamEvent, write: dict[str, Any], reasons: list[str | None]
) -> DomainError | None:
    """Translate the failed conditions of the event-with-profile transaction.

    In the order of the route's answers: event deleted (404), profile missing
    (404) or not ready (409), event with exams (409). Returns None when no
    condition failed (e.g. only a transaction conflict) or when a new event's
    id already existed (a UUID collision, left as the original error).

    Raises:
        ServiceUnavailableError: If a re-read kept throttling (503).
    """

    def failed(index: int) -> bool:
        return index < len(reasons) and reasons[index] == _CONDITION_FAILED

    refused = _refused_change(event.id) if "Update" in write and failed(_WRITE_EVENT) else None
    if isinstance(refused, NotFoundError):
        return refused
    if failed(_CHECK_PROFILE):
        return _profile_error(event.profile_id)
    return refused


def _transact(items: list[dict[str, Any]]) -> None:
    table(EVENTS_TABLE_ENV).meta.client.transact_write_items(TransactItems=items)


def _write_with_profile(event: ExamEvent, write: dict[str, Any], label: str) -> None:
    """Write the event and check its stored profile is ``READY``, in one transaction.

    Throttling of the whole request already outlasted botocore's retries and
    is a 503 at once. A cancelled transaction is translated by
    ``_condition_error``; with no failed condition, ``TransactionConflict``
    (e.g. the copy of another profile writing its progress on the profiles
    item) and throttled items are retried with a short backoff and, if they
    persist, become 409 "try again" and 503.

    Args:
        event: The event being written; its ``profile_id`` is the stored profile.
        write: The ``Put`` or ``Update`` of the event, first item of the transaction.
        label: Name of the transaction, for the log.

    Raises:
        DomainError: See ``create_event`` and ``change_event_profile``.
        ClientError: Any other DynamoDB error, unchanged.
    """
    items = [write, profile_repo.ready_condition_check(event.profile_id)]
    last_error: DomainError = ConflictError(MSG_EVENT_TRY_AGAIN)
    for attempt in range(_MAX_ATTEMPTS):
        try:
            _transact(items)
            return
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code in THROTTLING_ERRORS:
                logger.warning("%s transaction throttled after botocore retries: %s", label, code)
                raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc
            if code != _CANCELLED:
                raise
            reasons = [reason.get("Code") for reason in exc.response.get("CancellationReasons", [])]
            error = _condition_error(event, write, reasons)
            if error is not None:
                raise error from exc
            if _THROTTLED_REASONS.intersection(reasons):
                last_error = ServiceUnavailableError(MSG_SERVICE_BUSY)
            elif _CONFLICT in reasons:
                last_error = ConflictError(MSG_EVENT_TRY_AGAIN)
            else:
                raise
            if attempt + 1 < _MAX_ATTEMPTS:
                logger.info("%s transaction retry %d after %s", label, attempt + 1, reasons)
                time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))
    raise last_error


def delete_event(event_id: str) -> None:
    """Delete an event only if it has no exam (RN016).

    The condition reads the ``exam_count`` kept by the attendance transaction,
    so an attendance confirmed after any earlier check still blocks the delete.

    Raises:
        ConflictError: If the event has exams.
        ServiceUnavailableError: If the delete kept throttling (503).
    """
    try:
        table(EVENTS_TABLE_ENV).delete_item(
            Key={"id": event_id},
            ConditionExpression=NO_EXAMS_CONDITION,
            ExpressionAttributeValues={":zero": 0},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise_if_throttled(exc, "DeleteItem on Events")
            raise
        raise ConflictError(MSG_EVENT_HAS_EXAMS) from exc
