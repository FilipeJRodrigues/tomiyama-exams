"""Persistence of belts in the ``Belts`` table (PK ``id``)."""

import logging
from collections.abc import Iterable
from typing import Any

from botocore.exceptions import ClientError

from domain.belts import (
    EXAMINER_EDITABLE_FIELDS,
    MSG_BELT_NOT_FOUND,
    Belt,
    BeltLevel,
    sort_belts,
)
from domain.errors import NotFoundError
from repository.tables import (
    BELTS_TABLE_ENV,
    get_item_or_busy,
    paginate,
    put_if_absent,
    raise_if_throttled,
    table,
)

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


def get_belt(belt_id: str, *, consistent: bool = False) -> Belt | None:
    """Return a belt by id, or None.

    Args:
        belt_id: Belt id.
        consistent: True for a strongly consistent read (``ConsistentRead``),
            when the belt decides the answer (404 or 403 of ``PUT /belts/{id}``);
            the exam sheet only shows it and reads it eventually consistent.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    options = {"ConsistentRead": True} if consistent else {}
    item = get_item_or_busy(table(BELTS_TABLE_ENV), {"id": belt_id}, **options)
    return _from_item(item) if item else None


def save_belt(belt: Belt) -> None:
    """Replace an existing belt.

    Raises:
        ServiceUnavailableError: If the write kept throttling (503).
    """
    try:
        table(BELTS_TABLE_ENV).put_item(
            Item=_to_item(belt), ConditionExpression="attribute_exists(id)"
        )
    except ClientError as exc:
        raise_if_throttled(exc, "PutItem on Belts")
        raise


def save_examiner_fields(belt: Belt) -> Belt:
    """Write only the fields any examiner may change (RN001, RN002) and return the stored belt.

    The ``UpdateItem`` sets only ``min_age_years`` and ``min_months_previous``,
    so a concurrent edit of the other fields by the admin master (name, order,
    colours...) is never undone by values read before it. It only writes if
    the belt still exists, so no partial item is ever created.

    Args:
        belt: Belt with the new numbers (other fields are ignored).

    Returns:
        The belt as stored after the write (``ReturnValues=ALL_NEW``).

    Raises:
        NotFoundError: If the belt no longer exists.
        ServiceUnavailableError: If the write kept throttling (503).
    """
    values = belt.to_dict()
    names = {f"#f{index}": field for index, field in enumerate(EXAMINER_EDITABLE_FIELDS)}
    try:
        response = table(BELTS_TABLE_ENV).update_item(
            Key={"id": belt.id},
            UpdateExpression="SET " + ", ".join(f"{name} = :{name[1:]}" for name in names),
            ConditionExpression="attribute_exists(id)",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues={
                f":{name[1:]}": values[field] for name, field in names.items()
            },
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise NotFoundError(MSG_BELT_NOT_FOUND) from exc
        raise_if_throttled(exc, "UpdateItem on Belts")
        raise
    return _from_item(response["Attributes"])


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
