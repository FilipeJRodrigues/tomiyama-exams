"""RN007 — percentage of correct answers per kind."""

from decimal import Decimal

from domain.requirements import Requirement, RequirementKind
from domain.scoring import score


def _req(req_id: str, kind: RequirementKind) -> Requirement:
    return Requirement(req_id, "belt", kind, "Categoria", "Descrição", None, 0)


THEORY = [_req(f"t{i}", RequirementKind.THEORY) for i in range(1, 5)]
PRACTICE = [_req(f"p{i}", RequirementKind.PRACTICE) for i in range(1, 4)]


def test_rn007_percent_per_kind_with_unmarked_as_wrong() -> None:
    result = score(THEORY + PRACTICE, {"t1": True, "t2": True, "t3": False, "p1": True})
    theory = result[RequirementKind.THEORY]
    practice = result[RequirementKind.PRACTICE]
    assert (theory.total, theory.marked, theory.correct, theory.percent) == (
        4,
        3,
        2,
        Decimal("50.0"),
    )
    assert (practice.total, practice.marked, practice.correct) == (3, 1, 1)
    assert practice.percent == Decimal("33.3")


def test_rn007_rounds_half_up_to_one_decimal() -> None:
    # 29 of 40 = 72.5%; 1 of 8 = 12.5%; 2 of 3 = 66.666... -> 66.7
    reqs = [_req(f"t{i}", RequirementKind.THEORY) for i in range(40)]
    answers = {f"t{i}": True for i in range(29)}
    assert score(reqs, answers)[RequirementKind.THEORY].percent == Decimal("72.5")
    assert score(PRACTICE, {"p1": True, "p2": True})[RequirementKind.PRACTICE].percent == Decimal(
        "66.7"
    )


def test_rn007_kind_without_items_has_no_percent() -> None:
    result = score(PRACTICE, {})
    assert result[RequirementKind.THEORY].percent is None
    assert result[RequirementKind.THEORY].to_dict()["percent"] is None
    assert result[RequirementKind.PRACTICE].percent == Decimal("0.0")


def test_rn007_ignores_answers_outside_target_belt() -> None:
    result = score(THEORY, {"t1": True, "other": True})
    assert result[RequirementKind.THEORY].correct == 1
    assert result[RequirementKind.THEORY].marked == 1
