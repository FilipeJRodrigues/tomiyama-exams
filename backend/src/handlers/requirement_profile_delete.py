"""Background deletion of a requirement profile's items (RN017, #144, step 3b-2).

Invoked asynchronously (``InvocationType=Event``) by ``DELETE
/requirement-profiles/{id}`` with ``{"profile_id": "<id>"}``; no API route
reaches it. It is a function of its own, not an action of the copy function,
so each has only the permissions of its job: the copy never deletes an item
and the deletion never writes one. A run:

1. reads the profile and does nothing unless it is ``DELETING`` with
   ``delete_checked`` (the route confirmed, after the profile left ``READY``,
   that no event uses it); the main profile is refused outright;
2. reads, belt by belt, the ids of the profile's items (``by_profile_belt``,
   never the fallback of the main profile) and deletes each with a
   ``DeleteItem`` conditioned on the stored item being of this profile and
   having no answers, at most ``DELETE_ITEMS_PER_SECOND`` per second, so that
   in dev the deletion leaves write capacity of ``Requirements`` to the exam
   marking;
3. records its sign of life every ``PROGRESS_EVERY_ITEMS`` items or
   ``PROGRESS_EVERY_SECONDS`` seconds, and stops if the profile is no longer
   a confirmed ``DELETING`` (another run already removed it);
4. reads every belt again until a whole pass finds nothing to delete, waits
   ``SETTLE_SECONDS`` and reads once more (the index is eventually
   consistent, and a request that read the profile ``READY`` just before the
   deletion was asked may still be writing an item);
5. takes the profile out of the stored profiles (conditional write that
   bumps ``version``), which frees its name and its place in the limit.

An item with answers (or of another profile) is **kept**, and then the
profile is not removed: the run ends ``BLOCKED`` with an error in the log,
and the profile stays ``DELETING`` (see ``delete_profile_items``).

Idempotent and resumable like the copy: a run that stops (deadline or error)
leaves what it deleted, and the next one deletes what is left. The next run
is Lambda's automatic retry of a failed asynchronous invocation (up to 2,
``EventInvokeConfig``) or, when those are spent or the deletion never
started, a repeated ``DELETE`` of the stalled profile. Throttled reads and
writes are retried with backoff (``retry_throttled``); the run stops
``SAFETY_MARGIN_SECONDS`` before the Lambda timeout and fails, so Lambda
retries it.
"""

import logging
import os
import time
from collections.abc import Callable
from typing import Any

from domain import dates
from domain.requirement_profiles import MAIN_PROFILE_ID, ProfileStatus
from repository import belts as belt_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository.requirements import ProfileItemDeletion
from repository.tables import DeadlineExceededError, retry_throttled

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Time kept after the deadline for botocore's internal retries (~25 s) and the
# last writes, as in the copy.
SAFETY_MARGIN_SECONDS = 60
PROGRESS_EVERY_ITEMS = 50
PROGRESS_EVERY_SECONDS = 30
ITEMS_PER_SECOND_ENV = "DELETE_ITEMS_PER_SECOND"
DEFAULT_ITEMS_PER_SECOND = 2.0
# Wait between the first pass that finds nothing and the last one. Longer
# than the 10 s timeout of the API functions: a request that read the profile
# ``READY`` before it went to ``DELETING`` has written its item (or given up)
# by then, and the index has had time to show it.
SETTLE_SECONDS = 20.0

Outcome = dict[str, Any]


def _items_per_second() -> float:
    """Return the pace from ``DELETE_ITEMS_PER_SECOND`` (default 2; invalid values too)."""
    try:
        value = float(os.environ.get(ITEMS_PER_SECOND_ENV) or DEFAULT_ITEMS_PER_SECOND)
    except ValueError:
        return DEFAULT_ITEMS_PER_SECOND
    return value if value > 0 else DEFAULT_ITEMS_PER_SECOND


def _outcome(profile_id: str, outcome: str, **counts: int) -> Outcome:
    result: Outcome = {"profile_id": profile_id, "outcome": outcome, **counts}
    logger.info("Deletion of requirement profile: %s", result)
    return result


