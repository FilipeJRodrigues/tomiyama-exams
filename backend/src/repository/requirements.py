"""Persistence of belt requirements in the ``Requirements`` table.

Keys: PK ``id``; GSI ``by_belt`` (PK ``belt_id``, SK ``sort_order``) lists a
belt's items in sheet order, of every profile; GSI ``by_profile_belt`` (PK
``profile_belt`` = ``<profile_id>#<belt_id>``, SK ``sort_order``) lists the
items of one profile in a belt. The ``answer_count`` attribute is kept by the
answer transactions (``repository.answers``); while it is above zero the item
cannot be deleted nor change its belt or kind.

Items written before requirement profiles existed have neither
``profile_id`` nor ``profile_belt``: they are read as items of the main
profile, and ``migrate_to_main_profile`` (run by the ``InitialData`` custom
resource) writes both attributes on them. Until the exam sheet moves to
``by_profile_belt`` (and ``by_belt`` is dropped), the main profile is listed
through ``by_belt`` and the table, so an item not migrated yet is never left
out of the list.
"""

import logging
from collections.abc import Iterable
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from domain.errors import ConflictError, NotFoundError
from domain.requirement_profiles import MAIN_PROFILE_ID, profile_belt_key
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
    get_item_or_busy,
    paginate,
    put_if_absent,
    raise_if_throttled,
    replace_fields,
    retry_throttled,
    table,
)

logger = logging.getLogger(__name__)

BY_BELT_INDEX = "by_belt"
BY_PROFILE_BELT_INDEX = "by_profile_belt"
PROFILE_BELT = "profile_belt"
SEED_MARKER_ID = "seed:requirements:v1"
PROFILE_MIGRATION_MARKER_ID = "migration:requirements:main-profile:v1"
# Items read per page of the migration scan, to spread its reads (~5 RCU a page).
MIGRATION_PAGE_SIZE = 100


def _attributes(requirement: Requirement) -> dict[str, Any]:
    """Every stored attribute of the model, ``profile_belt`` included (None = absent)."""
    return {
        **requirement.to_dict(),
        PROFILE_BELT: profile_belt_key(requirement.profile_id, requirement.belt_id),
    }


def _to_item(requirement: Requirement) -> dict[str, Any]:
    return {key: value for key, value in _attributes(requirement).items() if value is not None}


def _from_item(item: dict[str, Any]) -> Requirement:
    return Requirement(
        id=item["id"],
        belt_id=item["belt_id"],
        kind=RequirementKind(item["kind"]),
        category=item["category"],
        description=item["description"],
        expected_answer=item.get("expected_answer"),
        sort_order=int(item["sort_order"]),
        profile_id=item.get("profile_id") or MAIN_PROFILE_ID,
    )


