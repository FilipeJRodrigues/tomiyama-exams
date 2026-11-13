"""Background copy of a requirement profile (RN017, #144, decision of 2026-11-12).

Invoked asynchronously (``InvocationType=Event``) by ``POST
/requirement-profiles`` and ``POST /requirement-profiles/{id}/copy`` with
``{"profile_id": "<id>"}``; no API route reaches it. A run:

1. reads the profile (nothing to do if it is gone or already ``READY``) and
   its source (the main profile or another ready one);
2. reads, belt by belt, the source's items and the items already copied
   (``by_profile_belt``; the main profile through ``by_belt`` until the v2
   migration finished);
3. writes each missing copy (``copy_to_profile``: deterministic id, every
   field of the item, never ``answer_count``) with a conditional ``PutItem``,
   at most ``COPY_ITEMS_PER_SECOND`` per second, so that in dev the copy
   leaves write capacity of ``Requirements`` to the exam marking;
4. records its progress (the copy's sign of life) every
   ``PROGRESS_EVERY_ITEMS`` items or ``PROGRESS_EVERY_SECONDS`` seconds, and
   stops if the profile is no longer copying;
5. marks the profile ``READY`` (conditional write).

Idempotent and resumable: a run that stops (deadline or error) leaves the
copies already written, and the next run writes only what is missing. The
next run is Lambda's automatic retry of a failed asynchronous invocation (up
to 2, ``EventInvokeConfig``) or, when those are spent or the copy never
started, the resume route. Throttled reads and writes are retried with
backoff (``retry_throttled``); the run stops ``SAFETY_MARGIN_SECONDS`` before
the Lambda timeout and fails, so Lambda retries it.
"""

import logging
import os
import time
from collections.abc import Callable
from typing import Any

from domain import dates
from domain.errors import NotFoundError
from domain.requirement_profiles import MAIN_PROFILE_ID, ProfileStatus, resolve_profile
from domain.requirements import Requirement, copy_to_profile
from repository import belts as belt_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository.tables import DeadlineExceededError, retry_throttled

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Time kept after the deadline for botocore's internal retries (~25 s) and the
# last writes, as in the initial-data load.
SAFETY_MARGIN_SECONDS = 60
PROGRESS_EVERY_ITEMS = 50
PROGRESS_EVERY_SECONDS = 30
ITEMS_PER_SECOND_ENV = "COPY_ITEMS_PER_SECOND"
DEFAULT_ITEMS_PER_SECOND = 2.0

Outcome = dict[str, Any]


def _items_per_second() -> float:
    """Return the write pace from ``COPY_ITEMS_PER_SECOND`` (default 2; invalid values too)."""
    try:
        value = float(os.environ.get(ITEMS_PER_SECOND_ENV) or DEFAULT_ITEMS_PER_SECOND)
    except ValueError:
        return DEFAULT_ITEMS_PER_SECOND
    return value if value > 0 else DEFAULT_ITEMS_PER_SECOND


def _outcome(profile_id: str, outcome: str, **counts: int) -> Outcome:
    result: Outcome = {"profile_id": profile_id, "outcome": outcome, **counts}
    logger.info("Copy of requirement profile: %s", result)
    return result


