"""Requirement profile routes, examiners only (RN017, #144, decisions of 2026-11-12).

- ``GET /requirement-profiles``: every profile, the main one first, then by
  name (accents ignored).
- ``GET /requirement-profiles/{id}``: one profile (404 if none).
- ``POST /requirement-profiles``: any examiner creates a profile as a full
  copy of the main profile or of another ready profile, up to
  ``MAX_PROFILES`` in all, the main one included (decision of 2026-11-13).
  The copy of ~700 items takes minutes at the dev capacity, past the API
  Gateway limit of 29 s, so the route stores the profile ``COPYING``, starts
  the copy in the background and answers **202**.
- ``PUT /requirement-profiles/{id}``: any examiner renames a profile other
  than the main one (the main one never: 403).
- ``POST /requirement-profiles/{id}/copy``: resumes a stalled copy (no sign of
  life for ``COPY_STALL_SECONDS``, or never started) and answers 202.
- ``DELETE /requirement-profiles/{id}``: any examiner deletes a profile other
  than the main one (never: 403) that no event uses (409). The ~700 items
  are deleted in the background, so the route stores the profile
  ``DELETING``, checks the events, starts the deletion and answers **202**;
  the profile leaves the list when its items are gone. Repeating it on a
  profile already ``DELETING`` answers 202 and resumes a stalled deletion.

Every answer carries ``copy_stalled`` and ``delete_stalled``, computed at the
time of the request, so the screen shows "copying", "deleting" or "stalled".
"""

import logging
import uuid
from dataclasses import replace
from typing import Any

from domain import dates
from domain.errors import (
    MSG_SERVICE_BUSY,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)
from domain.requirement_profiles import (
    MSG_COPY_IN_PROGRESS,
    MSG_PROFILE_DELETING,
    MSG_PROFILE_IN_USE,
    MSG_PROFILE_NOT_FOUND,
    MSG_PROFILE_READY,
    MSG_PROFILES_BUSY,
    ProfileStatus,
    RequirementProfile,
    check_can_delete,
    check_can_rename,
    check_can_resume,
    parse_new_profile,
    parse_profile_name,
    plan_deletion,
    plan_new_profile,
    renamed,
    resolve_profile,
    sorted_profiles,
    stall_threshold,
)
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    path_param,
    require_examiner,
)
from repository import events as event_repo
from repository import requirement_profiles as profile_repo

logger = logging.getLogger(__name__)


def _path_id(event: Event) -> str:
    return path_param(event, "id", not_found=MSG_PROFILE_NOT_FOUND)


@api_handler
def list_profiles(event: Event, context: Any) -> Response:
    """List every profile: the main one first, then the others by name."""
    require_examiner(current_user(event))
    now = dates.utc_now_iso()
    stored = profile_repo.get_profiles().profiles.values()
    return json_response(200, [profile.to_dict(now) for profile in sorted_profiles(stored)])


@api_handler
def get_profile(event: Event, context: Any) -> Response:
    """Return one profile.

    Checks, in order: examiner (403) and profile (404).
    """
    require_examiner(current_user(event))
    profile = resolve_profile(_path_id(event), profile_repo.get_profile)
    return json_response(200, profile.to_dict(dates.utc_now_iso()))


@api_handler
def create_profile(event: Event, context: Any) -> Response:
    """Create a profile as a copy of another (default: main) and start the copy (202).

    If the copy cannot be started, the profile is still created, with
    ``copy_stalled`` true, so the screen offers to resume it (if even that
    mark fails, it shows stalled ``COPY_STALL_SECONDS`` later).

    Checks, in order: examiner (403), body (400), source profile (404), source
    being deleted (409) or still copying (409), limit of ``MAX_PROFILES`` (409; it wins over a taken
    name) and name taken (409). The limit and the name are checked on the
    read that the conditional write depends on (``version``), so two
    concurrent creates never pass the limit; a refused create writes nothing
    and starts no copy.
    """
    user = current_user(event)
    require_examiner(user)
    name, source_id = parse_new_profile(json_body(event))
    now = dates.utc_now_iso()
    profile_id = str(uuid.uuid4())
    profile = profile_repo.create_profile(
        lambda stored: plan_new_profile(
            stored,
            profile_id=profile_id,
            name=name,
            source_profile_id=source_id,
            user_sub=user.sub,
            now_iso=now,
        )
    )
    logger.info(
        "Requirement profile %s created by %s from %s",
        profile.id,
        user.sub,
        profile.source_profile_id,
    )
    if not profile_repo.start_copy(profile.id) and profile_repo.mark_copy_not_started(profile.id):
        # As stored: no sign of life, so it shows stalled and may be resumed at once.
        profile = replace(profile, copy_updated_at=None)
    return json_response(202, profile.to_dict(now))


