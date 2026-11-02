"""Exam events (RN016): name, reference date and open/closed status."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import date
from enum import StrEnum
from typing import Any

from domain import validation
from domain.errors import ValidationError

MAX_NAME = 80

MSG_EVENT_NOT_FOUND = "Evento não encontrado"
MSG_EVENT_HAS_EXAMS = "Evento possui exames registrados"


class EventStatus(StrEnum):
    """Event status; a closed event blocks attendance and marking (RN016)."""

    OPEN = "OPEN"
    CLOSED = "CLOSED"


@dataclass(frozen=True)
class ExamEvent:
    """An exam session; ``exam_date`` is the reference for age and waiting time."""

    id: str
    name: str
    exam_date: date
    status: EventStatus
    created_at: str
    updated_at: str

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
        }


def _status(payload: dict[str, Any], default: EventStatus) -> EventStatus:
    if payload.get("status") is None:
        return default
    return validation.enum_field(payload, "status", "Situação", EventStatus)


def create_event(payload: dict[str, Any], now_iso: str) -> ExamEvent:
    """Build a new event; ``status`` defaults to ``OPEN``.

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
    )


def update_event(existing: ExamEvent, payload: dict[str, Any], now_iso: str) -> ExamEvent:
    """Apply an edit to ``name`` and ``status`` (a closed event may be reopened).

    ``exam_date`` is immutable after creation; resending the current value is
    allowed because the form always sends every field.

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
    return replace(existing, name=name, status=status, updated_at=now_iso)


def sort_events(events: Iterable[ExamEvent]) -> list[ExamEvent]:
    """Return events from the most recent to the oldest (§ 6.5).

    Ties on ``exam_date`` are broken by creation (newest first), then by id,
    so the order is stable.
    """
    return sorted(events, key=lambda ev: (ev.exam_date, ev.created_at, ev.id), reverse=True)