def copy_profile(
    profile_id: str,
    *,
    deadline: float | None = None,
    items_per_second: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Outcome:
    """Copy the source's missing items into ``profile_id`` and mark it ``READY``.

    Args:
        profile_id: Profile to fill.
        deadline: ``clock()`` value after which no new read or write starts
            (``DeadlineExceededError``); None runs to the end.
        items_per_second: Write pace; None reads ``COPY_ITEMS_PER_SECOND``.
        sleep: Injected for tests.
        clock: Injected for tests.

    Returns:
        ``outcome`` (``READY``, ``ALREADY_READY``, ``NOT_FOUND``,
        ``SOURCE_NOT_FOUND`` or ``STOPPED``) and the counts ``written``
        (items written by this run), ``copied`` and ``total``.

    Raises:
        DeadlineExceededError: The deadline passed before the end (the
            copies written so far stay; the next run goes on from there).
    """
    interval = 1 / (items_per_second or _items_per_second())

    def read[T](call: Callable[[], T], label: str) -> T:
        return retry_throttled(call, label, deadline=deadline, sleep=sleep, clock=clock)

    def stored(wanted: str) -> Any:
        return read(lambda: profile_repo.get_profile(wanted), f"reading profile {wanted!r}")

    profile = stored(profile_id)
    if profile is None:
        logger.warning("Requirement profile %s not found: nothing to copy", profile_id)
        return _outcome(profile_id, "NOT_FOUND")
    if profile.status is ProfileStatus.READY:
        return _outcome(profile_id, "ALREADY_READY")
    try:
        source = resolve_profile(profile.source_profile_id or MAIN_PROFILE_ID, stored)
    except NotFoundError:
        # Not retried: the profile stays copying and shows as stalled.
        logger.error(
            "Source %s of requirement profile %s not found", profile.source_profile_id, profile_id
        )
        return _outcome(profile_id, "SOURCE_NOT_FOUND")

    copies: list[Requirement] = []
    existing: set[str] = set()
    for belt in read(belt_repo.list_belts, "listing the belts"):
        copies.extend(
            copy_to_profile(item, profile_id)
            for item in read(
                lambda belt_id=belt.id: requirement_repo.list_profile_belt(source.id, belt_id),
                f"reading the source items of belt {belt.id!r}",
            )
        )
        existing.update(
            item.id
            for item in read(
                lambda belt_id=belt.id: requirement_repo.list_profile_belt(profile_id, belt_id),
                f"reading the copied items of belt {belt.id!r}",
            )
        )
    total = len(copies)
    missing = [copy for copy in copies if copy.id not in existing]
    copied = total - len(missing)
    written = 0

    def progress() -> bool:
        return profile_repo.record_copy_progress(
            profile_id,
            dates.utc_now_iso(),
            copied,
            total,
            deadline=deadline,
            sleep=sleep,
            clock=clock,
        )

    if not progress():
        return _outcome(profile_id, "STOPPED", written=0, copied=copied, total=total)
    last_progress_at = clock()
    since_progress = 0
    next_write_at = clock()
    try:
        for copy in missing:
            wait = next_write_at - clock()
            if wait > 0:
                if deadline is not None and clock() + wait >= deadline:
                    raise DeadlineExceededError(f"Deadline passed while copying {profile_id!r}")
                sleep(wait)
            if requirement_repo.put_copy(copy, deadline=deadline, sleep=sleep, clock=clock):
                written += 1
            copied += 1
            since_progress += 1
            next_write_at = max(next_write_at + interval, clock())
            if (
                since_progress >= PROGRESS_EVERY_ITEMS
                or clock() - last_progress_at >= PROGRESS_EVERY_SECONDS
            ):
                if not progress():
                    return _outcome(
                        profile_id, "STOPPED", written=written, copied=copied, total=total
                    )
                last_progress_at = clock()
                since_progress = 0
    except DeadlineExceededError:
        logger.warning(
            "Copy of requirement profile %s stopped at the deadline: %d of %d items",
            profile_id,
            copied,
            total,
        )
        raise
    if not profile_repo.mark_ready(
        profile_id, dates.utc_now_iso(), copied, total, deadline=deadline, sleep=sleep, clock=clock
    ):
        return _outcome(profile_id, "ALREADY_READY", written=written, copied=copied, total=total)
    return _outcome(profile_id, "READY", written=written, copied=copied, total=total)


def _deadline(context: Any) -> float | None:
    """Return the monotonic time at which the run must stop, from the Lambda context."""
    remaining_ms = getattr(context, "get_remaining_time_in_millis", None)
    if remaining_ms is None:
        return None
    return time.monotonic() + remaining_ms() / 1000 - SAFETY_MARGIN_SECONDS


def handler(event: Any, context: Any) -> Outcome:
    """Run the copy of ``event["profile_id"]``; an error makes Lambda retry the invocation."""
    profile_id = event.get("profile_id") if isinstance(event, dict) else None
    if not isinstance(profile_id, str) or not profile_id:
        logger.error("Copy invoked without a profile id: %r", event)
        return {"outcome": "INVALID_EVENT"}
    return copy_profile(profile_id, deadline=_deadline(context))
