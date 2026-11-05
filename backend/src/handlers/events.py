"""Exam event routes, examiners only (RN016).

- ``GET /events``: list, most recent first (§ 6.5).
- ``POST /events``: create (``status`` defaults to ``OPEN``).
- ``GET /events/{id}``: read one event.
- ``PUT /events/{id}``: edit ``name`` and ``status`` (reopening is allowed);
  ``exam_date`` is immutable.
- ``DELETE /events/{id}``: remove an event without exams.
"""

import logging
from typing import Any

from domain import dates
from domain import events as event_rules
from domain.errors import ConflictError, NotFoundError
from domain.events import MSG_EVENT_HAS_EXAMS, MSG_EVENT_NOT_FOUND, ExamEvent
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    no_content,
    path_param,
    require_examiner,
)
from repository import events as event_repo
from repository import exams as exam_repo

logger = logging.getLogger(__name__)


def _get_or_404(event_id: str) -> ExamEvent:
    exam_event = event_repo.get_event(event_id)
    if exam_event is None:
        raise NotFoundError(MSG_EVENT_NOT_FOUND)
    return exam_event


@api_handler
def list_events(event: Event, context: Any) -> Response:
    """List events from the most recent to the oldest."""
    require_examiner(current_user(event))
    items = event_rules.sort_events(event_repo.list_all())
    return json_response(200, [item.to_dict() for item in items])


@api_handler
def create_event(event: Event, context: Any) -> Response:
    """Create an event."""
    user = current_user(event)
    require_examiner(user)
    exam_event = event_rules.create_event(json_body(event), now_iso=dates.utc_now_iso())
    event_repo.create_event(exam_event)
    logger.info("Event %s created by %s", exam_event.id, user.sub)
    return json_response(201, exam_event.to_dict())


@api_handler
def get_event(event: Event, context: Any) -> Response:
    """Return an event."""
    require_examiner(current_user(event))
    return json_response(
        200, _get_or_404(path_param(event, "id", not_found=MSG_EVENT_NOT_FOUND)).to_dict()
    )


@api_handler
def update_event(event: Event, context: Any) -> Response:
    """Edit an event's name and status."""
    user = current_user(event)
    require_examiner(user)
    existing = _get_or_404(path_param(event, "id", not_found=MSG_EVENT_NOT_FOUND))
    updated = event_rules.update_event(existing, json_body(event), now_iso=dates.utc_now_iso())
    event_repo.save_event(updated)
    logger.info("Event %s updated by %s (status %s)", updated.id, user.sub, updated.status)
    return json_response(200, updated.to_dict())


@api_handler
def delete_event(event: Event, context: Any) -> Response:
    """Delete an event without exams (RN016)."""
    user = current_user(event)
    require_examiner(user)
    exam_event = _get_or_404(path_param(event, "id", not_found=MSG_EVENT_NOT_FOUND))
    # Quick answer for exams already visible; the conditional delete on
    # ``exam_count`` is what guarantees it under concurrency.
    if exam_repo.event_has_exams(exam_event.id):
        raise ConflictError(MSG_EVENT_HAS_EXAMS)
    event_repo.delete_event(exam_event.id)
    logger.info("Event %s deleted by %s", exam_event.id, user.sub)
    return no_content()
