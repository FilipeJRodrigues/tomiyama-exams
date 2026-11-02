"""Persistence of exam events in the ``Events`` table (PK ``id``)."""

from datetime import date
from typing import Any

from botocore.exceptions import ClientError

from domain.errors import ConflictError, NotFoundError
from domain.events import MSG_EVENT_HAS_EXAMS, MSG_EVENT_NOT_FOUND, EventStatus, ExamEvent
from repository.tables import (
    EVENTS_TABLE_ENV,
    NO_EXAMS_CONDITION,
    paginate,
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
    """Return an event by id, or None."""
    item = table(EVENTS_TABLE_ENV).get_item(Key={"id": event_id}).get("Item")
    return _from_item(item) if item else None


def list_all() -> list[ExamEvent]:
    """Return every event (unordered; a few per year)."""
    return [_from_item(item) for item in paginate(table(EVENTS_TABLE_ENV).scan)]


def create_event(event: ExamEvent) -> None:
    """Insert a new event."""
    table(EVENTS_TABLE_ENV).put_item(
        Item=event.to_dict(), ConditionExpression="attribute_not_exists(id)"
    )


def save_event(event: ExamEvent) -> None:
    """Rewrite an existing event's attributes, keeping its ``exam_count``.

    Raises:
        NotFoundError: If the event was deleted meanwhile.
    """
    try:
        table(EVENTS_TABLE_ENV).update_item(
            **replace_fields(event.to_dict()), ConditionExpression="attribute_exists(id)"
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        raise NotFoundError(MSG_EVENT_NOT_FOUND) from exc


def delete_event(event_id: str) -> None:
    """Delete an event only if it has no exam (RN016).

    The condition reads the ``exam_count`` kept by the attendance transaction,
    so an attendance confirmed after any earlier check still blocks the delete.

    Raises:
        ConflictError: If the event has exams.
    """
    try:
        table(EVENTS_TABLE_ENV).delete_item(
            Key={"id": event_id},
            ConditionExpression=NO_EXAMS_CONDITION,
            ExpressionAttributeValues={":zero": 0},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        raise ConflictError(MSG_EVENT_HAS_EXAMS) from exc
