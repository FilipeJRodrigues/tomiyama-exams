"""Persistence of the requirement profiles (RN017, #144): one item in ``Settings``.

The item ``id = "requirement_profiles"`` holds ``profiles``, a map from each
profile id to its fields (``RequirementProfile.to_item``), and ``version``, a
number bumped by every change of the names (create and rename). The main
profile is never stored.

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
"""

import json
import logging
import os
import random
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from domain.errors import ConflictError
from domain.requirement_profiles import (
    MSG_PROFILES_BUSY,
    ProfileStatus,
    RequirementProfile,
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

# A create or rename is re-applied on a fresh read this many times before giving up.
_MAX_ATTEMPTS = 5
_BACKOFF_SECONDS = 0.05

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


def _update(arguments: dict[str, Any], label: str) -> dict[str, Any]:
    """Run an ``UpdateItem`` on the profiles item, answering 503 on persistent throttling.

    Raises:
        ServiceUnavailableError: If the table kept throttling.
        ClientError: Any other error (``ConditionalCheckFailedException`` included).
    """
    try:
        return table(SETTINGS_TABLE_ENV).update_item(
            Key={"id": REQUIREMENT_PROFILES_ID}, **arguments
        )
    except ClientError as exc:
        raise_if_throttled(exc, label)
        raise


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


@lru_cache(maxsize=1)
def _lambda_client() -> Any:
    return boto3.client("lambda")


def reset_cache() -> None:
    """Drop the cached Lambda client (used by tests between mocked environments)."""
    _lambda_client.cache_clear()


def start_copy(profile_id: str) -> bool:
    """Start the copy of a profile in the background (asynchronous ``Invoke``).

    Lambda queues the event and answers at once; the copy function then
    runs with up to two automatic retries if it fails (``EventInvokeConfig``).

    Returns:
        False if the copy could not be queued (the error is logged); the
        caller marks it as not started, so it can be resumed.
    """
    try:
        _lambda_client().invoke(
            FunctionName=os.environ[COPY_FUNCTION_ENV],
            InvocationType="Event",
            Payload=json.dumps({"profile_id": profile_id}).encode("utf-8"),
        )
    except (KeyError, ClientError, BotoCoreError):
        logger.exception("Could not start the copy of requirement profile %s", profile_id)
        return False
    logger.info("Copy of requirement profile %s queued", profile_id)
    return True
