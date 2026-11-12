"""Belts: seed data, RN015 and the belt routes."""

from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, belt, belt_id, response_json

from domain.belts import SEED_BELTS, BeltLevel, apply_belt_update, next_belt, previous_belt
from domain.errors import ConflictError, ValidationError
from handlers import belts as belt_handlers
from handlers import seed
from repository import belts as belt_repo


def _payload(**overrides: Any) -> dict[str, Any]:
    data = belt("Cinza").to_dict()
    data.pop("id")
    data.update(overrides)
    return data


def test_seed_has_twelve_belts_in_order() -> None:
    assert [b.sort_order for b in SEED_BELTS] == list(range(12))
    assert SEED_BELTS[0].name == "Branca" and SEED_BELTS[0].kyu is None
    assert SEED_BELTS[-1].name == "Marrom" and SEED_BELTS[-1].level == BeltLevel.INTERMEDIATE


def test_next_and_previous_belt() -> None:
    assert next_belt(belt("Cinza"), SEED_BELTS) == belt("Cinza/Azul")
    assert previous_belt(belt("Cinza"), SEED_BELTS) == belt("Branca/Cinza")
    assert previous_belt(belt("Branca"), SEED_BELTS) is None


def test_rn015_valid_edit() -> None:
    updated = apply_belt_update(
        belt("Cinza"), _payload(min_age_years=6, color_primary="#abcdef"), SEED_BELTS
    )
    assert updated.min_age_years == 6
    assert updated.color_primary == "#ABCDEF"
    assert updated.id == belt_id("Cinza")


def test_rn015_name_must_be_unique() -> None:
    with pytest.raises(ConflictError, match="nome"):
        apply_belt_update(belt("Cinza"), _payload(name="azul"), SEED_BELTS)


def test_rn015_order_must_be_unique() -> None:
    with pytest.raises(ConflictError, match="ordem"):
        apply_belt_update(belt("Cinza"), _payload(sort_order=4), SEED_BELTS)


@pytest.mark.parametrize(
    "overrides",
    [
        {"min_age_years": -1},
        {"min_months_previous": -1},
        {"color_primary": "red"},
        {"color_secondary": "#12345"},
        {"level": "ADVANCED"},
        {"name": ""},
        {"name": "x" * 41},
    ],
)
def test_rn015_rejects_invalid_fields(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        apply_belt_update(belt("Cinza"), _payload(**overrides), SEED_BELTS)


@pytest.mark.parametrize(
    "color",
    [
        "\n#9E9E9E",
        "#9E9E9E\r\n",
        "#9E9E9E\r",
        "#9E9E9E\n\n",
        "#9E9E9E ",
        " #9E9E9E",
        "#9E9E9E\t",
        "#9E9E9E\x00",
        "#9E9\nE9E",
    ],
)
@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("color_primary", "Cor: use o formato #RRGGBB"),
        ("color_secondary", "Cor das pontas: use o formato #RRGGBB"),
    ],
)
def test_rn015_colour_with_whitespace_or_control_characters_is_refused(
    field: str, message: str, color: str
) -> None:
    # Colours are not trimmed: anything besides the seven characters is refused.
    with pytest.raises(ValidationError) as raised:
        apply_belt_update(belt("Cinza"), _payload(**{field: color}), SEED_BELTS)
    assert str(raised.value) == message


@pytest.mark.parametrize("field", ["color_primary", "color_secondary"])
def test_rn015_valid_colours_are_stored_in_upper_case(field: str) -> None:
    for color in ("#9e9e9e", "#9E9E9E", "#aBcDeF", "#000000", "#ffffff"):
        updated = apply_belt_update(belt("Cinza"), _payload(**{field: color}), SEED_BELTS)
        assert getattr(updated, field) == color.upper()


def test_seed_is_idempotent_and_keeps_edits(aws: None) -> None:
    assert seed.seed_all() == {"belts": 12, "requirements": 692}
    edited = apply_belt_update(belt("Cinza"), _payload(min_age_years=6), SEED_BELTS)
    belt_repo.save_belt(edited)

    assert seed.seed_all() == {"belts": 0, "requirements": 0}
    belts = belt_repo.list_belts()
    assert len(belts) == 12
    assert next(b for b in belts if b.name == "Cinza").min_age_years == 6


def test_list_belts_route(seeded: list) -> None:
    response = belt_handlers.list_belts(api_event(GUARDIAN), None)
    assert response["statusCode"] == 200
    assert [b["name"] for b in response_json(response)][:3] == ["Branca", "Branca/Cinza", "Cinza"]


def test_list_belts_requires_login(seeded: list) -> None:
    assert belt_handlers.list_belts(api_event(None), None)["statusCode"] == 401


def test_rn015_only_examiner_edits_belt(seeded: list) -> None:
    event = api_event(GUARDIAN, path={"id": belt_id("Cinza")}, body=_payload(min_age_years=6))
    response = belt_handlers.update_belt(event, None)
    assert response["statusCode"] == 403
    assert response_json(response)["message"] == "Esta área é dos examinadores"


def test_rn015_examiner_edits_belt(seeded: list) -> None:
    event = api_event(EXAMINER, path={"id": belt_id("Cinza")}, body=_payload(min_age_years=6))
    response = belt_handlers.update_belt(event, None)
    assert response["statusCode"] == 200
    assert belt_repo.get_belt(belt_id("Cinza")).min_age_years == 6


def test_rn015_conflict_returns_409(seeded: list) -> None:
    event = api_event(EXAMINER, path={"id": belt_id("Cinza")}, body=_payload(name="Azul"))
    assert belt_handlers.update_belt(event, None)["statusCode"] == 409
