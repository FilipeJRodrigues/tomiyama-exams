"""Persistence of belt requirements in the ``Requirements`` table.

Keys: PK ``id``; GSI ``by_belt`` (PK ``belt_id``, SK ``sort_order``) lists a
belt's items in sheet order. The ``answer_count`` attribute is kept by the
answer transactions (``repository.answers``); while it is above zero the item
cannot be deleted nor change its belt or kind.
"""

import logging
from collections.abc import Iterable
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from domain.errors import ConflictError, NotFoundError
from domain.requirements import (
    MSG_REQUIREMENT_HAS_ANSWERS,
    MSG_REQUIREMENT_LOCKED,
    MSG_REQUIREMENT_NOT_FOUND,
    Requirement,
    RequirementKind,
)
from repository.tables import (
    ANSWER_COUNT,
    NO_ANSWERS_CONDITION,
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    paginate,
    put_if_absent,
    replace_fields,
    table,
)

logger = logging.getLogger(__name__)

BY_BELT_INDEX = "by_belt"
SEED_MARKER_ID = "seed:requirements:v1"


def _to_item(requirement: Requirement) -> dict[str, Any]:
    item = requirement.to_dict()
    return {key: value for key, value in item.items() if value is not None}


def _from_item(item: dict[str, Any]) -> Requirement:
    return Requirement(
        id=item["id"],
        belt_id=item["belt_id"],
        kind=RequirementKind(item["kind"]),
        category=item["category"],
        description=item["description"],
        expected_answer=item.get("expected_answer"),
        sort_order=int(item["sort_order"]),
    )


def get_requirement(requirement_id: str) -> Requirement | None:
    """Return an item by id, or None."""
    item = (
        table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )
    return _from_item(item) if item else None


def list_by_belt(belt_id: str) -> list[Requirement]:
    """Return every item of a belt in sheet order (no page limit cuts the list)."""
    items = paginate(
        table(REQUIREMENTS_TABLE_ENV).query,
        IndexName=BY_BELT_INDEX,
        KeyConditionExpression=Key("belt_id").eq(belt_id),
    )
    return [_from_item(item) for item in items]


def list_all() -> list[Requirement]:
    """Return every item of every belt (unordered)."""
    return [_from_item(item) for item in paginate(table(REQUIREMENTS_TABLE_ENV).scan)]


def create_requirement(requirement: Requirement) -> None:
    """Insert a new item."""
    table(REQUIREMENTS_TABLE_ENV).put_item(
        Item=_to_item(requirement), ConditionExpression="attribute_not_exists(id)"
    )


def save_requirement(requirement: Requirement) -> None:
    """Rewrite an existing item's attributes, keeping its ``answer_count``.

    An item with answers keeps its belt and kind (RN017): moving it would drop
    the answers from the exam sheet and score (RN006/RN007) and make them
    impossible to unmark. The lock compares the stored values with the new ones
    in the write's own condition, so resending the same belt and kind passes,
    and a first answer committed after the handler's read still blocks a move.

    Raises:
        NotFoundError: If the item was deleted meanwhile.
        ConflictError: If the item has answers and the belt or kind changes.
    """
    arguments = replace_fields(requirement.to_dict())
    arguments["ExpressionAttributeNames"].update(
        {"#answers": ANSWER_COUNT, "#belt": "belt_id", "#kind": "kind"}
    )
    arguments["ExpressionAttributeValues"].update(
        {
            ":zero": 0,
            ":same_belt": requirement.belt_id,
            ":same_kind": requirement.kind.value,
        }
    )
    condition = (
        "attribute_exists(id) AND (attribute_not_exists(#answers) OR #answers = :zero"
        " OR (#belt = :same_belt AND #kind = :same_kind))"
    )
    try:
        table(REQUIREMENTS_TABLE_ENV).update_item(**arguments, ConditionExpression=condition)
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        if get_requirement(requirement.id) is None:
            raise NotFoundError(MSG_REQUIREMENT_NOT_FOUND) from exc
        raise ConflictError(MSG_REQUIREMENT_LOCKED) from exc


def delete_requirement(requirement_id: str) -> None:
    """Delete an item only if no exam has an answer for it.

    The condition reads the ``answer_count`` kept by the answer transactions,
    so a first answer written after any earlier check still blocks the delete,
    and a marking that runs after the delete fails on its own condition.

    Raises:
        ConflictError: If the item has answers.
    """
    try:
        table(REQUIREMENTS_TABLE_ENV).delete_item(
            Key={"id": requirement_id},
            ConditionExpression=NO_ANSWERS_CONDITION,
            ExpressionAttributeValues={":zero": 0},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        raise ConflictError(MSG_REQUIREMENT_HAS_ANSWERS) from exc


def seed_requirements(requirements: Iterable[Requirement], *, deadline: float | None = None) -> int:
    """Load the initial items once, never duplicating or overwriting screen edits.

    A marker in the settings table records that the load finished, so items
    deleted by an examiner are not recreated on the next deploy. If a previous
    run stopped midway, the conditional writes only add the missing items.
    Throttled writes (low provisioned capacity) are retried with backoff. The
    marker is read with ``ConsistentRead``: a load starting right after another
    one finished must see it, or it would recreate items deleted in between.

    Args:
        requirements: Seed items with deterministic ids.
        deadline: ``time.monotonic()`` value after which the load stops
            (``DeadlineExceededError``) without writing the marker.

    Returns:
        Number of items inserted.
    """
    settings = table(SETTINGS_TABLE_ENV)
    if settings.get_item(Key={"id": SEED_MARKER_ID}, ConsistentRead=True).get("Item"):
        logger.info("Requirements seed already applied")
        return 0

    inserted = 0
    requirements_table = table(REQUIREMENTS_TABLE_ENV)
    for requirement in requirements:
        if put_if_absent(requirements_table, _to_item(requirement), deadline=deadline):
            inserted += 1
    put_if_absent(settings, {"id": SEED_MARKER_ID}, deadline=deadline)
    logger.info("Seeded %d requirements", inserted)
    return inserted
