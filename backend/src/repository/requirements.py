"""Persistence of belt requirements in the ``Requirements`` table.

Keys: PK ``id``; GSI ``by_belt`` (PK ``belt_id``, SK ``sort_order``) lists a
belt's items in sheet order, of every profile; GSI ``by_profile_belt`` (PK
``profile_belt`` = ``<profile_id>#<belt_id>``, SK ``sort_order``) lists the
items of one profile in a belt. The ``answer_count`` attribute is kept by the
answer transactions (``repository.answers``); while it is above zero the item
cannot be deleted nor change its belt or kind.

Items written before requirement profiles existed have neither
``profile_id`` nor ``profile_belt``: they are read as items of the main
profile, and ``migrate_to_main_profile`` (v1, run by the ``InitialData``
custom resource) writes both attributes on them. The v2 migration
(``migrate_profile_belts``, run right after it) checks every item again and
fixes the ones still without a profile or whose ``profile_belt`` is not
``<profile_id>#<belt_id>`` (moved to another belt by code from before
profiles, or skipped by v1), waits for ``by_profile_belt`` to be ``ACTIVE``
and only then writes its marker.

Every profile is read through ``by_profile_belt``. The main profile only
once the v2 marker is seen (``profile_index_complete``): until then (the
deploy that runs the migrations, with the new code already answering) it is
read the way that never leaves an item out, ``by_belt`` filtered by profile
or, without a belt, a ``Scan`` of the table. The other profiles never need
it: their items are always written with ``profile_belt``.

Copies of a profile (``put_copy``) are written by the background copy
(``handlers.requirement_profile_copy``), one conditional ``PutItem`` each.
The items of a profile being deleted (``delete_profile_item``) are deleted by
the background deletion (``handlers.requirement_profile_delete``), one
conditional ``DeleteItem`` each.
"""

import logging
import time
from collections.abc import Callable, Iterable
from enum import StrEnum
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from domain.errors import ConflictError, NotFoundError
from domain.requirement_profiles import (
    MAIN_PROFILE_ID,
    profile_attributes_to_fix,
    profile_belt_key,
)
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
    DeadlineExceededError,
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
# Written once by the v2 migration: from then on every item, the main ones
# included, is in ``by_profile_belt`` under its current belt. Never deleted
# while this code runs (only by hand, before deploying it again after a
# rollback to code from before profiles; see backend/README.md).
PROFILE_BELT_MIGRATION_MARKER_ID = "migration:requirements:profile-belt:v2"
# Items read per page of the migration scan, to spread its reads (~5 RCU a page).
MIGRATION_PAGE_SIZE = 100
# Seconds between two checks of the status of ``by_profile_belt`` while it is
# being built (CloudFormation does not wait for a new GSI to be ``ACTIVE``).
INDEX_POLL_SECONDS = 10

# Whether this container has seen the v2 marker (``profile_index_complete``).
# Only ``True`` is kept: the marker is not deleted while this code runs, so
# once seen it stays (a container ends with its code version).
_profile_index_seen = False


def reset_cache() -> None:
    """Forget the v2 marker seen by this container (used by tests between mocked tables)."""
    global _profile_index_seen
    _profile_index_seen = False


def profile_index_complete() -> bool:
    """Return whether the v2 migration finished, so the main profile may use ``by_profile_belt``.

    Reads the marker in ``Settings`` until it is seen, then keeps the answer
    in memory for the life of the container (the marker is not deleted while
    this code runs).
    The read is eventually consistent (0.5 RCU): it can miss a marker written
    a moment ago, never see one that is not there, and missing it only keeps
    the complete fallback (``by_belt`` or the table) one request longer.

    Raises:
        ServiceUnavailableError: If ``Settings`` kept throttling (503).
    """
    global _profile_index_seen
    if not _profile_index_seen:
        item = get_item_or_busy(
            table(SETTINGS_TABLE_ENV),
            {"id": PROFILE_BELT_MIGRATION_MARKER_ID},
            ProjectionExpression="#id",
            ExpressionAttributeNames={"#id": "id"},
        )
        _profile_index_seen = item is not None
    return _profile_index_seen


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


def _query_profile_belt(profile_id: str, belt_id: str) -> list[Requirement]:
    """Return the items of one profile in a belt from ``by_profile_belt``, in sheet order."""
    items = paginate(
        table(REQUIREMENTS_TABLE_ENV).query,
        IndexName=BY_PROFILE_BELT_INDEX,
        KeyConditionExpression=Key(PROFILE_BELT).eq(profile_belt_key(profile_id, belt_id)),
    )
    return [_from_item(item) for item in items]


