"""Persistence of belt requirements in the ``Requirements`` table.

Keys: PK ``id``; GSI ``by_belt`` (PK ``belt_id``, SK ``sort_order``) lists a
belt's items in sheet order.
"""

import logging
from collections.abc import Iterable
from typing import Any

from boto3.dynamodb.conditions import Key

from domain.requirements import Requirement, RequirementKind
from repository.tables import (
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    paginate,
    put_if_absent,
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
    item = table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": requirement_id}).get("Item")
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
    """Replace an existing item."""
    table(REQUIREMENTS_TABLE_ENV).put_item(
        Item=_to_item(requirement), ConditionExpression="attribute_exists(id)"
    )


def delete_requirement(requirement_id: str) -> None:
    """Delete an item by id."""
    table(REQUIREMENTS_TABLE_ENV).delete_item(Key={"id": requirement_id})


def seed_requirements(requirements: Iterable[Requirement], *, deadline: float | None = None) -> int:
    """Load the initial items once, never duplicating or overwriting screen edits.

    A marker in the settings table records that the load finished, so items
    deleted by an examiner are not recreated on the next deploy. If a previous
    run stopped midway, the conditional writes only add the missing items.
    Throttled writes (low provisioned capacity) are retried with backoff.

    Args:
        requirements: Seed items with deterministic ids.
        deadline: ``time.monotonic()`` value after which the load stops
            (``DeadlineExceededError``) without writing the marker.

    Returns:
        Number of items inserted.
    """
    settings = table(SETTINGS_TABLE_ENV)
    if settings.get_item(Key={"id": SEED_MARKER_ID}).get("Item"):
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
