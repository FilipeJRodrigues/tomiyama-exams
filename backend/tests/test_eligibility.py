"""Eligibility rules RN001–RN004 and the dates they depend on."""

from datetime import date

import pytest
from conftest import make_student

from domain.belts import SEED_BELTS
from domain.dates import full_months, full_years
from domain.eligibility import ExamKind, evaluate


@pytest.mark.parametrize(
    ("birth", "reference", "expected"),
    [
        (date(2018, 5, 10), date(2026, 5, 9), 7),
        (date(2018, 5, 10), date(2026, 5, 10), 8),
        (date(2018, 5, 10), date(2017, 1, 1), 0),
    ],
)
def test_full_years(birth: date, reference: date, expected: int) -> None:
    assert full_years(birth, reference) == expected


@pytest.mark.parametrize(
    ("start", "reference", "expected"),
    [
        (date(2026, 3, 14), date(2027, 3, 13), 11),
        (date(2026, 3, 14), date(2027, 3, 14), 12),
        (date(2026, 1, 31), date(2026, 2, 28), 1),
        (date(2026, 1, 31), date(2026, 2, 27), 0),
        (date(2026, 5, 1), date(2026, 4, 1), 0),
    ],
)
def test_full_months(start: date, reference: date, expected: int) -> None:
    assert full_months(start, reference) == expected


def test_rn001_blocks_below_minimum_age() -> None:
    # Azul -> Azul/Amarela requires 8 years; 7 years old on the exam date.
    student = make_student(belt_name="Azul", birth=date(2019, 6, 1), since=date(2025, 1, 1))
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert not result.eligible
    assert result.reasons == ("Idade mínima para a faixa Azul/Amarela: 8 anos",)


def test_rn001_allows_on_birthday() -> None:
    student = make_student(belt_name="Azul", birth=date(2019, 3, 13), since=date(2025, 1, 1))
    assert evaluate(student, SEED_BELTS, date(2027, 3, 13)).eligible


def test_rn001_age_not_checked_on_stripe_exam() -> None:
    # Laranja 0 stripes -> stripe exam towards Verde (min. 12 years); student is 11.
    student = make_student(belt_name="Laranja", birth=date(2015, 6, 1), since=date(2025, 1, 1))
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert result.kind == ExamKind.STRIPE
    assert result.eligible


def test_rn002_blocks_short_time_on_belt() -> None:
    # Cinza -> Cinza/Azul requires 6 months; only 4 completed.
    student = make_student(belt_name="Cinza", since=date(2026, 11, 1))
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert result.reasons == ("Carência mínima de 6 meses na faixa atual (faltam 2)",)


def test_rn002_stripe_exam_requires_half() -> None:
    # Verde -> Roxa requires 12 months; the stripe exam requires 6.
    student = make_student(belt_name="Verde", birth=date(2012, 1, 1), since=date(2026, 9, 14))
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert result.kind == ExamKind.STRIPE
    assert result.reasons == ("Carência mínima de 6 meses na faixa atual (faltam 1)",)


def test_rn002_waived_from_16_full_years() -> None:
    student = make_student(
        belt_name="Roxa", birth=date(2011, 3, 13), since=date(2027, 1, 1), stripes=1
    )
    assert evaluate(student, SEED_BELTS, date(2027, 3, 13)).eligible


def test_rn002_not_waived_at_15() -> None:
    student = make_student(
        belt_name="Roxa", birth=date(2011, 3, 14), since=date(2027, 1, 1), stripes=1
    )
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert result.reasons == ("Carência mínima de 12 meses na faixa atual (faltam 10)",)


def test_rn003_target_is_next_belt() -> None:
    student = make_student(belt_name="Branca", birth=date(2020, 1, 1), since=date(2026, 1, 1))
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert result.target_belt is not None
    assert result.target_belt.name == "Branca/Cinza"


def test_rn003_brown_belt_has_no_next() -> None:
    student = make_student(belt_name="Marrom", birth=date(2000, 1, 1), since=date(2020, 1, 1))
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert result.target_belt is None
    assert result.reasons == ("Faixa preta é exame da federação",)


@pytest.mark.parametrize(
    ("belt_name", "stripes", "kind", "target"),
    [
        ("Verde", 0, ExamKind.STRIPE, "Roxa"),
        ("Verde", 1, ExamKind.BELT, "Roxa"),
        ("Amarela/Laranja", 0, ExamKind.BELT, "Laranja"),
        ("Laranja", 0, ExamKind.STRIPE, "Verde"),
        ("Roxa", 2, ExamKind.BELT, "Marrom"),
    ],
)
def test_rn004_stripe_before_belt(
    belt_name: str, stripes: int, kind: ExamKind, target: str
) -> None:
    student = make_student(
        belt_name=belt_name, birth=date(2000, 1, 1), since=date(2020, 1, 1), stripes=stripes
    )
    result = evaluate(student, SEED_BELTS, date(2027, 3, 13))
    assert result.kind == kind
    assert result.target_belt is not None
    assert result.target_belt.name == target


def test_acceptance_ana_eligible_and_bruno_blocked() -> None:
    """Acceptance flow (requisitos § 9, step 4)."""
    exam_date = date(2027, 3, 13)
    ana = make_student(belt_name="Cinza", birth=date(2018, 5, 10), since=date(2026, 3, 14))
    bruno = make_student(belt_name="Azul", birth=date(2019, 6, 1), since=date(2025, 6, 1))

    ana_result = evaluate(ana, SEED_BELTS, exam_date)
    assert ana_result.eligible
    assert ana_result.kind == ExamKind.BELT
    assert ana_result.target_belt is not None and ana_result.target_belt.name == "Cinza/Azul"

    bruno_result = evaluate(bruno, SEED_BELTS, exam_date)
    assert bruno_result.reasons == ("Idade mínima para a faixa Azul/Amarela: 8 anos",)