def _needs_fallback(profile_id: str) -> bool:
    """Whether the items of ``profile_id`` may still be missing from ``by_profile_belt``.

    Only the main profile, and only until the v2 migration finished.
    """
    return profile_id == MAIN_PROFILE_ID and not profile_index_complete()


def list_profile_belt(profile_id: str, belt_id: str) -> list[Requirement]:
    """Return the items of one profile in a belt, in sheet order (no page limit cuts it).

    One query on ``by_profile_belt``, which reads only this profile's items
    of the belt. Until the v2 migration finished, the main profile is read
    from ``by_belt`` instead (every profile's items of the belt, the ones
    without ``profile_id`` counted as main), so the list is never missing an
    item not migrated yet.

    Raises:
        ServiceUnavailableError: If a page or the marker read kept throttling (503).
    """
    if _needs_fallback(profile_id):
        return [item for item in list_by_belt(belt_id) if item.profile_id == MAIN_PROFILE_ID]
    return _query_profile_belt(profile_id, belt_id)


def list_profile_belts(profile_id: str, belt_ids: Iterable[str]) -> list[Requirement]:
    """Return every item of one profile in the given belts, belt by belt.

    One query on ``by_profile_belt`` per belt, which reads only this
    profile's items, whatever the size of the other profiles. Until the v2
    migration finished, the main profile is read with one ``Scan`` of the
    table instead (the marker is read once for all belts).

    Raises:
        ServiceUnavailableError: If a page or the marker read kept throttling (503).
    """
    wanted = list(belt_ids)
    if _needs_fallback(profile_id):
        belts = set(wanted)
        return [
            item
            for item in list_all()
            if item.profile_id == MAIN_PROFILE_ID and item.belt_id in belts
        ]
    return [item for belt_id in wanted for item in _query_profile_belt(profile_id, belt_id)]


def list_all() -> list[Requirement]:
    """Return every item of every belt and profile (unordered)."""
    return [_from_item(item) for item in paginate(table(REQUIREMENTS_TABLE_ENV).scan)]


def list_by_profile(profile_id: str) -> list[Requirement]:
    """Return every item of one profile, of every belt (unordered), with a ``Scan``.

    Reads the whole table (every profile), so no route uses it: they read a
    profile belt by belt (``list_profile_belts``). Items without
    ``profile_id`` count as main.
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


def put_copy(
    requirement: Requirement,
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Insert an item copied into a profile, unless it is already there.

    The copy has a deterministic id (``copied_requirement_id``), so the
    conditional write makes a repeated copy harmless; it never carries
    ``answer_count``. Throttling and transaction conflicts are retried until
    ``deadline`` (``retry_throttled``; ``sleep`` and ``clock`` injected for tests).

    Returns:
        True if inserted, False if the item already existed.

    Raises:
        DeadlineExceededError: Still throttled when the deadline passed.
    """
    return put_if_absent(
        table(REQUIREMENTS_TABLE_ENV),
        _to_item(requirement),
        deadline=deadline,
        sleep=sleep,
        clock=clock,
    )


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


def list_stored_profile_belt_ids(profile_id: str, belt_id: str) -> list[str]:
    """Return the ids of the items of a **stored** profile in a belt (``by_profile_belt``).

    For the background deletion of a profile. Always the index, never the
    fallback of the main profile: the items of every other profile are
    written with ``profile_belt``. The read is eventually consistent, as
    every read of a GSI: an item written or deleted a moment ago may be
    missing or still listed, so the caller reads again before it concludes
    that nothing is left.

    Raises:
        ValueError: If ``profile_id`` is the main profile (never deleted).
        ServiceUnavailableError: If a page kept throttling (503).
    """
    if profile_id == MAIN_PROFILE_ID:
        raise ValueError("The items of the main profile are never deleted in bulk")
    items = paginate(
        table(REQUIREMENTS_TABLE_ENV).query,
        IndexName=BY_PROFILE_BELT_INDEX,
        KeyConditionExpression=Key(PROFILE_BELT).eq(profile_belt_key(profile_id, belt_id)),
        ProjectionExpression="#id",
        ExpressionAttributeNames={"#id": "id"},
    )
    return [item["id"] for item in items]


class ProfileItemDeletion(StrEnum):
    """What ``delete_profile_item`` did with one item."""

    DELETED = "DELETED"
    # Not there any more (already deleted; the index still listed it).
    GONE = "GONE"
    # Kept: an exam has an answer for it, which a profile no event uses should not have.
    HAS_ANSWERS = "HAS_ANSWERS"
    # Kept: the stored item belongs to another profile.
    OTHER_PROFILE = "OTHER_PROFILE"


