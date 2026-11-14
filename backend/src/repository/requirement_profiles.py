"""Persistence of the requirement profiles (RN017, #144): one item in ``Settings``.

The item ``id = "requirement_profiles"`` holds ``profiles``, a map from each
profile id to its fields (``RequirementProfile.to_item``), and ``version``, a
number bumped by every change of the names and of who may be copied (create,
rename, the mark of a deletion and the removal of a deleted profile). The
main profile is never stored.

Why one item: listing the profiles is a single ``GetItem`` (no ``Scan``,
which IAM cannot limit to some items of the table, and the table also holds
the settings record and the certificate signatures); every function reaches
only this item (``dynamodb:LeadingKeys``); and names stay unique, and the
number of profiles within ``MAX_PROFILES``, under concurrent requests,
because a create or rename is written only if ``version`` is still the one
read (otherwise it reads again and re-checks, like the signatures list). The
item stays small: a profile takes ~300 bytes, far from the 400 KB limit.

Every write touches only its own paths (``profiles.<id>`` or below), so the
copy's progress and status, written without the version, never undo a
rename, and a rename never brings back an old status.

The copy itself runs in another function, started here with an asynchronous
``Invoke`` (``start_copy``).

**Deletion** (``begin_deletion`` and the functions after it). The profile
first goes to ``DELETING`` in a write conditioned on ``version`` and on the
status read, so it disputes the same ``version`` as a create: a new profile
copying from this one is either stored first (and the deletion, reading
again, is refused) or reads the profile already ``DELETING`` (and is
refused). Only then does the route read the events
(``repository.events.any_event_uses_profile``): no event starts using a
profile that is not ``READY``, so that read finds every event that uses it.
An event found puts the profile back (``cancel_deletion``); none found sets
``delete_checked`` (``confirm_deletion``), after which the deletion is never
cancelled, and the items are deleted by another function (``start_deletion``),
which at the end takes the profile out of the map (``remove_profile``).

**The mark has an identity.** Every write of ``DELETING`` stores a new random
``delete_mark``, and ``cancel_deletion`` and ``confirm_deletion`` are
conditioned on the mark the request held **when it read the events**. A read
of the events proves "no event uses the profile" only while the profile
stayed ``DELETING`` since before that read; a mark undone and written again
meanwhile (the profile was ``READY`` in between and an event may have chosen
it) has another ``delete_mark``, so a request with the old read neither
confirms nor undoes it. A random token, not ``version``: ``version`` is also
bumped by a create or a rename of **another** profile, which would make a
legitimate confirmation fail for no reason; and not ``delete_updated_at``,
whose whole seconds repeat for two marks written in the same second.
"""

import json
import logging
import os
import random
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from domain.errors import ConflictError
from domain.requirement_profiles import (
    MSG_PROFILES_BUSY,
    ProfileStatus,
    RequirementProfile,
    stall_threshold,
)
from repository.tables import (
    SETTINGS_TABLE_ENV,
    get_item_or_busy,
    raise_if_throttled,
    retry_throttled,
    table,
)

logger = logging.getLogger(__name__)

REQUIREMENT_PROFILES_ID = "requirement_profiles"
# Name of the copy function, set by SAM on the functions that start a copy.
COPY_FUNCTION_ENV = "REQUIREMENT_PROFILE_COPY_FUNCTION"
# Name of the function that deletes a profile's items, set by SAM on the
# function of ``DELETE /requirement-profiles/{id}``.
DELETE_FUNCTION_ENV = "REQUIREMENT_PROFILE_DELETE_FUNCTION"

# A create or rename is re-applied on a fresh read this many times before giving up.
_MAX_ATTEMPTS = 5
_BACKOFF_SECONDS = 0.05
# A write that meets a transaction holding the profiles item (an event that
# chooses a profile checks it there, ``ready_condition_check``) is tried this
# many times, a few tens of milliseconds apart, before answering 409.
_CONFLICT_ATTEMPTS = 4
_TRANSACTION_CONFLICT = "TransactionConflictException"

_PROFILES = "profiles"
_VERSION = "version"