def delete_profile_items(
    profile_id: str,
    *,
    deadline: float | None = None,
    items_per_second: float | None = None,
    settle_seconds: float = SETTLE_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Outcome:
    """Delete every item of a confirmed ``DELETING`` profile, then remove the profile.

    An item that cannot be deleted is kept and blocks the removal of the
    profile: one with answers (a profile no event uses has none, since an
    event with exams is never deleted nor changes its profile; if one shows
    up anyway, deleting it would orphan answers of some exam) or one whose
    stored ``profile_id`` is another profile's (the index listed it wrongly).
    The run then ends ``BLOCKED``, logged as an error with the ids, having
    deleted the rest; the profile stays ``DELETING`` and shows as stalled.

    Args:
        profile_id: Profile to empty and remove.
        deadline: ``clock()`` value after which no new read or write starts
            (``DeadlineExceededError``); None runs to the end.
        items_per_second: Pace of the deletes; None reads ``DELETE_ITEMS_PER_SECOND``.
        settle_seconds: Wait before the last pass (``SETTLE_SECONDS``).
        sleep: Injected for tests.
        clock: Injected for tests.

    Returns:
        ``outcome`` and, once it started, the counts ``deleted`` (items
        deleted by this run) and ``kept``. Outcomes: ``DELETED`` (profile
        removed), ``BLOCKED``, ``STOPPED`` (no longer a confirmed
        ``DELETING``: another run removed it), ``NOT_FOUND``,
        ``NOT_DELETING``, ``NOT_CONFIRMED`` and ``MAIN_PROFILE`` (nothing done).

    Raises:
        DeadlineExceededError: The deadline passed before the end (what was
            deleted stays deleted; the next run goes on from there).
    """
    if profile_id == MAIN_PROFILE_ID:
        logger.error("Refused to delete the items of the main requirement profile")
        return _outcome(profile_id, "MAIN_PROFILE")
    interval = 1 / (items_per_second or _items_per_second())

    def read[T](call: Callable[[], T], label: str) -> T:
        return retry_throttled(call, label, deadline=deadline, sleep=sleep, clock=clock)

    def wait(seconds: float) -> None:
        if seconds <= 0:
            return
        if deadline is not None and clock() + seconds >= deadline:
            raise DeadlineExceededError(f"Deadline passed while deleting {profile_id!r}")
        sleep(seconds)

    profile = read(lambda: profile_repo.get_profile(profile_id), f"reading profile {profile_id!r}")
    if profile is None:
        logger.warning("Requirement profile %s not found: nothing to delete", profile_id)
        return _outcome(profile_id, "NOT_FOUND")
    if profile.status is not ProfileStatus.DELETING:
        return _outcome(profile_id, "NOT_DELETING")
    if not profile.delete_checked:
        logger.warning("Deletion of requirement profile %s was not confirmed", profile_id)
        return _outcome(profile_id, "NOT_CONFIRMED")

    def alive() -> bool:
        return profile_repo.record_deletion_progress(
            profile_id, dates.utc_now_iso(), deadline=deadline, sleep=sleep, clock=clock
        )

    deleted = 0
    if not alive():
        return _outcome(profile_id, "STOPPED", deleted=0, kept=0)
    belts = read(belt_repo.list_belts, "listing the belts")
    last_progress_at = clock()
    since_progress = 0
    next_delete_at = clock()
    empty_passes = 0
    try:
        while empty_passes < 2:
            found = 0
            kept: list[str] = []
            for belt in belts:
                ids = read(
                    lambda belt_id=belt.id: requirement_repo.list_stored_profile_belt_ids(
                        profile_id, belt_id
                    ),
                    f"reading the items of belt {belt.id!r}",
                )
                for requirement_id in ids:
                    wait(next_delete_at - clock())
                    result = requirement_repo.delete_profile_item(
                        requirement_id, profile_id, deadline=deadline, sleep=sleep, clock=clock
                    )
                    next_delete_at = max(next_delete_at + interval, clock())
                    if result is ProfileItemDeletion.DELETED:
                        deleted += 1
                        found += 1
                    elif result is not ProfileItemDeletion.GONE:
                        logger.error(
                            "Item %s of requirement profile %s kept: %s",
                            requirement_id,
                            profile_id,
                            result.value,
                        )
                        kept.append(requirement_id)
                    since_progress += 1
                    if (
                        since_progress >= PROGRESS_EVERY_ITEMS
                        or clock() - last_progress_at >= PROGRESS_EVERY_SECONDS
                    ):
                        if not alive():
                            return _outcome(profile_id, "STOPPED", deleted=deleted, kept=len(kept))
                        last_progress_at = clock()
                        since_progress = 0
            if kept:
                logger.error(
                    "Requirement profile %s not removed: %d items could not be deleted (%s)",
                    profile_id,
                    len(kept),
                    ", ".join(kept[:20]),
                )
                return _outcome(profile_id, "BLOCKED", deleted=deleted, kept=len(kept))
            empty_passes = 0 if found else empty_passes + 1
            if not alive():
                return _outcome(profile_id, "STOPPED", deleted=deleted, kept=0)
            last_progress_at = clock()
            since_progress = 0
            if empty_passes == 1:
                wait(settle_seconds)
    except DeadlineExceededError:
        logger.warning(
            "Deletion of requirement profile %s stopped at the deadline: %d items deleted",
            profile_id,
            deleted,
        )
        raise
    if not profile_repo.remove_profile(profile_id, deadline=deadline, sleep=sleep, clock=clock):
        return _outcome(profile_id, "STOPPED", deleted=deleted, kept=0)
    return _outcome(profile_id, "DELETED", deleted=deleted, kept=0)


def _deadline(context: Any) -> float | None:
    """Return the monotonic time at which the run must stop, from the Lambda context."""
    remaining_ms = getattr(context, "get_remaining_time_in_millis", None)
    if remaining_ms is None:
        return None
    return time.monotonic() + remaining_ms() / 1000 - SAFETY_MARGIN_SECONDS


def handler(event: Any, context: Any) -> Outcome:
    """Run the deletion of ``event["profile_id"]``; an error makes Lambda retry the invocation."""
    profile_id = event.get("profile_id") if isinstance(event, dict) else None
    if not isinstance(profile_id, str) or not profile_id:
        logger.error("Deletion invoked without a profile id: %r", event)
        return {"outcome": "INVALID_EVENT"}
    return delete_profile_items(profile_id, deadline=_deadline(context))
