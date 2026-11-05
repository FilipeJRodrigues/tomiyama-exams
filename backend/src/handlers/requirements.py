"""Requirement routes, examiners only (RN017).

- ``GET /requirements``: list, filterable by ``belt_id`` and ``kind``, ordered by
  belt and sheet order, with no limit that cuts long belts (Marrom: 139 items).
- ``POST /requirements``: add an item; without ``sort_order`` it goes to the end.
- ``PUT /requirements/{id}``: edit an item; refused (409) if it has answers and
  the belt or kind changes (description, expected answer, category and order
  stay editable).
- ``DELETE /requirements/{id}``: remove an item; refused (409) if any exam has
  an answer for it.
"""

import logging
import uuid
from typing import Any

from domain.errors import NotFoundError, ValidationError
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


def _next_sort_order(belt_id: str) -> int:
    items = requirement_repo.list_by_belt(belt_id)
    return max((item.sort_order for item in items), default=0) + 1


def _get_or_404(requirement_id: str) -> Requirement:
    requirement = requirement_repo.get_requirement(requirement_id)
    if requirement is None:
        raise NotFoundError(MSG_REQUIREMENT_NOT_FOUND)
    return requirement


@api_handler
def list_requirements(event: Event, context: Any) -> Response:
    """List items, optionally filtered by belt and kind."""
    require_examiner(current_user(event))
    kind = _kind_filter(event)
    belt_id = query_param(event, "belt_id")
    belts = belt_repo.list_belts()

    if belt_id:
        if belt_id not in {belt.id for belt in belts}:
            raise NotFoundError("Faixa não encontrada")
        items = requirement_repo.list_by_belt(belt_id)
    else:
        items = requirement_repo.list_all()
    if kind:
        items = [item for item in items if item.kind == kind]
    return json_response(200, [item.to_dict() for item in sort_requirements(items, belts)])


@api_handler
def create_requirement(event: Event, context: Any) -> Response:
    """Add an item to a belt."""
    user = current_user(event)
    require_examiner(user)
    payload = json_body(event)
    belts_by_id = {belt.id: belt for belt in belt_repo.list_belts()}
    belt_id = payload.get("belt_id")
    default_order = _next_sort_order(belt_id) if belt_id in belts_by_id else 1
    requirement = build_requirement(
        payload,
        belts_by_id,
        requirement_id=str(uuid.uuid4()),
        default_sort_order=default_order,
    )
    requirement_repo.create_requirement(requirement)
    logger.info("Requirement %s created by %s", requirement.id, user.sub)
    return json_response(201, requirement.to_dict())


@api_handler
def update_requirement(event: Event, context: Any) -> Response:
    """Edit an item; belt and kind are locked while it has answers (checked in the write)."""
    user = current_user(event)
    require_examiner(user)
    existing = _get_or_404(path_param(event, "id", not_found=MSG_REQUIREMENT_NOT_FOUND))
    updated = build_requirement(
        json_body(event),
        {belt.id: belt for belt in belt_repo.list_belts()},
        requirement_id=existing.id,
        default_sort_order=existing.sort_order,
    )
    requirement_repo.save_requirement(updated)
    logger.info("Requirement %s updated by %s", updated.id, user.sub)
    return json_response(200, updated.to_dict())


@api_handler
def delete_requirement(event: Event, context: Any) -> Response:
    """Remove an item that has no answers (conditional delete on ``answer_count``)."""
    user = current_user(event)
    require_examiner(user)
    requirement = _get_or_404(path_param(event, "id", not_found=MSG_REQUIREMENT_NOT_FOUND))
    requirement_repo.delete_requirement(requirement.id)
    logger.info("Requirement %s deleted by %s", requirement.id, user.sub)
    return no_content()