@dataclass(frozen=True)
class StoredProfiles:
    """The stored profiles (the main one is not stored) and the names' version."""

    version: int
    profiles: Mapping[str, RequirementProfile]


EMPTY = StoredProfiles(version=0, profiles={})


class _StaleVersionError(Exception):
    """The names changed between the read and the write (another request won)."""


def _parse(item: Mapping[str, Any] | None) -> StoredProfiles:
    if not item:
        return EMPTY
    profiles = {
        profile_id: RequirementProfile.from_item(profile_id, fields)
        for profile_id, fields in (item.get(_PROFILES) or {}).items()
    }
    return StoredProfiles(version=int(item.get(_VERSION, 0)), profiles=profiles)


def get_profiles() -> StoredProfiles:
    """Return every stored profile, strongly consistent (empty, version 0, before the first).

    Consistent because it decides answers: a profile created a moment ago
    must be found (no 404), and a finished copy must be seen as ``READY``.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    item = get_item_or_busy(
        table(SETTINGS_TABLE_ENV), {"id": REQUIREMENT_PROFILES_ID}, ConsistentRead=True
    )
    return _parse(item)


def get_profile(profile_id: str) -> RequirementProfile | None:
    """Return one stored profile, or None (strongly consistent; never the main one).

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    return get_profiles().profiles.get(profile_id)


def _names(profile_id: str, **fields: str) -> dict[str, str]:
    return {"#profiles": _PROFILES, "#id": profile_id, **fields}


def ready_condition_check(profile_id: str) -> dict[str, Any]:
    """Return the ``ConditionCheck`` of a transaction: the stored profile exists and is ``READY``.

    For a write elsewhere that starts using a stored profile (an event that
    chooses it, ``repository.events``): inside the same transaction, the
    write happens only if, at that instant, ``profiles.<id>.status`` is
    ``READY``. A profile that is missing (or the whole item), still copying
    or in any other status fails the check. Never used for the main profile,
    which is not stored.
    """
    return {
        "ConditionCheck": {
            "TableName": table(SETTINGS_TABLE_ENV).name,
            "Key": {"id": REQUIREMENT_PROFILES_ID},
            "ConditionExpression": "#profiles.#id.#status = :ready",
            "ExpressionAttributeNames": _names(profile_id, **{"#status": "status"}),
            "ExpressionAttributeValues": {":ready": ProfileStatus.READY.value},
        }
    }


def _update(arguments: dict[str, Any], label: str) -> dict[str, Any]:
    """Run an ``UpdateItem`` on the profiles item, answering 503 on persistent throttling.

    A ``TransactionConflictException`` (an event being written is checking a
    profile in this item at this instant) lasts as long as that transaction
    and botocore does not retry it: the write is tried again a few times.

    Raises:
        ServiceUnavailableError: If the table kept throttling.
        ConflictError: If the item was still held by transactions after every attempt.
        ClientError: Any other error (``ConditionalCheckFailedException`` included).
    """
    for attempt in range(_CONFLICT_ATTEMPTS):
        try:
            return table(SETTINGS_TABLE_ENV).update_item(
                Key={"id": REQUIREMENT_PROFILES_ID}, **arguments
            )
        except ClientError as exc:
            raise_if_throttled(exc, label)
            if exc.response["Error"]["Code"] != _TRANSACTION_CONFLICT:
                raise
            logger.info("%s met a transaction; attempt %d", label, attempt + 1)
            if attempt + 1 == _CONFLICT_ATTEMPTS:
                raise ConflictError(MSG_PROFILES_BUSY) from exc
            time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))
    raise AssertionError("unreachable")  # pragma: no cover


def _is_condition_failure(exc: ClientError) -> bool:
    return exc.response["Error"]["Code"] == "ConditionalCheckFailedException"


def _with_version(current: StoredProfiles, arguments: dict[str, Any]) -> dict[str, Any]:
    """Add ``version = version + 1`` and the condition that it is still the one read."""
    arguments["UpdateExpression"] += ", #version = :next_version"
    arguments["ExpressionAttributeNames"]["#version"] = _VERSION
    arguments["ExpressionAttributeValues"][":next_version"] = current.version + 1
    arguments["ExpressionAttributeValues"][":version"] = current.version
    version_condition = "#version = :version"
    existing = arguments.get("ConditionExpression")
    arguments["ConditionExpression"] = (
        f"{version_condition} AND {existing}" if existing else version_condition
    )
    return arguments