def get_requirement(requirement_id: str) -> Requirement | None:
    """Return an item by id, or None (strongly consistent).

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    item = get_item_or_busy(
        table(REQUIREMENTS_TABLE_ENV), {"id": requirement_id}, ConsistentRead=True
    )
    return _from_item(item) if item else None


def list_by_belt(belt_id: str) -> list[Requirement]:
    """Return every item of a belt, of every profile, in sheet order (no page limit cuts it)."""
    items = paginate(
        table(REQUIREMENTS_TABLE_ENV).query,
        IndexName=BY_BELT_INDEX,
        KeyConditionExpression=Key("belt_id").eq(belt_id),
    )
    return [_from_item(item) for item in items]


def list_profile_belt(profile_id: str, belt_id: str) -> list[Requirement]:
    """Return the items of one profile in a belt, in sheet order (no page limit cuts it).

    The main profile is read through ``by_belt`` (items without ``profile_id``
    count as main), so the list is complete before and during the migration;
    other profiles come from ``by_profile_belt``.
    """
    if profile_id == MAIN_PROFILE_ID:
        return [item for item in list_by_belt(belt_id) if item.profile_id == MAIN_PROFILE_ID]
    items = paginate(
        table(REQUIREMENTS_TABLE_ENV).query,
        IndexName=BY_PROFILE_BELT_INDEX,
        KeyConditionExpression=Key(PROFILE_BELT).eq(profile_belt_key(profile_id, belt_id)),
    )
    return [_from_item(item) for item in items]


def list_all() -> list[Requirement]:
    """Return every item of every belt and profile (unordered)."""
    return [_from_item(item) for item in paginate(table(REQUIREMENTS_TABLE_ENV).scan)]


def list_by_profile(profile_id: str) -> list[Requirement]:
    """Return every item of one profile, of every belt (unordered).

    Items without ``profile_id`` count as main (see ``list_profile_belt``).
    """
    return [item for item in list_all() if item.profile_id == profile_id]


def create_requirement(requirement: Requirement) -> None:
    """Insert a new item.

    Raises:
        ServiceUnavailableError: If the write kept throttling (503).
    """
    try:
        table(REQUIREMENTS_TABLE_ENV).put_item(
            Item=_to_item(requirement), ConditionExpression="attribute_not_exists(id)"
        )
    except ClientError as exc:
        raise_if_throttled(exc, "PutItem on Requirements")
        raise


def save_requirement(requirement: Requirement) -> None:
    """Rewrite an existing item's attributes, keeping its ``answer_count``.

    ``profile_id`` and ``profile_belt`` are written too: the caller keeps the
    stored profile (it never changes), and an item written before profiles
    existed gets both attributes of the main profile.

    An item with answers keeps its belt and kind (RN017): moving it would drop
    the answers from the exam sheet and score (RN006/RN007) and make them
    impossible to unmark. The lock compares the stored values with the new ones
    in the write's own condition, so resending the same belt and kind passes,
    and a first answer committed after the handler's read still blocks a move.

    Raises:
        NotFoundError: If the item was deleted meanwhile.
        ConflictError: If the item has answers and the belt or kind changes.
        ServiceUnavailableError: If the write, or the re-read after a failed
            condition, kept throttling (503).
    """
    arguments = replace_fields(_attributes(requirement))
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
            raise_if_throttled(exc, "UpdateItem on Requirements")
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
        ServiceUnavailableError: If the delete kept throttling (503).
    """
    try:
        table(REQUIREMENTS_TABLE_ENV).delete_item(
            Key={"id": requirement_id},
            ConditionExpression=NO_ANSWERS_CONDITION,
            ExpressionAttributeValues={":zero": 0},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise_if_throttled(exc, "DeleteItem on Requirements")
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


def migrate_to_main_profile(*, deadline: float | None = None) -> int:
    """Put the items written before profiles existed in the main profile, once.

    Each item without ``profile_id`` gets ``profile_id = main`` and its
    ``profile_belt``, in an ``UpdateItem`` that touches only those two
    attributes and only while the item exists, still has no profile and
    still has the belt read by the scan: the rest of the item
    (``answer_count`` included) and the exams and answers are never changed,
    an item deleted meanwhile is not recreated, and an item already in a
    profile or moved to another belt meanwhile is skipped. A marker in the settings table
    records that the migration finished, so later deploys skip it (read with
    ``ConsistentRead``, as the seed marker). If a run stops midway (deadline
    or error), the next one scans again and updates only what is missing.
    Throttled pages and writes, and writes that meet a marking in progress on
    the same item (``TransactionConflictException``), are retried with
    backoff until ``deadline``.

    Args:
        deadline: ``time.monotonic()`` value after which the migration stops
            (``DeadlineExceededError``) without writing the marker.

    Returns:
        Number of items moved to the main profile.
    """
    settings = table(SETTINGS_TABLE_ENV)
    if settings.get_item(Key={"id": PROFILE_MIGRATION_MARKER_ID}, ConsistentRead=True).get("Item"):
        logger.info("Requirements profile migration already applied")
        return 0

    requirements_table = table(REQUIREMENTS_TABLE_ENV)
    scan_arguments: dict[str, Any] = {
        "Limit": MIGRATION_PAGE_SIZE,
        "ProjectionExpression": "#id, #belt, #profile",
        "ExpressionAttributeNames": {"#id": "id", "#belt": "belt_id", "#profile": "profile_id"},
    }
    migrated = 0
    while True:
        page = retry_throttled(
            lambda: requirements_table.scan(**scan_arguments),
            "scanning Requirements for the profile migration",
            deadline=deadline,
        )
        for item in page.get("Items", []):
            if "profile_id" not in item and _move_to_main_profile(
                requirements_table, item, deadline
            ):
                migrated += 1
        last_key = page.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_arguments["ExclusiveStartKey"] = last_key
    put_if_absent(settings, {"id": PROFILE_MIGRATION_MARKER_ID}, deadline=deadline)
    logger.info("Moved %d requirements to the main profile", migrated)
    return migrated


def _move_to_main_profile(target: Any, item: dict[str, Any], deadline: float | None) -> bool:
    """Write the main profile on one item; False if it changed meanwhile.

    The write is conditioned on the item still existing, still having no
    profile and still having the belt read by the scan, so ``profile_belt``
    always matches ``belt_id`` (code from before profiles, still running
    during the deploy, may move the item to another belt between the scan and
    this write). A skipped item keeps no profile: it is still read as a main
    item (through ``by_belt``) and gets its profile on its next edit. A
    ``TransactionConflictException`` (a marking holding the item, RN006) is
    retried by ``retry_throttled`` like throttling.
    """
    try:
        retry_throttled(
            lambda: target.update_item(
                Key={"id": item["id"]},
                UpdateExpression="SET #profile = :profile, #profile_belt = :profile_belt",
                ConditionExpression=(
                    "attribute_exists(id) AND attribute_not_exists(#profile) AND #belt = :belt"
                ),
                ExpressionAttributeNames={
                    "#profile": "profile_id",
                    "#profile_belt": PROFILE_BELT,
                    "#belt": "belt_id",
                },
                ExpressionAttributeValues={
                    ":profile": MAIN_PROFILE_ID,
                    ":profile_belt": profile_belt_key(MAIN_PROFILE_ID, item["belt_id"]),
                    ":belt": item["belt_id"],
                },
            ),
            f"moving {item['id']!r} to the main profile",
            deadline=deadline,
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True
