"""Exam eligibility, always computed and never stored (RN001–RN004)."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import Any

from domain.belts import Belt, BeltLevel, next_belt
from domain.dates import full_months, full_years
from domain.students import Student

# CBJ art. 2 §4: the minimum time on the current belt is waived from 16 full years.
WAITING_PERIOD_WAIVER_AGE = 16


class ExamKind(StrEnum):
    """Stripe exam (keeps the belt) or belt exam (moves to the next belt)."""

    STRIPE = "STRIPE"
    BELT = "BELT"


@dataclass(frozen=True)
class Eligibility:
    """Result of the eligibility check.

    Attributes:
        target_belt: Next belt, or None when there is none (brown belt).
        kind: Exam kind, or None when there is no target belt.
        reasons: Blocking messages in pt-BR; empty when eligible.
    """

    target_belt: Belt | None
    kind: ExamKind | None
    reasons: tuple[str, ...]

    @property
    def eligible(self) -> bool:
        """Whether no rule blocks the exam."""
        return not self.reasons

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return {
            "eligible": self.eligible,
            "kind": self.kind.value if self.kind else None,
            "target_belt_id": self.target_belt.id if self.target_belt else None,
            "target_belt_name": self.target_belt.name if self.target_belt else None,
            "reasons": list(self.reasons),
        }


def exam_kind(current: Belt, stripes: int) -> ExamKind:
    """Return the exam kind (RN004).

    Intermediate belts (Laranja, Verde, Roxa) take a stripe exam before the belt
    exam: with no stripes the exam is a stripe exam; with one or more, a belt exam.
    Basic belts always take a belt exam.
    """
    if current.level == BeltLevel.INTERMEDIATE and stripes == 0:
        return ExamKind.STRIPE
    return ExamKind.BELT


def evaluate(student: Student, belts: Iterable[Belt], reference: date) -> Eligibility:
    """Evaluate whether the student may take the next exam on the reference date.

    Args:
        student: Student being evaluated.
        belts: Every belt.
        reference: Event date (or today when there is no event).

    Returns:
        The target belt, the exam kind and the blocking reasons, if any.
    """
    belts = list(belts)
    current = next((belt for belt in belts if belt.id == student.current_belt_id), None)
    if current is None:
        return Eligibility(None, None, ("Faixa atual não encontrada",))

    target = next_belt(current, belts)
    if target is None:
        return Eligibility(None, None, ("Faixa preta é exame da federação",))

    kind = exam_kind(current, student.stripes)
    age = full_years(student.birth_date, reference)
    reasons: list[str] = []

    if kind == ExamKind.BELT and age < target.min_age_years:
        reasons.append(f"Idade mínima para a faixa {target.name}: {target.min_age_years} anos")

    required_months = target.min_months_previous
    if kind == ExamKind.STRIPE:
        required_months //= 2
    months = full_months(student.current_belt_since, reference)
    if age < WAITING_PERIOD_WAIVER_AGE and months < required_months:
        reasons.append(
            f"Carência mínima de {required_months} meses na faixa atual "
            f"(faltam {required_months - months})"
        )

    return Eligibility(target, kind, tuple(reasons))
