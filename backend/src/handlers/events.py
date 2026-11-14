"""Exam event routes, examiners only (RN016).

- ``GET /events``: list, most recent first (§ 6.5).
- ``POST /events``: create (``status`` defaults to ``OPEN``, ``profile_id`` to
  the main requirement profile).
- ``GET /events/{id}``: read one event.
- ``PUT /events/{id}``: edit ``name`` and ``status`` (reopening is allowed);
  ``exam_date`` is immutable; ``profile_id`` changes only while the event has
  no exams.
- ``DELETE /events/{id}``: remove an event without exams.

The event chooses the requirement profile of its exam sheets (#144, decision
of 2026-11-12): the profile must exist (404) and be ``READY`` (409).

Order of the refusals of ``PUT /events/{id}``: 401/403, invalid id or event
not found (404), body or field invalid (400; the fields are checked against
the stored event, e.g. the immutable date), new profile not found (404) or
not ready (409), event with exams (409). Nothing is written in any of them.
"""

import logging
from typing import Any

from domain import dates
from domain import events as event_rules
from domain import requirement_profiles as profile_rules
from domain.errors import ConflictError, NotFoundError
from domain.events import (
    MSG_EVENT_HAS_EXAMS,
    MSG_EVENT_NOT_FOUND,
    MSG_EVENT_PROFILE_LOCKED,
    ExamEvent,
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
    require_examiner,
)
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirement_profiles as profile_repo

logger = logging.getLogger(__name__)


def _get_or_404(event_id: str) -> ExamEvent:
    exam_event = event_repo.get_event(event_id)
    if exam_event is None:
        raise NotFoundError(MSG_EVENT_NOT_FOUND)
    return exam_event


def _check_profile(profile_id: str) -> None:
    """Check that an event may start using the profile: it exists and is ready.

    An early answer; for a stored profile, the event's write checks it again
    in the same transaction (``repository.events``). The main profile is not
    read.

    Raises:
        NotFoundError: If the profile does not exist.
        ConflictError: If the profile is still being copied.
    """
    profile = profile_rules.resolve_profile(profile_id, profile_repo.get_profile)
    event_rules.check_profile_usable(profile)


@api_handler
def list_events(event: Event, context: Any) -> Response:
    """List events from the most recent to the oldest."""
    require_examiner(current_user(event))
    items = event_rules.sort_events(event_repo.list_all())
    return json_response(200, [item.to_dict() for item in items])


@api_handler
def create_event(event: Event, context: Any) -> Response:
    """Create an event, with the requirement profile it chose (default: main)."""
    user = current_user(event)
    require_examiner(user)
    exam_event = event_rules.create_event(json_body(event), now_iso=dates.utc_now_iso())
    _check_profile(exam_event.profile_id)
    event_repo.create_event(exam_event)
    logger.info(
        "Event %s created by %s (profile %s)", exam_event.id, user.sub, exam_event.profile_id
    )
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
    """Edit an event's name, status and, while it has no exams, requirement profile."""
    user = current_user(event)
    require_examiner(user)
    existing = _get_or_404(path_param(event, "id", not_found=MSG_EVENT_NOT_FOUND))
    updated = event_rules.update_event(existing, json_body(event), now_iso=dates.utc_now_iso())
    if updated.profile_id == existing.profile_id:
        event_repo.save_event(updated)
    else:
        _check_profile(updated.profile_id)
        # Quick answer for exams already visible; the condition on
        # ``exam_count`` in the write is what guarantees it under concurrency.
        if exam_repo.event_has_exams(existing.id):
            raise ConflictError(MSG_EVENT_PROFILE_LOCKED)
        event_repo.change_event_profile(updated)
    logger.info(
        "Event %s updated by %s (status %s, profile %s)",
        updated.id,
        user.sub,
        updated.status,
        updated.profile_id,
    )
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
