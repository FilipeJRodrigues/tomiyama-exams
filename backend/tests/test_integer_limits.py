"""Ceilings of the integer fields (RN015): business limits plus the DynamoDB cap.

Every integer read from a request body is capped at 38 digits, the most DynamoDB
stores, and the editable numbers of belts and requirements have business ceilings.
The value at the ceiling is accepted; one past it is a 400 with a pt-BR message.
"""

import json
from typing import Any

import pytest
from conftest import EXAMINER, MASTER, api_event, response_json

from domain import validation
from domain.belts import (
    MASTER_ONLY_FIELDS,
    MAX_MIN_AGE_YEARS,
    MAX_MIN_MONTHS_PREVIOUS,
    MAX_SORT_ORDER,
)
from domain.errors import ValidationError
from domain.requirements import MAX_SORT_ORDER as MAX_REQUIREMENT_SORT_ORDER
from domain.users import User
from handlers import belts as belt_handlers
from handlers import requirements as requirement_handlers
from repository import belts as belt_repo
from repository import requirements as requirement_repo


def _event(payload: dict, path: dict[str, str] | None = None, *, user: User = EXAMINER) -> dict:
    event = api_event(user, path=path)
    event["body"] = json.dumps(payload)
    event["isBase64Encoded"] = False
    return event


# --- int_field: global cap ---------------------------------------------------------


@pytest.mark.parametrize("value", [validation.MAX_STORABLE_INT, -validation.MAX_STORABLE_INT])
def test_rn015_int_field_accepts_38_digits(value: int) -> None:
    assert validation.int_field({"n": value}, "n", "Número") == value


@pytest.mark.parametrize(
    "value", [validation.MAX_STORABLE_INT + 1, -validation.MAX_STORABLE_INT - 1, 10**4000]
)
def test_rn015_int_field_refuses_more_than_38_digits(value: int) -> None:
    with pytest.raises(ValidationError, match="^Número: deve ter no máximo 38 dígitos$"):
        validation.int_field({"n": value}, "n", "Número")


def test_rn015_int_field_cap_applies_with_only_minimum() -> None:
    with pytest.raises(ValidationError, match="38 dígitos"):
        validation.int_field({"n": 10**38}, "n", "Número", minimum=0)


# --- belts -------------------------------------------------------------------------
# Only the admin master changes the order (#142); any examiner changes age and months.


def _belt_editor(field: str) -> User:
    return MASTER if field in MASTER_ONLY_FIELDS else EXAMINER


BELT_LIMITS = [
    ("sort_order", MAX_SORT_ORDER, "Ordem: deve estar entre 0 e 99"),
    ("min_age_years", MAX_MIN_AGE_YEARS, "Idade mínima: deve estar entre 0 e 99"),
    ("min_months_previous", MAX_MIN_MONTHS_PREVIOUS, "Carência: deve estar entre 0 e 240"),
]


def test_rn015_belt_limits_are_the_documented_ones() -> None:
    assert (MAX_SORT_ORDER, MAX_MIN_AGE_YEARS, MAX_MIN_MONTHS_PREVIOUS) == (99, 99, 240)


@pytest.mark.parametrize(("field", "maximum", "message"), BELT_LIMITS)
def test_rn015_belt_field_at_ceiling_is_accepted(
    seeded: list, field: str, maximum: int, message: str
) -> None:
    target = belt_repo.list_belts()[-1]
    payload = {**target.to_dict(), field: maximum}

    response = belt_handlers.update_belt(
        _event(payload, path={"id": target.id}, user=_belt_editor(field)), None
    )

    assert response["statusCode"] == 200
    saved = {belt.id: belt for belt in belt_repo.list_belts()}[target.id]
    assert getattr(saved, field) == maximum


@pytest.mark.parametrize(("field", "maximum", "message"), BELT_LIMITS)
def test_rn015_belt_field_past_ceiling_is_400(
    seeded: list, field: str, maximum: int, message: str
) -> None:
    before = belt_repo.list_belts()
    target = before[-1]
    payload = {**target.to_dict(), field: maximum + 1}

    response = belt_handlers.update_belt(
        _event(payload, path={"id": target.id}, user=_belt_editor(field)), None
    )

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": message}
    assert belt_repo.list_belts() == before


# --- requirements ------------------------------------------------------------------


