"""Persistence of exam events in the ``Events`` table (PK ``id``)."""

from collections.abc import Iterable
from datetime import date
from typing import Any

from botocore.exceptions import ClientError

from domain.errors import ConflictError, NotFoundError
from domain.events import MSG_EVENT_HAS_EXAMS, MSG_EVENT_NOT_FOUND, EventStatus, ExamEvent
from repository.tables import (
    EVENTS_TABLE_ENV,
    NO_EXAMS_CONDITION,
    batch_get,
    get_item_or_busy,
    paginate,
    raise_if_throttled,
    replace_fields,
    table,
)


def _from_item(item: dict[str, Any]) -> ExamEvent:
    return ExamEvent(
        id=item["id"],
        name=item["name"],
        exam_date=date.fromisoformat(item["exam_date"]),
        status=EventStatus(item["status"]),
        created_at=item["created_at"],
        updated_at=item["updated_at"],
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


def create_event(event: ExamEvent) -> None:
    """Insert a new event.

    Raises:
        ServiceUnavailableError: If the write kept throttling (503).
    """
    try:
        table(EVENTS_TABLE_ENV).put_item(
            Item=event.to_dict(), ConditionExpression="attribute_not_exists(id)"
        )
    except ClientError as exc:
        raise_if_throttled(exc, "PutItem on Events")
        raise


def save_event(event: ExamEvent) -> None:
    """Rewrite an existing event's attributes, keeping its ``exam_count``.

    Raises:
        NotFoundError: If the event was deleted meanwhile.
        ServiceUnavailableError: If the write kept throttling (503).
    """
    try:
        table(EVENTS_TABLE_ENV).update_item(
            **replace_fields(event.to_dict()), ConditionExpression="attribute_exists(id)"
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise_if_throttled(exc, "UpdateItem on Events")
            raise
        raise NotFoundError(MSG_EVENT_NOT_FOUND) from exc


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
