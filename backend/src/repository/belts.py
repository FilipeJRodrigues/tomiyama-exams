"""Persistence of belts in the ``Belts`` table (PK ``id``)."""

import logging
from collections.abc import Iterable
from typing import Any

from domain.belts import Belt, BeltLevel, sort_belts
from repository.tables import BELTS_TABLE_ENV, paginate, put_if_absent, table

logger = logging.getLogger(__name__)


def _to_item(belt: Belt) -> dict[str, Any]:
    item = belt.to_dict()
    return {key: value for key, value in item.items() if value is not None}


def _from_item(item: dict[str, Any]) -> Belt:
    kyu = item.get("kyu")
    return Belt(
        id=item["id"],
        name=item["name"],
        kyu=int(kyu) if kyu is not None else None,
        sort_order=int(item["sort_order"]),
        level=BeltLevel(item["level"]),
        min_age_years=int(item["min_age_years"]),
        min_months_previous=int(item["min_months_previous"]),
        color_primary=item["color_primary"],
        color_secondary=item.get("color_secondary"),
    )


def list_belts() -> list[Belt]:
    """Return every belt in graduation order (small table, read with a scan)."""
    items = paginate(table(BELTS_TABLE_ENV).scan)
    return sort_belts(_from_item(item) for item in items)


def get_belt(belt_id: str) -> Belt | None:
    """Return a belt by id, or None."""
    item = table(BELTS_TABLE_ENV).get_item(Key={"id": belt_id}).get("Item")
    return _from_item(item) if item else None


def save_belt(belt: Belt) -> None:
    """Replace an existing belt."""
    table(BELTS_TABLE_ENV).put_item(Item=_to_item(belt), ConditionExpression="attribute_exists(id)")


def seed_belts(belts: Iterable[Belt], *, deadline: float | None = None) -> int:
    """Insert belts that do not exist yet, never overwriting screen edits.

    Throttled writes (low provisioned capacity) are retried with backoff.

    Args:
        belts: Seed belts with deterministic ids.
        deadline: ``time.monotonic()`` value after which the load stops
            (``DeadlineExceededError``).

    Returns:
        Number of belts inserted.
    """
    inserted = 0
    belts_table = table(BELTS_TABLE_ENV)
    for belt in belts:
        if put_if_absent(belts_table, _to_item(belt), deadline=deadline):
            inserted += 1
    logger.info("Seeded %d belts", inserted)
    return inserted