@api_handler
def rename_profile(event: Event, context: Any) -> Response:
    """Rename a profile other than the main one; also while it copies.

    Checks, in order: examiner (403), path id (404), main profile (403),
    profile (404), body (400), profile being deleted (409) and name taken
    (409). The same name answers 200 and writes nothing.
    """
    user = current_user(event)
    require_examiner(user)
    profile_id = _path_id(event)
    check_can_rename(profile_id)
    resolve_profile(profile_id, profile_repo.get_profile)
    name = parse_profile_name(json_body(event))
    profile = profile_repo.rename_profile(lambda stored: renamed(stored, profile_id, name))
    logger.info("Requirement profile %s renamed by %s", profile_id, user.sub)
    return json_response(200, profile.to_dict(dates.utc_now_iso()))


@api_handler
def resume_copy(event: Event, context: Any) -> Response:
    """Start again the copy of a stalled profile (202).

    Checks, in order: examiner (403), profile (404), profile being deleted
    (409), profile ready (409, the main one included), copy with signs of
    life (409) and the start of the copy (503, the profile stays stalled).
    """
    user = current_user(event)
    require_examiner(user)
    now = dates.utc_now_iso()
    profile = resolve_profile(_path_id(event), profile_repo.get_profile)
    check_can_resume(profile, now)
    if not profile_repo.claim_stalled_copy(profile.id, now, stall_threshold(now)):
        # Another resume, the copy itself or its end won the race: say which.
        current = resolve_profile(profile.id, profile_repo.get_profile)
        if current.status is ProfileStatus.DELETING:
            raise ConflictError(MSG_PROFILE_DELETING)
        if current.status is ProfileStatus.READY:
            raise ConflictError(MSG_PROFILE_READY)
        raise ConflictError(MSG_COPY_IN_PROGRESS)
    if not profile_repo.start_copy(profile.id):
        profile_repo.mark_copy_not_started(profile.id)
        raise ServiceUnavailableError(MSG_SERVICE_BUSY)
    logger.info("Copy of requirement profile %s resumed by %s", profile.id, user.sub)
    return json_response(202, replace(profile, copy_updated_at=now).to_dict(now))


def _deleting(profile: RequirementProfile, now: str) -> Response:
    return json_response(202, profile.to_dict(now))


def _current_deletion(profile_id: str, now: str, otherwise: str) -> Response:
    """Answer for a confirmed deletion another request resumed or finished, read again.

    Raises:
        NotFoundError: If the profile is gone (its deletion finished).
        ConflictError: With ``otherwise`` if the profile is not being deleted
            (the other request cancelled the deletion).
    """
    current = profile_repo.get_profile(profile_id)
    if current is None:
        raise NotFoundError(MSG_PROFILE_NOT_FOUND)
    if current.status is not ProfileStatus.DELETING:
        raise ConflictError(otherwise)
    return _deleting(current, now)


# A ``DELETE`` whose mark changed while it read the events (another request
# undid or confirmed it) decides again on a fresh read this many times.
_DELETE_ATTEMPTS = 3


