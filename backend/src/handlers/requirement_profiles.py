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

Every answer carries ``copy_stalled``, computed at the time of the request,
so the screen shows "copying" or "stalled, resume".
"""

import logging
import uuid
from dataclasses import replace
from typing import Any

from domain import dates
from domain.errors import MSG_SERVICE_BUSY, ConflictError, ServiceUnavailableError
from domain.requirement_profiles import (
    MSG_COPY_IN_PROGRESS,
    MSG_PROFILE_NOT_FOUND,
    MSG_PROFILE_READY,
    ProfileStatus,
    check_can_rename,
    check_can_resume,
    parse_new_profile,
    parse_profile_name,
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
    still copying (409), limit of ``MAX_PROFILES`` (409; it wins over a taken
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
    profile (404), body (400) and name taken (409). The same name answers
    200 and writes nothing.
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

    Checks, in order: examiner (403), profile (404), profile ready (409, the
    main one included), copy with signs of life (409) and the start of the
    copy (503, the profile stays stalled).
    """
    user = current_user(event)
    require_examiner(user)
    now = dates.utc_now_iso()
    profile = resolve_profile(_path_id(event), profile_repo.get_profile)
    check_can_resume(profile, now)
    if not profile_repo.claim_stalled_copy(profile.id, now, stall_threshold(now)):
        # Another resume, the copy itself or its end won the race: say which.
        current = resolve_profile(profile.id, profile_repo.get_profile)
        if current.status is ProfileStatus.READY:
            raise ConflictError(MSG_PROFILE_READY)
        raise ConflictError(MSG_COPY_IN_PROGRESS)
    if not profile_repo.start_copy(profile.id):
        profile_repo.mark_copy_not_started(profile.id)
        raise ServiceUnavailableError(MSG_SERVICE_BUSY)
    logger.info("Copy of requirement profile %s resumed by %s", profile.id, user.sub)
    return json_response(202, replace(profile, copy_updated_at=now).to_dict(now))
