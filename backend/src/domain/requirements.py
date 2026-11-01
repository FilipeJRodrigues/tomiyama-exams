"""Belt requirements: one record per evaluated item."""

from dataclasses import dataclass
from enum import StrEnum


class RequirementKind(StrEnum):
    """Theory or practice item; percentages are computed per kind (RN007)."""

    THEORY = "THEORY"
    PRACTICE = "PRACTICE"


@dataclass(frozen=True)
class Requirement:
    """An item evaluated in the exam for a belt."""

    id: str
    belt_id: str
    kind: RequirementKind
    category: str
    description: str
    expected_answer: str | None
    sort_order: int