def _requirement_payload(belt_id: str, sort_order: Any) -> dict:
    return {
        "belt_id": belt_id,
        "kind": "THEORY",
        "category": "Categoria",
        "description": "Descrição",
        "sort_order": sort_order,
    }


def test_rn015_requirement_sort_order_limit_is_9999() -> None:
    assert MAX_REQUIREMENT_SORT_ORDER == 9999


def test_rn015_requirement_sort_order_at_ceiling_is_accepted(seeded: list) -> None:
    payload = _requirement_payload(seeded[0].id, MAX_REQUIREMENT_SORT_ORDER)

    response = requirement_handlers.create_requirement(_event(payload), None)

    assert response["statusCode"] == 201
    [saved] = requirement_repo.list_all()
    assert saved.sort_order == MAX_REQUIREMENT_SORT_ORDER


def test_rn015_requirement_sort_order_past_ceiling_is_400_on_create(seeded: list) -> None:
    payload = _requirement_payload(seeded[0].id, MAX_REQUIREMENT_SORT_ORDER + 1)

    response = requirement_handlers.create_requirement(_event(payload), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Ordem: deve estar entre 0 e 9999"}
    assert requirement_repo.list_all() == []


@pytest.mark.parametrize("value", [MAX_REQUIREMENT_SORT_ORDER + 1, 10**38])
def test_rn015_requirement_sort_order_past_ceiling_is_400_on_update(
    seeded: list, value: int
) -> None:
    created = requirement_handlers.create_requirement(
        _event(_requirement_payload(seeded[0].id, 1)), None
    )
    requirement_id = response_json(created)["id"]
    before = requirement_repo.list_all()

    response = requirement_handlers.update_requirement(
        _event(_requirement_payload(seeded[0].id, value), path={"id": requirement_id}), None
    )

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Ordem: deve estar entre 0 e 9999"}
    assert requirement_repo.list_all() == before


def test_rn015_default_sort_order_past_ceiling_asks_for_explicit_order(seeded: list) -> None:
    requirement_handlers.create_requirement(
        _event(_requirement_payload(seeded[0].id, MAX_REQUIREMENT_SORT_ORDER)), None
    )
    before = requirement_repo.list_all()
    payload = _requirement_payload(seeded[0].id, None)

    response = requirement_handlers.create_requirement(_event(payload), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {
        "message": "Ordem: a faixa já tem um item na ordem 9999; informe a ordem do novo item"
    }
    assert requirement_repo.list_all() == before


def test_rn015_default_sort_order_at_ceiling_is_accepted(seeded: list) -> None:
    requirement_handlers.create_requirement(
        _event(_requirement_payload(seeded[0].id, MAX_REQUIREMENT_SORT_ORDER - 1)), None
    )

    response = requirement_handlers.create_requirement(
        _event(_requirement_payload(seeded[0].id, None)), None
    )

    assert response["statusCode"] == 201
    assert response_json(response)["sort_order"] == MAX_REQUIREMENT_SORT_ORDER


def test_rn015_full_belt_still_accepts_explicit_order(seeded: list) -> None:
    requirement_handlers.create_requirement(
        _event(_requirement_payload(seeded[0].id, MAX_REQUIREMENT_SORT_ORDER)), None
    )

    response = requirement_handlers.create_requirement(
        _event(_requirement_payload(seeded[0].id, 5)), None
    )

    assert response["statusCode"] == 201
    assert len(requirement_repo.list_all()) == 2


# --- other integer fields keep their ceilings ---------------------------------------


@pytest.mark.parametrize(
    ("field", "label", "bounds", "message"),
    [
        ("kyu", "Kyū", (1, 11), "Kyū: deve estar entre 1 e 11"),
        ("stripes", "Graus", (0, 4), "Graus: deve estar entre 0 e 4"),
    ],
)
def test_rn015_bounded_fields_refuse_huge_values(
    field: str, label: str, bounds: tuple[int, int], message: str
) -> None:
    minimum, maximum = bounds
    assert validation.int_field({field: maximum}, field, label, minimum=minimum, maximum=maximum)
    for value in (maximum + 1, 10**38, 10**4000):
        with pytest.raises(ValidationError) as exc:
            validation.int_field({field: value}, field, label, minimum=minimum, maximum=maximum)
        assert str(exc.value) == message