def delete_profile_item(
    requirement_id: str,
    profile_id: str,
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> ProfileItemDeletion:
    """Delete one item of a profile being deleted, only if it is of that profile and has no answers.

    Both are conditions of the ``DeleteItem`` itself, read on the stored item
    (the index does not carry ``answer_count``): an item of another profile
    is never deleted, whatever the index listed, and neither is an item with
    answers. Throttling and transaction conflicts are retried until
    ``deadline`` (``retry_throttled``; ``sleep`` and ``clock`` injected for tests).

    Raises:
        ValueError: If ``profile_id`` is the main profile.
        DeadlineExceededError: Still throttled when the deadline passed.
    """
    if profile_id == MAIN_PROFILE_ID:
        raise ValueError("The items of the main profile are never deleted in bulk")
    target = table(REQUIREMENTS_TABLE_ENV)
    try:
        retry_throttled(
            lambda: target.delete_item(
                Key={"id": requirement_id},
                ConditionExpression=f"#profile = :profile AND ({NO_ANSWERS_CONDITION})",
                ExpressionAttributeNames={"#profile": "profile_id"},
                ExpressionAttributeValues={":profile": profile_id, ":zero": 0},
                ReturnValuesOnConditionCheckFailure="ALL_OLD",
            ),
            f"deleting {requirement_id!r} of profile {profile_id!r}",
            deadline=deadline,
            sleep=sleep,
            clock=clock,
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        # The stored item, in DynamoDB's typed JSON ({"profile_id": {"S": ...}}).
        stored = exc.response.get("Item")
        if not stored:
            return ProfileItemDeletion.GONE
        if stored.get("profile_id", {}).get("S") != profile_id:
            return ProfileItemDeletion.OTHER_PROFILE
        return ProfileItemDeletion.HAS_ANSWERS
    return ProfileItemDeletion.DELETED


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


_PROFILE_ATTRIBUTE_NAMES = {
    "#id": "id",
    "#belt": "belt_id",
    "#profile": "profile_id",
    "#profile_belt": PROFILE_BELT,
}
_PROFILE_ATTRIBUTES_PROJECTION = "#id, #belt, #profile, #profile_belt"


def migrate_profile_belts(*, deadline: float | None = None) -> int:
    """Check every item's profile attributes once and fix them (v2 migration, #144).

    Fixes (a) items still without ``profile_id`` (they go to the main
    profile) and (b) items whose ``profile_belt`` is missing or is not
    ``<profile_id>#<belt_id>`` (moved to another belt by code from before
    profiles, during a deploy or after a rollback, or skipped by v1 because
    the belt changed between its scan and its write). Each fix is an
    ``UpdateItem`` of those two attributes only, conditioned on the item
    still having the values read (``belt_id``, ``profile_id`` and
    ``profile_belt``, or their absence): the rest of the item
    (``answer_count`` included) never changes, and an item deleted meanwhile
    is not recreated. If the item changed between the read and the write, it
    is read again (consistent) and fixed again if still needed, so the
    marker is never written over an item left wrong.

    Then it waits for ``by_profile_belt`` to be ``ACTIVE`` (CloudFormation
    does not wait for a new GSI to be built) and writes the marker
    ``PROFILE_BELT_MIGRATION_MARKER_ID``: from then on the main profile is
    read through ``by_profile_belt`` (``profile_index_complete``). Later
    deploys skip it (marker read with ``ConsistentRead``). A run that stops
    (deadline or error) writes no marker, and the next one checks again.
    Throttled pages, reads and writes and writes that meet a marking in
    progress (``TransactionConflictException``) are retried with backoff
    until ``deadline``.

    Args:
        deadline: ``time.monotonic()`` value after which the migration stops
            (``DeadlineExceededError``) without writing the marker.

    Returns:
        Number of items fixed.
    """
    settings = table(SETTINGS_TABLE_ENV)
    marker = settings.get_item(Key={"id": PROFILE_BELT_MIGRATION_MARKER_ID}, ConsistentRead=True)
    if marker.get("Item"):
        logger.info("Requirements profile_belt migration already applied")
        return 0

    requirements_table = table(REQUIREMENTS_TABLE_ENV)
    scan_arguments: dict[str, Any] = {
        "Limit": MIGRATION_PAGE_SIZE,
        "ProjectionExpression": _PROFILE_ATTRIBUTES_PROJECTION,
        "ExpressionAttributeNames": dict(_PROFILE_ATTRIBUTE_NAMES),
    }
    fixed = 0
    while True:
        page = retry_throttled(
            lambda: requirements_table.scan(**scan_arguments),
            "scanning Requirements for the profile_belt migration",
            deadline=deadline,
        )
        for item in page.get("Items", []):
            if _fix_profile_attributes(requirements_table, item, deadline):
                fixed += 1
        last_key = page.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_arguments["ExclusiveStartKey"] = last_key
    wait_for_profile_index(deadline=deadline)
    put_if_absent(settings, {"id": PROFILE_BELT_MIGRATION_MARKER_ID}, deadline=deadline)
    logger.info("Fixed the profile attributes of %d requirements", fixed)
    return fixed


def _fix_profile_attributes(target: Any, item: dict[str, Any], deadline: float | None) -> bool:
    """Write the right ``profile_id`` and ``profile_belt`` on one item, if wrong.

    Returns:
        True if this call wrote the item; False if it was already right (or
        was made right by someone else meanwhile) or was deleted meanwhile.
    """
    key = {"id": item["id"]}
    while True:
        fix = profile_attributes_to_fix(
            item.get("profile_id"), item.get(PROFILE_BELT), item["belt_id"]
        )
        if fix is None:
            return False
        if _write_profile_attributes(target, item, fix, deadline):
            return True
        # Changed between the read and the write: look again at what is stored now.
        fresh = retry_throttled(
            lambda: target.get_item(
                Key=key,
                ConsistentRead=True,
                ProjectionExpression=_PROFILE_ATTRIBUTES_PROJECTION,
                ExpressionAttributeNames=dict(_PROFILE_ATTRIBUTE_NAMES),
            ),
            f"reading {key['id']!r} again for the profile_belt migration",
            deadline=deadline,
        ).get("Item")
        if fresh is None:
            return False
        item = fresh


def _write_profile_attributes(
    target: Any, item: dict[str, Any], fix: tuple[str, str], deadline: float | None
) -> bool:
    """Conditional ``UpdateItem`` of the two profile attributes; False if the item changed.

    The condition requires the item to exist with the ``belt_id``,
    ``profile_id`` and ``profile_belt`` read (an absent attribute must still
    be absent). A ``TransactionConflictException`` (a marking holding the
    item, RN006) is retried by ``retry_throttled`` like throttling.
    """
    profile_id, profile_belt = fix
    names = {"#belt": "belt_id", "#profile": "profile_id", "#profile_belt": PROFILE_BELT}
    values: dict[str, Any] = {
        ":profile": profile_id,
        ":profile_belt": profile_belt,
        ":belt": item["belt_id"],
    }
    conditions = ["attribute_exists(id)", "#belt = :belt"]
    for name, attribute in (("#profile", "profile_id"), ("#profile_belt", PROFILE_BELT)):
        if attribute in item:
            placeholder = f":read_{attribute}"
            conditions.append(f"{name} = {placeholder}")
            values[placeholder] = item[attribute]
        else:
            conditions.append(f"attribute_not_exists({name})")
    try:
        retry_throttled(
            lambda: target.update_item(
                Key={"id": item["id"]},
                UpdateExpression="SET #profile = :profile, #profile_belt = :profile_belt",
                ConditionExpression=" AND ".join(conditions),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            ),
            f"fixing the profile attributes of {item['id']!r}",
            deadline=deadline,
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def wait_for_profile_index(
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Return once ``by_profile_belt`` is ``ACTIVE`` (built and readable).

    When a deploy adds the index, CloudFormation goes on without waiting for
    DynamoDB to build it, and a query on an index still being built fails.
    The v2 marker switches the main profile to the index, so it is written
    only after this. Checked with ``DescribeTable`` every
    ``INDEX_POLL_SECONDS`` (``sleep`` and ``clock`` injected for tests).

    Raises:
        DeadlineExceededError: Still not ``ACTIVE`` when the deadline passed.
        RuntimeError: The table has no such index (the template was not deployed).
    """
    requirements_table = table(REQUIREMENTS_TABLE_ENV)
    client = requirements_table.meta.client
    while True:
        description = retry_throttled(
            lambda: client.describe_table(TableName=requirements_table.name),
            "describing Requirements",
            deadline=deadline,
            sleep=sleep,
            clock=clock,
        )
        status = next(
            (
                index.get("IndexStatus")
                for index in description["Table"].get("GlobalSecondaryIndexes", [])
                if index["IndexName"] == BY_PROFILE_BELT_INDEX
            ),
            None,
        )
        if status is None:
            raise RuntimeError(f"Index {BY_PROFILE_BELT_INDEX} not found on Requirements")
        if status == "ACTIVE":
            return
        if deadline is not None and clock() + INDEX_POLL_SECONDS >= deadline:
            raise DeadlineExceededError(f"Index {BY_PROFILE_BELT_INDEX} still {status}")
        logger.info("Index %s is %s; checking again soon", BY_PROFILE_BELT_INDEX, status)
        sleep(INDEX_POLL_SECONDS)
