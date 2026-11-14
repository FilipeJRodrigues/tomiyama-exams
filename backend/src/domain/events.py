"""Exam events (RN016): name, reference date, open/closed status and requirement profile.

Each event chooses the requirement profile (``profile_id``, default: the main
one) whose items make up the sheet of its exams (RN006, RN007). The profile
may change only while the event has no exams (decision of 2026-11-12, #144).
An event stored before the profiles existed has no ``profile_id`` and is read
as an event of the main profile.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import date
from enum import StrEnum
from typing import Any

from domain import validation
from domain.errors import ConflictError, ValidationError
from domain.requirement_profiles import (
    MAIN_PROFILE_ID,
    ProfileStatus,
    RequirementProfile,
    profile_id_field,
)

MAX_NAME = 80

MSG_EVENT_NOT_FOUND = "Evento não encontrado"
MSG_EVENT_HAS_EXAMS = "Evento possui exames registrados"
MSG_EVENT_PROFILE_COPYING = (
    "O perfil ainda está sendo copiado. Aguarde o fim da cópia para usá-lo em um evento."
)
MSG_EVENT_PROFILE_DELETING = "O perfil está sendo excluído e não pode ser usado em um evento."
MSG_EVENT_PROFILE_LOCKED = (
    "O perfil de requisitos do evento não pode ser alterado depois que o evento tem exames"
)
MSG_EVENT_TRY_AGAIN = "Outra alteração está em andamento. Tente de novo."


class EventStatus(StrEnum):
    """Event status; a closed event blocks attendance and marking (RN016)."""

    OPEN = "OPEN"
    CLOSED = "CLOSED"


@dataclass(frozen=True)
class ExamEvent:
    """An exam session; ``exam_date`` is the reference for age and waiting time.

    ``profile_id`` is the requirement profile of the event's exam sheets
    (``main`` unless the event chose another one).
    """

    id: str
    name: str
    exam_date: date
    status: EventStatus
    created_at: str
    updated_at: str
    profile_id: str = MAIN_PROFILE_ID

    @property
    def is_open(self) -> bool:
        """Whether attendance and marking are allowed."""
        return self.status == EventStatus.OPEN

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return {
            "id": self.id,
            "name": self.name,
            "exam_date": self.exam_date.isoformat(),
            "status": self.status.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "profile_id": self.profile_id,
        }


def _status(payload: dict[str, Any], default: EventStatus) -> EventStatus:
    if payload.get("status") is None:
        return default
    return validation.enum_field(payload, "status", "Situação", EventStatus)


def check_profile_usable(profile: RequirementProfile) -> None:
    """Allow an event to choose ``profile``: only a profile whose items are complete.

    Raises:
        ConflictError: If the profile is not ``READY`` (still being copied, or
            being deleted), with the message of its status.
    """
    if profile.status is ProfileStatus.DELETING:
        raise ConflictError(MSG_EVENT_PROFILE_DELETING)
    if profile.status is not ProfileStatus.READY:
        raise ConflictError(MSG_EVENT_PROFILE_COPYING)


def create_event(payload: dict[str, Any], now_iso: str) -> ExamEvent:
    """Build a new event; ``status`` defaults to ``OPEN`` and ``profile_id`` to the main profile.

    Whether the chosen profile exists and is ready is checked by the caller.

    Raises:
        ValidationError: If a field is invalid.
    """
    return ExamEvent(
        id=str(uuid.uuid4()),
        name=validation.required_str(payload, "name", "Nome", MAX_NAME),
        exam_date=validation.date_field(payload, "exam_date", "Data do exame"),
        status=_status(payload, EventStatus.OPEN),
        created_at=now_iso,
        updated_at=now_iso,
        profile_id=profile_id_field(payload) or MAIN_PROFILE_ID,
    )


def update_event(existing: ExamEvent, payload: dict[str, Any], now_iso: str) -> ExamEvent:
    """Apply an edit to ``name``, ``status`` (a closed event may be reopened) and ``profile_id``.

    ``exam_date`` is immutable after creation; resending the current value is
    allowed because the form always sends every field. ``profile_id`` missing
    or blank keeps the current profile. When the result has another
    ``profile_id`` than ``existing``, the caller checks the new profile and
    that the event has no exams.

    Raises:
        ValidationError: If a field is invalid or ``exam_date`` changes.
    """
    name = validation.required_str(payload, "name", "Nome", MAX_NAME)
    status = _status(payload, existing.status)
    raw_date = payload.get("exam_date")
    if raw_date is not None and raw_date != "":
        new_date = validation.parse_date(raw_date, "Data do exame")
        if new_date != existing.exam_date:
            raise ValidationError("A data do evento não pode ser alterada")
    profile_id = profile_id_field(payload) or existing.profile_id
    return replace(existing, name=name, status=status, updated_at=now_iso, profile_id=profile_id)


def sort_events(events: Iterable[ExamEvent]) -> list[ExamEvent]:
    """Return events from the most recent to the oldest (§ 6.5).

    Ties on ``exam_date`` are broken by creation (newest first), then by id,
    so the order is stable.
    """
    return sorted(events, key=lambda ev: (ev.exam_date, ev.created_at, ev.id), reverse=True)