def _write_new(current: StoredProfiles, profile: RequirementProfile) -> RequirementProfile:
    """Add ``profile`` if the names are still at ``current.version``.

    Raises:
        _StaleVersionError: If another create or rename won.
        ServiceUnavailableError: If the table kept throttling.
    """
    if current.version == 0:
        # First profile ever: the item does not exist yet (a nested SET needs the map).
        try:
            table(SETTINGS_TABLE_ENV).put_item(
                Item={
                    "id": REQUIREMENT_PROFILES_ID,
                    _VERSION: 1,
                    _PROFILES: {profile.id: profile.to_item()},
                },
                ConditionExpression="attribute_not_exists(id)",
            )
        except ClientError as exc:
            if _is_condition_failure(exc):
                raise _StaleVersionError from exc
            raise_if_throttled(exc, "PutItem on Settings (requirement profiles)")
            raise
        return profile
    arguments = _with_version(
        current,
        {
            "UpdateExpression": "SET #profiles.#id = :profile",
            "ConditionExpression": "attribute_not_exists(#profiles.#id)",
            "ExpressionAttributeNames": _names(profile.id),
            "ExpressionAttributeValues": {":profile": profile.to_item()},
            "ReturnValues": "ALL_NEW",
        },
    )
    try:
        response = _update(arguments, "UpdateItem on Settings (requirement profiles)")
    except ClientError as exc:
        if _is_condition_failure(exc):
            raise _StaleVersionError from exc
        raise
    return _parse(response["Attributes"]).profiles[profile.id]


def _write_name(current: StoredProfiles, profile: RequirementProfile) -> RequirementProfile:
    """Write only the new name of ``profile`` if the names are still at ``current.version``.

    The same name as stored writes nothing.

    Raises:
        _StaleVersionError: If another create or rename won (or the profile is gone).
        ServiceUnavailableError: If the table kept throttling.
    """
    stored = current.profiles[profile.id]
    if stored.name == profile.name:
        return stored
    arguments = _with_version(
        current,
        {
            "UpdateExpression": "SET #profiles.#id.#name = :name",
            "ConditionExpression": "attribute_exists(#profiles.#id)",
            "ExpressionAttributeNames": _names(profile.id, **{"#name": "name"}),
            "ExpressionAttributeValues": {":name": profile.name},
            "ReturnValues": "ALL_NEW",
        },
    )
    try:
        response = _update(arguments, "UpdateItem on Settings (requirement profiles)")
    except ClientError as exc:
        if _is_condition_failure(exc):
            raise _StaleVersionError from exc
        raise
    return _parse(response["Attributes"]).profiles[profile.id]


def _apply(
    change: Callable[[StoredProfiles], RequirementProfile],
    write: Callable[[StoredProfiles, RequirementProfile], RequirementProfile],
    label: str,
) -> RequirementProfile:
    """Run ``change`` on a fresh read and ``write`` its result, again while another write wins.

    Raises:
        DomainError: Whatever ``change`` raised on the fresh read.
        ConflictError: If other writes kept winning on every attempt.
        ServiceUnavailableError: If the table kept throttling.
    """
    for attempt in range(_MAX_ATTEMPTS):
        current = get_profiles()
        profile = change(current)
        try:
            return write(current, profile)
        except _StaleVersionError:
            logger.info("Requirement profiles changed meanwhile (%s); retry %d", label, attempt + 1)
            if attempt + 1 < _MAX_ATTEMPTS:
                time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))
    raise ConflictError(MSG_PROFILES_BUSY)


def create_profile(
    build: Callable[[Mapping[str, RequirementProfile]], RequirementProfile],
) -> RequirementProfile:
    """Store the profile ``build`` returns from the stored ones, keeping names unique.

    ``build`` runs on the same read the write is conditioned on, so whatever
    it checks against the stored profiles (the name, the limit of profiles)
    still holds when the profile is written.

    Args:
        build: Pure function from the stored profiles to the new one; it
            checks the source, the limit and the name and may raise a
            DomainError.

    Returns:
        The profile as stored.

    Raises:
        DomainError: Whatever ``build`` raised on the fresh read.
        ConflictError: If other creates or renames kept winning.
        ServiceUnavailableError: If the table kept throttling.
    """
    return _apply(lambda current: build(current.profiles), _write_new, "create")


