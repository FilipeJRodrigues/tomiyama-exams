"""Requirement routes, examiners only (RN017).

Every item belongs to a requirement profile; without ``profile_id`` the routes
use the main profile (``domain.requirement_profiles``). Creating, editing and
deleting items of the main profile is reserved to the admin master; the items
of the other profiles are open to every examiner, once the profile's copy has
finished (409 while it copies). Listing is open to every examiner (decisions
of 2026-11-12).

- ``GET /requirements``: list the items of one profile, filterable by
  ``belt_id`` and ``kind``, ordered by belt and sheet order, with no limit that
  cuts long belts (Marrom: 139 items). A profile still copying lists what
  was copied so far.
- ``POST /requirements``: add an item to a profile; without ``sort_order`` it
  goes to the end of the belt in that profile.
- ``PUT /requirements/{id}``: edit an item; its profile never changes (400),
  and it is refused (409) if it has answers and the belt or kind changes
  (description, expected answer, category and order stay editable).
- ``DELETE /requirements/{id}``: remove an item; refused (409) if any exam has
  an answer for it.
"""

import logging
import uuid
from typing import Any

from domain.errors import NotFoundError, ValidationError
from domain.requirement_profiles import (
    RequirementProfile,
    check_can_edit,
    check_profile_unchanged,
    find_profile,
    profile_id_field,
    resolve_profile,
)
from domain.requirements import (
    MSG_REQUIREMENT_NOT_FOUND,
    Requirement,
    RequirementKind,
    build_requirement,
    sort_requirements,
)
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    no_content,
    path_param,
    query_param,
    require_examiner,
)
from repository import belts as belt_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo

logger = logging.getLogger(__name__)


def _kind_filter(event: Event) -> RequirementKind | None:
    raw = query_param(event, "kind")
    if raw is None:
        return None
    try:
        return RequirementKind(raw)
    except ValueError as exc:
        raise ValidationError("Filtro tipo: use THEORY ou PRACTICE") from exc


def _next_sort_order(profile_id: str, belt_id: str) -> int:
    items = requirement_repo.list_profile_belt(profile_id, belt_id)
    return max((item.sort_order for item in items), default=0) + 1


def _profile_of(requirement: Requirement) -> RequirementProfile:
    """Return the profile of a stored item (read only for profiles other than main).

    Raises:
        NotFoundError: If the item's profile no longer exists.
    """
    return resolve_profile(requirement.profile_id, profile_repo.get_profile)


def _get_or_404(requirement_id: str) -> Requirement:
    requirement = requirement_repo.get_requirement(requirement_id)
    if requirement is None:
        raise NotFoundError(MSG_REQUIREMENT_NOT_FOUND)
    return requirement


@api_handler
def list_requirements(event: Event, context: Any) -> Response:
    """List the items of one profile (default: main), optionally filtered by belt and kind.

    A profile still copying lists the items copied so far. Without a belt,
    the main profile is read from the table and the others belt by belt from
    their index, so their cost does not grow with the other profiles.

    Checks, in order: examiner (403), kind filter (400), profile (404) and belt (404).
    """
    require_examiner(current_user(event))
    kind = _kind_filter(event)
    profile = find_profile(query_param(event, "profile_id"), profile_repo.get_profile)
    belt_id = query_param(event, "belt_id")
    belts = belt_repo.list_belts()

    if belt_id:
        if belt_id not in {belt.id for belt in belts}:
            raise NotFoundError("Faixa não encontrada")
        items = requirement_repo.list_profile_belt(profile.id, belt_id)
    elif profile.is_main:
        items = requirement_repo.list_by_profile(profile.id)
    else:
        items = requirement_repo.list_profile_belts(profile.id, [belt.id for belt in belts])
    if kind:
        items = [item for item in items if item.kind == kind]
    return json_response(200, [item.to_dict() for item in sort_requirements(items, belts)])


@api_handler
def create_requirement(event: Event, context: Any) -> Response:
    """Add an item to a belt in a profile (default: main).

    Checks, in order: examiner (403), body (400), profile (404), fields (400),
    in the main profile the admin master (403) and, in another profile, the
    end of its copy (409).
    """
    user = current_user(event)
    require_examiner(user)
    payload = json_body(event)
    profile = find_profile(profile_id_field(payload), profile_repo.get_profile)
    belts_by_id = {belt.id: belt for belt in belt_repo.list_belts()}
    belt_id = payload.get("belt_id")
    default_order = _next_sort_order(profile.id, belt_id) if belt_id in belts_by_id else 1
    requirement = build_requirement(
        payload,
        belts_by_id,
        requirement_id=str(uuid.uuid4()),
        default_sort_order=default_order,
        profile_id=profile.id,
    )
    check_can_edit(profile, user)
    requirement_repo.create_requirement(requirement)
    logger.info("Requirement %s created by %s in %s", requirement.id, user.sub, profile.id)
    return json_response(201, requirement.to_dict())


@api_handler
def update_requirement(event: Event, context: Any) -> Response:
    """Edit an item; belt and kind are locked while it has answers (checked in the write).

    Checks, in order: examiner (403), path id and item (404), body (400, a
    different ``profile_id`` included), the admin master on items of the main
    profile (403), the end of the copy of another profile (409) and the
    conditional write (404 if deleted meanwhile, 409 on the lock).
    """
    user = current_user(event)
    require_examiner(user)
    existing = _get_or_404(path_param(event, "id", not_found=MSG_REQUIREMENT_NOT_FOUND))
    payload = json_body(event)
    check_profile_unchanged(payload, existing.profile_id)
    updated = build_requirement(
        payload,
        {belt.id: belt for belt in belt_repo.list_belts()},
        requirement_id=existing.id,
        default_sort_order=existing.sort_order,
        profile_id=existing.profile_id,
    )
    check_can_edit(_profile_of(existing), user)
    requirement_repo.save_requirement(updated)
    logger.info("Requirement %s updated by %s", updated.id, user.sub)
    return json_response(200, updated.to_dict())


@api_handler
def delete_requirement(event: Event, context: Any) -> Response:
    """Remove an item that has no answers (conditional delete on ``answer_count``).

    Checks, in order: examiner (403), path id and item (404), the admin master
    on items of the main profile (403), the end of the copy of another
    profile (409) and answers (409).
    """
    user = current_user(event)
    require_examiner(user)
    requirement = _get_or_404(path_param(event, "id", not_found=MSG_REQUIREMENT_NOT_FOUND))
    check_can_edit(_profile_of(requirement), user)
    requirement_repo.delete_requirement(requirement.id)
    logger.info("Requirement %s deleted by %s", requirement.id, user.sub)
    return no_content()
