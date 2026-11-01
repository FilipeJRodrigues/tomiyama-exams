"""Score percentages per requirement kind, always recomputed (RN007)."""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from domain.requirements import Requirement, RequirementKind

_ONE_DECIMAL = Decimal("0.1")


@dataclass(frozen=True)
class KindScore:
    """Score of one requirement kind.

    Attributes:
        kind: Theory or practice.
        total: Items of this kind in the target belt.
        marked: Items with an answer.
        correct: Items answered as correct.
        percent: ``correct / total * 100`` with one decimal; None when total is 0.
    """

    kind: RequirementKind
    total: int
    marked: int
    correct: int
    percent: Decimal | None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return {
            "kind": self.kind.value,
            "total": self.total,
            "marked": self.marked,
            "correct": self.correct,
            "percent": float(self.percent) if self.percent is not None else None,
        }


def score(
    requirements: Iterable[Requirement], answers: Mapping[str, bool]
) -> dict[RequirementKind, KindScore]:
    """Compute the score per kind.

    Unmarked items count as not correct. Answers for items outside the given
    requirements are ignored.

    Args:
        requirements: Items of the target belt.
        answers: ``requirement_id -> correct`` for the marked items.

    Returns:
        A score for each requirement kind.
    """
    scores: dict[RequirementKind, KindScore] = {}
    requirements = list(requirements)
    for kind in RequirementKind:
        ids = [req.id for req in requirements if req.kind == kind]
        marked = [answers[req_id] for req_id in ids if req_id in answers]
        correct = sum(1 for value in marked if value)
        percent = None
        if ids:
            percent = (Decimal(correct) * 100 / Decimal(len(ids))).quantize(
                _ONE_DECIMAL, rounding=ROUND_HALF_UP
            )
        scores[kind] = KindScore(kind, len(ids), len(marked), correct, percent)
    return scores