def rename_profile(
    rename: Callable[[Mapping[str, RequirementProfile]], RequirementProfile],
) -> RequirementProfile:
    """Write the name of the profile ``rename`` returns, keeping names unique.

    Only the name is written; the same name as stored writes nothing.

    Args:
        rename: Pure function from the stored profiles to the renamed one;
            it checks that the profile exists and the name is free.

    Returns:
        The profile as stored.

    Raises:
        DomainError: Whatever ``rename`` raised on the fresh read.
        ConflictError: If other creates or renames kept winning.
        ServiceUnavailableError: If the table kept throttling.
    """
    return _apply(lambda current: rename(current.profiles), _write_name, "rename")


# --- the copy (written without the version: names do not change) -------------


def _copy_update(
    profile_id: str,
    expression: str,
    condition: str,
    names: dict[str, str],
    values: dict[str, Any],
    label: str,
    *,
    deadline: float | None,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
) -> bool:
    """Run a conditional write on one profile's copy fields, retried while throttled.

    Returns:
        False if the condition failed (the profile is gone or no longer in
        the expected state).
    """
    arguments = {
        "UpdateExpression": expression,
        "ConditionExpression": condition,
        "ExpressionAttributeNames": _names(profile_id, **names),
        "ExpressionAttributeValues": values,
    }
    target = table(SETTINGS_TABLE_ENV)
    try:
        retry_throttled(
            lambda: target.update_item(Key={"id": REQUIREMENT_PROFILES_ID}, **arguments),
            f"{label} of profile {profile_id!r}",
            deadline=deadline,
            sleep=sleep,
            clock=clock,
        )
    except ClientError as exc:
        if _is_condition_failure(exc):
            return False
        raise
    return True


_COPY_FIELDS = {
    "#status": "status",
    "#updated": "copy_updated_at",
    "#copied": "copied_items",
    "#total": "total_items",
}
_COPYING = "#profiles.#id.#status = :copying"


