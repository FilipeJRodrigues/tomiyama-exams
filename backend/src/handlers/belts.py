"""Belt routes: ``GET /belts`` (any logged user) and ``PUT /belts/{id}`` (examiners)."""

import logging
from typing import Any

from domain.belts import apply_belt_update
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

MSG_BELT_NOT_FOUND = "Faixa não encontrada"


@api_handler
def list_belts(event: Event, context: Any) -> Response:
    """List every belt in graduation order."""
    current_user(event)
    return json_response(200, [belt.to_dict() for belt in belt_repo.list_belts()])


@api_handler
def update_belt(event: Event, context: Any) -> Response:
    """Edit a belt (RN015); belts are never created or deleted through the API."""
    user = current_user(event)
    require_examiner(user)
    belt_id = path_param(event, "id", not_found=MSG_BELT_NOT_FOUND)
    belts = belt_repo.list_belts()
    existing = next((belt for belt in belts if belt.id == belt_id), None)
    if existing is None:
        raise NotFoundError(MSG_BELT_NOT_FOUND)
    updated = apply_belt_update(existing, json_body(event), belts)
    belt_repo.save_belt(updated)
    logger.info("Belt %s updated by %s", belt_id, user.sub)
    return json_response(200, updated.to_dict())
