"""Student exams: attendance confirmation (RN005).

An exam is born when an examiner confirms the student's attendance at an open
event. The target belt and the exam kind are computed on the event date and
stored, so later belt edits do not change an exam in progress. The student's
graduation at that moment (belt, belt date, stripes) is stored too, so the
sensei's decision (RN008, RN009) can tell whether it changed since then.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import Any

from domain.belts import Belt
from domain.eligibility import ExamKind, evaluate
from domain.errors import ValidationError
from domain.events import MSG_EVENT_NOT_FOUND as MSG_EVENT_NOT_FOUND
from domain.events import ExamEvent
from domain.students import MSG_STUDENT_NOT_FOUND as MSG_STUDENT_NOT_FOUND
from domain.students import Student

MSG_ALREADY_CONFIRMED = "Presença já confirmada neste evento"
MSG_EXAM_NOT_FOUND = "Exame não encontrado"
MSG_EVENT_CLOSED = "Evento encerrado"
MSG_STUDENT_INACTIVE = "Aluno inativo não pode fazer exame"
MSG_STUDENT_CHANGED = "Os dados do aluno mudaram. Tente de novo."
MSG_TRY_AGAIN = "Outra confirmação está em andamento. Tente de novo."
MSG_EXAM_DECIDED = "Exame já decidido"


class ExamStatus(StrEnum):
    """Exam status: in progress until the sensei decides (RN007)."""

    IN_PROGRESS = "IN_PROGRESS"
    APPROVED = "APPROVED"
    FAILED = "FAILED"


@dataclass(frozen=True)
class Graduation:
    """A student's belt, belt date and stripes at some moment."""

    belt_id: str
    belt_since: date
    stripes: int

    @classmethod
    def of(cls, student: Student) -> "Graduation":
        """Return the student's current graduation."""
        return cls(student.current_belt_id, student.current_belt_since, student.stripes)


@dataclass(frozen=True)
class Exam:
    """A student's exam in an event; unique per (event, student).

    ``source`` is the student's graduation when the attendance was confirmed.
    It is None only for exams confirmed before it was stored.
    """

    id: str
    event_id: str
    student_id: str
    target_belt_id: str
    kind: ExamKind
    status: ExamStatus
    decided_by_id: str | None
    decided_at: str | None
    notes: str | None
    created_by: str
    created_at: str
    source: Graduation | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        source = self.source
        return {
            "id": self.id,
            "event_id": self.event_id,
            "student_id": self.student_id,
            "target_belt_id": self.target_belt_id,
            "kind": self.kind.value,
            "status": self.status.value,
            "decided_by_id": self.decided_by_id,
            "decided_at": self.decided_at,
            "notes": self.notes,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "source_belt_id": source.belt_id if source else None,
            "source_belt_since": source.belt_since.isoformat() if source else None,
            "source_stripes": source.stripes if source else None,
        }


def confirm_attendance(
    event: ExamEvent,
    student: Student,
    belts: Iterable[Belt],
    confirmed_by: str,
    now_iso: str,
) -> Exam:
    """Build the exam created by an attendance confirmation (RN005).

    Eligibility (RN001–RN004) is evaluated on the event date, never on today.

    Args:
        event: Event where attendance is confirmed.
        student: Student attending.
        belts: Every belt.
        confirmed_by: Id of the examiner confirming the attendance.
        now_iso: Current UTC timestamp.

    Returns:
        The new exam, in progress, with target belt and kind computed and the
        student's current graduation as its source.

    Raises:
        ValidationError: If the event is closed (RN016), the student is inactive
            or not eligible (the message carries the blocking reasons).
    """
    if not event.is_open:
        raise ValidationError(MSG_EVENT_CLOSED)
    if not student.active:
        raise ValidationError(MSG_STUDENT_INACTIVE)
    result = evaluate(student, belts, event.exam_date)
    if not result.eligible or result.target_belt is None or result.kind is None:
        raise ValidationError("; ".join(result.reasons))
    return Exam(
        id=str(uuid.uuid4()),
        event_id=event.id,
        student_id=student.id,
        target_belt_id=result.target_belt.id,
        kind=result.kind,
        status=ExamStatus.IN_PROGRESS,
        decided_by_id=None,
        decided_at=None,
        notes=None,
        created_by=confirmed_by,
        created_at=now_iso,
        source=Graduation.of(student),
    )
