"""Belt routes: ``GET /belts`` (any logged user) and ``PUT /belts/{id}`` (examiners)."""

import logging
from typing import Any

from domain.belts import MSG_BELT_NOT_FOUND, apply_belt_update, apply_examiner_belt_update
from domain.errors import NotFoundError
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
from repository import belts as belt_repo

logger = logging.getLogger(__name__)


@api_handler
def list_belts(event: Event, context: Any) -> Response:
    """List every belt in graduation order."""
    current_user(event)
    return json_response(200, [belt.to_dict() for belt in belt_repo.list_belts()])


@api_handler
def update_belt(event: Event, context: Any) -> Response:
    """Edit a belt (RN001, RN002, RN015); belts are never created or deleted through the API.

    Checks, in order: examiner (403), path id (404), the belt (404), the body
    (400), the master rule (403) and, for the master, unique name and order
    (409). The admin master changes every field and rewrites the whole belt.
    Any other examiner changes only ``min_age_years`` and
    ``min_months_previous``: other fields must keep the stored values (the
    form sends them all), and the write touches only those two, so a
    concurrent edit by the master is kept.
    """
    user = current_user(event)
    require_examiner(user)
    belt_id = path_param(event, "id", not_found=MSG_BELT_NOT_FOUND)
    if user.is_master:
        belts = belt_repo.list_belts()
        existing = next((belt for belt in belts if belt.id == belt_id), None)
        if existing is None:
            raise NotFoundError(MSG_BELT_NOT_FOUND)
        updated = apply_belt_update(existing, json_body(event), belts)
        belt_repo.save_belt(updated)
    else:
        existing = belt_repo.get_belt(belt_id, consistent=True)
        if existing is None:
            raise NotFoundError(MSG_BELT_NOT_FOUND)
        updated = belt_repo.save_examiner_fields(
            apply_examiner_belt_update(existing, json_body(event))
        )
    logger.info("Belt %s updated by %s (master: %s)", belt_id, user.sub, user.is_master)
    return json_response(200, updated.to_dict())