@api_handler
def delete_profile(event: Event, context: Any) -> Response:
    """Delete a profile other than the main one that no event uses (202, in the background).

    Checks, in order: examiner (403), path id (404), main profile (403, the
    master included), profile (404), its copy in progress (409; a stalled
    copy may be deleted), another profile still copying from it (409) and an
    event that uses it (409).

    The order of the writes closes the races (see
    ``repository.requirement_profiles``):

    1. the profile goes to ``DELETING`` in a write conditioned on the
       ``version`` and the status read: from then on no event starts using
       it, no profile is copied from it and its items are not changed. The
       write stores a new random ``delete_mark``, the identity of this mark;
    2. only then are the events read (consistent ``Scan``). If one uses the
       profile, the mark is undone and the answer is 409. If undoing fails,
       the profile stays ``DELETING`` **unconfirmed**, with every item, and
       the next ``DELETE`` checks the events again at once (it is undone
       again, or deleted if no event uses it any more);
    3. with no event, the deletion is confirmed (``delete_checked``, once)
       and the background function is started. If it cannot be started, the
       answer is still 202, with ``delete_stalled`` true.

    Undoing and confirming are conditioned on the ``delete_mark`` this
    request held when it read the events, its own or the unconfirmed one it
    found: the read vouches only for that mark. If the mark is no longer that
    one (another request confirmed it, or undid it and the profile may even
    have been marked again), nothing is written with the old read and the
    request **decides again** from a fresh read of the profile: 404 if it is
    gone, 202 if the deletion is confirmed, or a new read of the events under
    the current mark. The one exception needs no new read: this request found
    an event and the profile is no longer ``DELETING`` (another request undid
    the mark first), so it answers the same 409, which deletes nothing. After
    ``_DELETE_ATTEMPTS`` rounds lost to other requests it answers 409 ("tente
    de novo").

    A profile already ``DELETING`` and confirmed: 202 with its current state
    while the deletion shows signs of life; once stalled, this request
    resumes it (atomic claim, one run for two simultaneous requests) and
    answers 202, or 503 if the deletion cannot be started (still stalled).
    """
    user = current_user(event)
    require_examiner(user)
    profile_id = _path_id(event)
    check_can_delete(profile_id)
    now = dates.utc_now_iso()
    for attempt in range(_DELETE_ATTEMPTS):
        profile, previous = profile_repo.begin_deletion(
            lambda stored: plan_deletion(stored, profile_id, now)
        )
        if profile.delete_checked:
            return _confirmed_deletion(profile, now, user.sub)

        # Marked by this request, or by another that has not confirmed (or
        # stopped before confirming): the events are read after the mark, and
        # what is decided from them is written only if the mark is still it.
        mark = profile.delete_mark
        try:
            in_use = event_repo.any_event_uses_profile(profile_id)
        except Exception:
            if previous is not None:
                _undo_mark(profile_id, mark, previous)
            raise
        if in_use:
            # An event uses it, so it was READY before (only a READY profile is chosen).
            if profile_repo.cancel_deletion(profile_id, mark, previous or ProfileStatus.READY):
                raise ConflictError(MSG_PROFILE_IN_USE)
            current = profile_repo.get_profile(profile_id)
            if current is not None and current.status is not ProfileStatus.DELETING:
                # Another request undid the mark first. The event just read
                # is reason enough to refuse (a refusal deletes nothing).
                raise ConflictError(MSG_PROFILE_IN_USE)
        elif profile_repo.confirm_deletion(profile_id, mark, now):
            profile = replace(profile, delete_checked=True, delete_updated_at=now)
            logger.info("Requirement profile %s marked for deletion by %s", profile_id, user.sub)
            if not profile_repo.start_deletion(
                profile_id
            ) and profile_repo.mark_deletion_not_started(profile_id):
                # As stored: no sign of life, so it shows stalled and may be resumed at once.
                profile = replace(profile, delete_updated_at=None)
            return _deleting(profile, now)
        # The mark is not the one the events were read under any more: what
        # was read proves nothing about the current one. Decide again.
        logger.info(
            "Deletion mark of requirement profile %s changed meanwhile; attempt %d",
            profile_id,
            attempt + 1,
        )
    raise ConflictError(MSG_PROFILES_BUSY)


def _confirmed_deletion(profile: RequirementProfile, now: str, user_sub: str) -> Response:
    """Answer a ``DELETE`` of a profile whose deletion is confirmed; resume it if stalled.

    Raises:
        NotFoundError: If the deletion finished while this request claimed it.
        ConflictError: If the claim lost and the profile is not being deleted.
        ServiceUnavailableError: If the stalled deletion could not be started.
    """
    if not profile.is_delete_stalled(now):
        return _deleting(profile, now)
    if not profile_repo.claim_stalled_deletion(profile.id, now, stall_threshold(now)):
        # Another resume, the deletion itself or its end won the race.
        return _current_deletion(profile.id, now, MSG_PROFILES_BUSY)
    if not profile_repo.start_deletion(profile.id):
        profile_repo.mark_deletion_not_started(profile.id)
        raise ServiceUnavailableError(MSG_SERVICE_BUSY)
    logger.info("Deletion of requirement profile %s resumed by %s", profile.id, user_sub)
    return _deleting(replace(profile, delete_updated_at=now), now)


def _undo_mark(profile_id: str, mark: str | None, previous: ProfileStatus) -> None:
    """Undo this request's own mark after the events could not be read; best effort.

    Only the mark this request wrote (``mark``): a later mark of another
    request is left to that request.
    """
    try:
        profile_repo.cancel_deletion(profile_id, mark, previous)
    except Exception:
        logger.exception("Could not undo the deletion mark of profile %s", profile_id)
