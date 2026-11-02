"""Exam answers: each item marked as correct or wrong by an examiner (RN006).

One answer per (exam, item); marking again replaces the previous answer while
the exam is in progress (RN010) and the event is open (RN016). An item without
an answer is "not marked" and counts as not correct (RN007).
"""

from dataclasses import dataclass
from typing import Any

from domain.errors import ValidationError
from domain.events import ExamEvent
from domain.exams import MSG_EVENT_CLOSED, Exam, ExamStatus
from domain.requirements import Requirement

MSG_EXAM_DECIDED = "Exame já decidido"
MSG_ITEM_NOT_IN_BELT = "Item não pertence à faixa do exame"
MSG_INVALID_CORRECT = "Marcação inválida: envie correct como true (certo) ou false (errado)"
MSG_MARK_TRY_AGAIN = "Outra marcação está em andamento. Tente de novo."
MSG_BUSY_TRY_AGAIN = "Sistema ocupado no momento. Tente de novo em instantes."


@dataclass(frozen=True)
class ExamAnswer:
    """The mark of one item in one exam."""

    exam_id: str
    requirement_id: str
    correct: bool
    marked_by: str
    marked_at: str

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return {
            "requirement_id": self.requirement_id,
            "correct": self.correct,
            "marked_by": self.marked_by,
            "marked_at": self.marked_at,
        }


def parse_correct(payload: dict[str, Any]) -> bool:
    """Return the ``correct`` field of a marking request.

    Raises:
        ValidationError: If missing or not a boolean.
    """
    value = payload.get("correct")
    if not isinstance(value, bool):
        raise ValidationError(MSG_INVALID_CORRECT)
    return value


def ensure_can_mark(exam: Exam, event: ExamEvent, requirement: Requirement) -> None:
    """Check that the item may be marked or unmarked in the exam now (RN006).

    Raises:
        ValidationError: If the exam is decided (RN010), the event is closed
            (RN016) or the item is not of the exam's target belt.
    """
    if exam.status != ExamStatus.IN_PROGRESS:
        raise ValidationError(MSG_EXAM_DECIDED)
    if not event.is_open:
        raise ValidationError(MSG_EVENT_CLOSED)
    if requirement.belt_id != exam.target_belt_id:
        raise ValidationError(MSG_ITEM_NOT_IN_BELT)


def mark(
    exam: Exam,
    event: ExamEvent,
    requirement: Requirement,
    *,
    correct: bool,
    marked_by: str,
    now_iso: str,
) -> ExamAnswer:
    """Build the answer of a marking (RN006), recording who marked and when.

    Raises:
        ValidationError: See ``ensure_can_mark``.
    """
    ensure_can_mark(exam, event, requirement)
    return ExamAnswer(
        exam_id=exam.id,
        requirement_id=requirement.id,
        correct=correct,
        marked_by=marked_by,
        marked_at=now_iso,
    )