def record_copy_progress(
    profile_id: str,
    now_iso: str,
    copied: int,
    total: int,
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Write the copy's progress (its sign of life) while the profile is still copying.

    Throttling is retried until ``deadline`` (``DeadlineExceededError`` after it);
    ``sleep`` and ``clock`` are injected for tests.

    Returns:
        False if the profile is no longer copying (another run finished it) or is gone.
    """
    return _copy_update(
        profile_id,
        "SET #profiles.#id.#updated = :now, #profiles.#id.#copied = :copied,"
        " #profiles.#id.#total = :total",
        _COPYING,
        _COPY_FIELDS,
        {
            ":now": now_iso,
            ":copied": copied,
            ":total": total,
            ":copying": ProfileStatus.COPYING.value,
        },
        "copy progress",
        deadline=deadline,
        sleep=sleep,
        clock=clock,
    )


def mark_ready(
    profile_id: str,
    now_iso: str,
    copied: int,
    total: int,
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Mark the profile ``READY`` if it is still copying (conditional write).

    Returns:
        False if it was already ready (another run finished first) or is gone.
    """
    return _copy_update(
        profile_id,
        "SET #profiles.#id.#status = :ready, #profiles.#id.#updated = :now,"
        " #profiles.#id.#copied = :copied, #profiles.#id.#total = :total",
        _COPYING,
        _COPY_FIELDS,
        {
            ":ready": ProfileStatus.READY.value,
            ":now": now_iso,
            ":copied": copied,
            ":total": total,
            ":copying": ProfileStatus.COPYING.value,
        },
        "marking ready",
        deadline=deadline,
        sleep=sleep,
        clock=clock,
    )


def claim_stalled_copy(profile_id: str, now_iso: str, stale_before_iso: str) -> bool:
    """Record a resume of the copy, only if it is still copying and stalled.

    Atomic, so two resumes at the same time start one copy, and a copy that
    showed signs of life (or finished) meanwhile is not started again.

    Returns:
        False if the profile is not copying, not stalled any more, or gone.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    try:
        _update(
            {
                "UpdateExpression": "SET #profiles.#id.#updated = :now",
                "ConditionExpression": (
                    f"{_COPYING} AND (attribute_not_exists(#profiles.#id.#updated)"
                    " OR #profiles.#id.#updated <= :stale_before)"
                ),
                "ExpressionAttributeNames": _names(
                    profile_id, **{"#status": "status", "#updated": "copy_updated_at"}
                ),
                "ExpressionAttributeValues": {
                    ":now": now_iso,
                    ":stale_before": stale_before_iso,
                    ":copying": ProfileStatus.COPYING.value,
                },
            },
            "UpdateItem on Settings (requirement profile resume)",
        )
    except ClientError as exc:
        if _is_condition_failure(exc):
            return False
        raise
    return True


def mark_copy_not_started(profile_id: str) -> bool:
    """Drop the copy's sign of life after its start failed, so it shows as stalled at once.

    Best effort: a failure here is only logged (the copy then shows as
    stalled ``COPY_STALL_SECONDS`` later instead).

    Returns:
        True if the sign of life was removed.
    """
    try:
        _update(
            {
                "UpdateExpression": "REMOVE #profiles.#id.#updated",
                "ConditionExpression": _COPYING,
                "ExpressionAttributeNames": _names(
                    profile_id, **{"#status": "status", "#updated": "copy_updated_at"}
                ),
                "ExpressionAttributeValues": {":copying": ProfileStatus.COPYING.value},
            },
            "UpdateItem on Settings (requirement profile copy not started)",
        )
    except Exception:
        logger.exception("Could not mark the copy of profile %s as not started", profile_id)
        return False
    return True


# --- the deletion -------------------------------------------------------------

_DELETE_FIELDS = {
    "#status": "status",
    "#deleted": "delete_updated_at",
    "#checked": "delete_checked",
}
# With the identity of the mark, for the writes that set, compare or drop it.
_MARK_FIELDS = {**_DELETE_FIELDS, "#mark": "delete_mark"}
_DELETING = "#profiles.#id.#status = :deleting"
_UNCHECKED = f"{_DELETING} AND attribute_not_exists(#profiles.#id.#checked)"
_CHECKED = f"{_DELETING} AND #profiles.#id.#checked = :checked"


def _write_deleting(current: StoredProfiles, profile: RequirementProfile) -> RequirementProfile:
    """Write ``DELETING`` and a new ``delete_mark`` if nothing changed since ``current`` was read.

    The condition is the ``version`` read (no create, rename or other
    deletion meanwhile: nobody started copying from this profile), the
    status read (the copy did not finish meanwhile) and, for a profile whose
    copy was stalled, that the copy is still stalled (nobody resumed it).

    Raises:
        _StaleVersionError: If any of those changed.
        ServiceUnavailableError: If the table kept throttling.
    """
    previous = current.profiles[profile.id]
    names = dict(_MARK_FIELDS)
    values: dict[str, Any] = {
        ":deleting": ProfileStatus.DELETING.value,
        ":now": profile.delete_updated_at,
        # The identity of this mark: never the same for two marks.
        ":mark": uuid.uuid4().hex,
        ":previous": previous.status.value,
    }
    condition = "#profiles.#id.#status = :previous"
    if previous.status is ProfileStatus.COPYING:
        names["#copy_updated"] = "copy_updated_at"
        values[":stale_before"] = stall_threshold(str(profile.delete_updated_at))
        condition += (
            " AND (attribute_not_exists(#profiles.#id.#copy_updated)"
            " OR #profiles.#id.#copy_updated <= :stale_before)"
        )
    arguments = _with_version(
        current,
        {
            # REMOVE first: ``_with_version`` appends to the SET clause.
            "UpdateExpression": (
                "REMOVE #profiles.#id.#checked"
                " SET #profiles.#id.#status = :deleting, #profiles.#id.#deleted = :now,"
                " #profiles.#id.#mark = :mark"
            ),
            "ConditionExpression": f"({condition})",
            "ExpressionAttributeNames": _names(profile.id, **names),
            "ExpressionAttributeValues": values,
            "ReturnValues": "ALL_NEW",
        },
    )
    try:
        response = _update(arguments, "UpdateItem on Settings (requirement profile deletion)")
    except ClientError as exc:
        if _is_condition_failure(exc):
            raise _StaleVersionError from exc
        raise
    return _parse(response["Attributes"]).profiles[profile.id]


def begin_deletion(
    plan: Callable[[Mapping[str, RequirementProfile]], RequirementProfile],
) -> tuple[RequirementProfile, ProfileStatus | None]:
    """Store ``DELETING`` on the profile ``plan`` returns, unless it already is.

    ``plan`` runs on the same read the write is conditioned on (``version``
    and the profile's status), so what it checks still holds when the mark
    is written: the profile exists, its copy is not running and no profile
    is copying from it.

    Args:
        plan: Pure function from the stored profiles to the profile as it
            goes to ``DELETING`` (or as stored, if it already is); it may
            raise a DomainError.

    Returns:
        The profile as stored, with the ``delete_mark`` to hand to
        ``cancel_deletion`` or ``confirm_deletion`` (this call's mark, or
        the one it found), and the status it had before this call marked
        it; None when it was already ``DELETING`` and nothing was written.

    Raises:
        DomainError: Whatever ``plan`` raised on the fresh read.
        ConflictError: If other writes kept winning.
        ServiceUnavailableError: If the table kept throttling.
    """
    previous: list[ProfileStatus] = []

    def write(current: StoredProfiles, profile: RequirementProfile) -> RequirementProfile:
        stored = current.profiles[profile.id]
        if stored.status is ProfileStatus.DELETING:
            return stored
        marked = _write_deleting(current, profile)
        previous.append(stored.status)
        return marked

    profile = _apply(lambda current: plan(current.profiles), write, "delete")
    return profile, previous[0] if previous else None


def _conditional(arguments: dict[str, Any], label: str) -> bool:
    """Run a conditional ``UpdateItem`` on the profiles item; False if the condition failed.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
        ConflictError: If the item was still held by transactions after every attempt.
    """
    try:
        _update(arguments, label)
    except ClientError as exc:
        if _is_condition_failure(exc):
            return False
        raise
    return True


def _unconfirmed_mark(mark: str | None, values: dict[str, Any]) -> str:
    """Return the condition "``DELETING``, unconfirmed and still the mark ``mark``".

    None is a mark stored without ``delete_mark`` (written by hand; every
    mark of ``begin_deletion`` has one): it matches only a mark that still
    has none.
    """
    if mark is None:
        return f"{_UNCHECKED} AND attribute_not_exists(#profiles.#id.#mark)"
    values[":mark"] = mark
    return f"{_UNCHECKED} AND #profiles.#id.#mark = :mark"


def cancel_deletion(profile_id: str, mark: str | None, previous: ProfileStatus) -> bool:
    """Put the profile back to ``previous`` if ``mark`` is still its unconfirmed mark.

    Used when an event uses the profile. Conditioned on ``DELETING`` without
    ``delete_checked`` and on ``delete_mark``: a deletion another request
    confirmed meanwhile (it read the events later and found none) is not
    undone, and neither is a **later** mark (this one was undone and the
    profile marked again), whose own request reads the events for it.

    Args:
        profile_id: Profile to put back.
        mark: ``delete_mark`` the caller held when it read the events.
        previous: Status the profile goes back to.

    Returns:
        False if the profile is gone, not ``DELETING`` any more, confirmed
        or under another mark.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
        ConflictError: If the item was still held by transactions after every attempt.
    """
    values: dict[str, Any] = {
        ":previous": previous.value,
        ":deleting": ProfileStatus.DELETING.value,
    }
    return _conditional(
        {
            "UpdateExpression": (
                "SET #profiles.#id.#status = :previous"
                " REMOVE #profiles.#id.#deleted, #profiles.#id.#mark"
            ),
            "ConditionExpression": _unconfirmed_mark(mark, values),
            "ExpressionAttributeNames": _names(profile_id, **_MARK_FIELDS),
            "ExpressionAttributeValues": values,
        },
        "UpdateItem on Settings (requirement profile deletion cancelled)",
    )


def confirm_deletion(profile_id: str, mark: str | None, now_iso: str) -> bool:
    """Record that no event uses the profile: from now on its items may be deleted.

    Atomic and only once (``delete_checked`` absent), so of two requests that
    confirm at the same time one starts the deletion. Conditioned on
    ``delete_mark`` too: the events the caller read vouch only for the mark
    it held then. If that mark was undone and the profile marked again, an
    event may have chosen the profile in between, and this write fails.

    Args:
        profile_id: Profile whose deletion is confirmed.
        mark: ``delete_mark`` the caller held when it read the events.
        now_iso: Time of the request, the deletion's sign of life.

    Returns:
        False if the profile is gone, not ``DELETING`` any more (another
        request cancelled it), already confirmed or under another mark.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
        ConflictError: If the item was still held by transactions after every attempt.
    """
    values: dict[str, Any] = {
        ":checked": True,
        ":now": now_iso,
        ":deleting": ProfileStatus.DELETING.value,
    }
    return _conditional(
        {
            "UpdateExpression": (
                "SET #profiles.#id.#checked = :checked, #profiles.#id.#deleted = :now"
            ),
            "ConditionExpression": _unconfirmed_mark(mark, values),
            "ExpressionAttributeNames": _names(profile_id, **_MARK_FIELDS),
            "ExpressionAttributeValues": values,
        },
        "UpdateItem on Settings (requirement profile deletion confirmed)",
    )


def claim_stalled_deletion(profile_id: str, now_iso: str, stale_before_iso: str) -> bool:
    """Record a resume of a confirmed deletion, only if it is still stalled.

    Atomic, like ``claim_stalled_copy``: two repeated deletes at the same
    time start one run, and a deletion that showed signs of life (or
    finished) meanwhile is not started again.

    Returns:
        False if the profile is gone, not deleting, not confirmed or not stalled.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
        ConflictError: If the item was still held by transactions after every attempt.
    """
    return _conditional(
        {
            "UpdateExpression": "SET #profiles.#id.#deleted = :now",
            "ConditionExpression": (
                f"{_CHECKED} AND (attribute_not_exists(#profiles.#id.#deleted)"
                " OR #profiles.#id.#deleted <= :stale_before)"
            ),
            "ExpressionAttributeNames": _names(profile_id, **_DELETE_FIELDS),
            "ExpressionAttributeValues": {
                ":now": now_iso,
                ":stale_before": stale_before_iso,
                ":checked": True,
                ":deleting": ProfileStatus.DELETING.value,
            },
        },
        "UpdateItem on Settings (requirement profile deletion resume)",
    )


def mark_deletion_not_started(profile_id: str) -> bool:
    """Drop the deletion's sign of life after its start failed, so it shows as stalled at once.

    Best effort, like ``mark_copy_not_started``: a failure here is only
    logged (the deletion then shows as stalled ``COPY_STALL_SECONDS`` later).
    Only for a **confirmed** deletion (the caller confirmed or claimed it
    just before): it never touches an unconfirmed mark of another request.

    Returns:
        True if the sign of life was removed.
    """
    try:
        _update(
            {
                "UpdateExpression": "REMOVE #profiles.#id.#deleted",
                "ConditionExpression": _CHECKED,
                "ExpressionAttributeNames": _names(profile_id, **_DELETE_FIELDS),
                "ExpressionAttributeValues": {
                    ":checked": True,
                    ":deleting": ProfileStatus.DELETING.value,
                },
            },
            "UpdateItem on Settings (requirement profile deletion not started)",
        )
    except Exception:
        logger.exception("Could not mark the deletion of profile %s as not started", profile_id)
        return False
    return True


def record_deletion_progress(
    profile_id: str,
    now_iso: str,
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Write the deletion's sign of life while the profile is a confirmed ``DELETING``.

    Throttling and transaction conflicts are retried until ``deadline``
    (``DeadlineExceededError`` after it); ``sleep`` and ``clock`` are injected
    for tests.

    Returns:
        False if the profile is gone (another run finished) or is not a
        confirmed deletion: the run must stop.
    """
    return _copy_update(
        profile_id,
        "SET #profiles.#id.#deleted = :now",
        _CHECKED,
        _DELETE_FIELDS,
        {":now": now_iso, ":checked": True, ":deleting": ProfileStatus.DELETING.value},
        "deletion progress",
        deadline=deadline,
        sleep=sleep,
        clock=clock,
    )


def remove_profile(
    profile_id: str,
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Take a confirmed ``DELETING`` profile out of the map, bumping ``version``.

    Its name and its place in the limit are free from this write on; a
    create or rename that read the profiles before it reads them again.

    Returns:
        False if the profile was already removed (another run finished first).
    """
    names = {key: value for key, value in _DELETE_FIELDS.items() if key != "#deleted"}
    return _copy_update(
        profile_id,
        "REMOVE #profiles.#id SET #version = #version + :one",
        _CHECKED,
        {**names, "#version": _VERSION},
        {":one": 1, ":checked": True, ":deleting": ProfileStatus.DELETING.value},
        "removing the profile",
        deadline=deadline,
        sleep=sleep,
        clock=clock,
    )


# The asynchronous ``Invoke`` answers in milliseconds (Lambda only queues the
# event). These bound a call that hangs, so the request that starts the copy
# (or the deletion) still answers inside its 10 s function timeout: at most
# ``LAMBDA_MAX_ATTEMPTS`` attempts (the first and one retry, "standard" mode,
# which also retries throttling, 5xx and timeouts), each up to
# ``LAMBDA_CONNECT_TIMEOUT_SECONDS`` to connect and
# ``LAMBDA_READ_TIMEOUT_SECONDS`` to read, with at most 1 s between them:
# about 7 s in the worst case. Without them botocore waits up to 60 s per
# attempt. A retried event may be queued twice; the copy is idempotent.
LAMBDA_CONNECT_TIMEOUT_SECONDS = 1
LAMBDA_READ_TIMEOUT_SECONDS = 2
LAMBDA_MAX_ATTEMPTS = 2


@lru_cache(maxsize=1)
def _lambda_client() -> Any:
    return boto3.client(
        "lambda",
        config=Config(
            connect_timeout=LAMBDA_CONNECT_TIMEOUT_SECONDS,
            read_timeout=LAMBDA_READ_TIMEOUT_SECONDS,
            retries={"mode": "standard", "total_max_attempts": LAMBDA_MAX_ATTEMPTS},
        ),
    )


def reset_cache() -> None:
    """Drop the cached Lambda client (used by tests between mocked environments)."""
    _lambda_client.cache_clear()


def _start(function_env: str, profile_id: str, job: str) -> bool:
    """Queue a background job of a profile (asynchronous ``Invoke``); False if it failed."""
    try:
        _lambda_client().invoke(
            FunctionName=os.environ[function_env],
            InvocationType="Event",
            Payload=json.dumps({"profile_id": profile_id}).encode("utf-8"),
        )
    except (KeyError, ClientError, BotoCoreError):
        logger.exception("Could not start the %s of requirement profile %s", job, profile_id)
        return False
    logger.info("The %s of requirement profile %s was queued", job, profile_id)
    return True


def start_copy(profile_id: str) -> bool:
    """Start the copy of a profile in the background (asynchronous ``Invoke``).

    Lambda queues the event and answers at once; the copy function then
    runs with up to two automatic retries if it fails (``EventInvokeConfig``).
    A call that hangs gives up after the client's timeouts (about 7 s in the
    worst case, see ``LAMBDA_MAX_ATTEMPTS``).

    Returns:
        False if the copy could not be queued (the error is logged); the
        caller marks it as not started, so it can be resumed.
    """
    return _start(COPY_FUNCTION_ENV, profile_id, "copy")


def start_deletion(profile_id: str) -> bool:
    """Start the deletion of a profile's items in the background, like ``start_copy``.

    Returns:
        False if the deletion could not be queued (the error is logged); the
        caller marks it as not started, so repeating the ``DELETE`` resumes it.
    """
    return _start(DELETE_FUNCTION_ENV, profile_id, "deletion")
