"""QA coverage for the belt colour format (RN015) through ``PUT /belts/{id}``.

A colour is exactly ``#`` plus six ASCII hexadecimal digits. Anything else is
refused with 400 and nothing is written: line breaks and other white space at
either end or in the middle, Unicode line separators, non-ASCII digits and
look-alike characters, wrong lengths and values that are not strings.
Card #103.
"""

import os
from typing import Any

import boto3
import pytest
from conftest import EXAMINER, api_event, belt, response_json

from domain import validation
from domain.belts import Belt
from domain.errors import ValidationError
from handlers import belts as belt_handlers

FIELDS = [
    ("color_primary", "Cor: use o formato #RRGGBB"),
    ("color_secondary", "Cor das pontas: use o formato #RRGGBB"),
]

BAD_TEXT_COLOURS = [
    # Line breaks and white space, at the end, at the start and in the middle.
    "#9E9E9E\n",
    "#9E9E9E\r\n",
    "#9E9E9E\r",
    "#9E9E9E\n\n",
    "\n#9E9E9E",
    "#9E9E9E ",
    " #9E9E9E",
    " #9E9E9E ",
    "#9E9E9E\t",
    "#9E9E9E\x00",
    "\x00#9E9E9E",
    "#9E9E9E\x0b",
    "#9E9E9E\x0c",
    "#9E9E9E\x1c",
    "#9E9\nE9E",
    "#9E9E9\n",
    "#9E9E9 ",
    # Unicode line separators and invisible characters.
    "#9E9E9E ",
    "#9E9E9E ",
    "#9E9E9E\u0085",
    "#9E9E9E ",
    "#9E9E9E​",
    "#9E9E9E﻿",
    "﻿#9E9E9E",
    "#9E9E9 ",
    # Digits and letters that are not ASCII.
    "#١٢٣٤٥٦",  # Arabic-Indic digits
    "#１２３４５６",  # fullwidth digits
    "#१२३४५६",  # Devanagari digits
    "#9E9E9Ｅ",  # fullwidth E
    "#ＡＢＣＤＥＦ",  # fullwidth A-F
    "#9E9E9Е",  # Cyrillic Ye, looks like E
    "＃9E9E9E",  # fullwidth number sign
    "﹟9E9E9E",  # small number sign
    # Wrong length or shape.
    "#",
    "#9E9E9",
    "#9E9E9E9",
    "#9E9E9E9E",
    "#9E9",
    "9E9E9E",
    "9E9E9E#",
    "##9E9E9E",
    "#9E9E9G",
    "#9E9E9g",
    "#9E 9E9",
    "#-9E9E9",
    "#+9E9E9",
    "#0x9E9E",
    "#9E9E9E#9E9E9E",
    "#9E9E9E\n#9E9E9E",
    "rgb(158,158,158)",
    "gray",
    " ",
    "\n",
]

BAD_TYPED_COLOURS: list[Any] = [
    ["#9E9E9E"],
    [],
    {"hex": "#9E9E9E"},
    {},
    10395294,
    0,
    1.5,
    True,
    False,
]


def _stored_belts() -> list[str]:
    """Return the raw items of the belts table (strongly consistent)."""
    table = boto3.resource("dynamodb").Table(os.environ["BELTS_TABLE"])
    items = table.scan(ConsistentRead=True)["Items"]
    assert len(items) == 12
    return sorted(repr(sorted(item.items())) for item in items)


def _form(source: Belt, **changes: Any) -> dict[str, Any]:
    return {**{key: value for key, value in source.to_dict().items() if key != "id"}, **changes}


def _put(source: Belt, **changes: Any) -> dict[str, Any]:
    return belt_handlers.update_belt(
        api_event(EXAMINER, body=_form(source, **changes), path={"id": source.id}), None
    )


@pytest.mark.parametrize(("field", "message"), FIELDS)
def test_rn015_route_refuses_every_malformed_colour_and_writes_nothing(
    seeded: list[Belt], field: str, message: str
) -> None:
    cinza = belt("Cinza")
    before = _stored_belts()

    for color in [*BAD_TEXT_COLOURS, *BAD_TYPED_COLOURS]:
        response = _put(cinza, **{field: color})

        assert response["statusCode"] == 400, (color, response.get("body"))
        assert response_json(response) == {"message": message}, repr(color)
        assert _stored_belts() == before, repr(color)


def test_rn015_route_refuses_both_colours_malformed_reporting_the_first(
    seeded: list[Belt],
) -> None:
    cinza = belt("Cinza")
    before = _stored_belts()

    response = _put(cinza, color_primary="#9E9E9E\n", color_secondary="#FFFFFF\n")

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Cor: use o formato #RRGGBB"}
    assert _stored_belts() == before


def test_rn015_route_refusal_does_not_echo_the_value_sent(seeded: list[Belt]) -> None:
    response = _put(belt("Cinza"), color_primary="#9E9E9E\n<script>")

    assert response["statusCode"] == 400
    assert "script" not in response["body"]
    assert "\\n" not in response["body"]


@pytest.mark.parametrize("field", ["color_primary", "color_secondary"])
@pytest.mark.parametrize(
    "color",
    ["#9e9e9e", "#9E9E9E", "#aBcDeF", "#000000", "#ffffff", "#FFFFFF", "#012345", "#6789ab"],
)
def test_rn015_route_stores_valid_colours_in_upper_case(
    seeded: list[Belt], field: str, color: str
) -> None:
    cinza = belt("Cinza")

    response = _put(cinza, **{field: color})

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response)[field] == color.upper()
    listed = response_json(belt_handlers.list_belts(api_event(EXAMINER), None))
    stored = next(item for item in listed if item["id"] == cinza.id)
    assert stored[field] == color.upper()
    assert len(stored[field]) == 7


@pytest.mark.parametrize("empty", ["", None])
def test_rn015_route_empty_secondary_colour_means_no_tips(
    seeded: list[Belt], empty: str | None
) -> None:
    two_colours = belt("Cinza/Azul")
    assert two_colours.color_secondary is not None

    response = _put(two_colours, color_secondary=empty)

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response)["color_secondary"] is None


def test_rn015_route_missing_secondary_colour_means_no_tips(seeded: list[Belt]) -> None:
    two_colours = belt("Cinza/Azul")
    form = _form(two_colours)
    del form["color_secondary"]

    response = belt_handlers.update_belt(
        api_event(EXAMINER, body=form, path={"id": two_colours.id}), None
    )

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response)["color_secondary"] is None


@pytest.mark.parametrize("empty", ["", None])
def test_rn015_route_primary_colour_is_required(seeded: list[Belt], empty: str | None) -> None:
    cinza = belt("Cinza")
    before = _stored_belts()

    response = _put(cinza, color_primary=empty)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Campo obrigatório: Cor"}
    assert _stored_belts() == before


def test_rn015_colour_pattern_has_no_end_anchor_that_admits_a_line_break() -> None:
    # Every one of the 256 one-character suffixes and prefixes below U+0100 is refused,
    # as well as the line boundaries of ``str.splitlines``.
    extras = [chr(code) for code in range(0x100)] + [" ", " ", "\r\n"]
    for extra in extras:
        for value in ("#9E9E9E" + extra, extra + "#9E9E9E", "#9E9E9" + extra):
            if value == "#9E9E9" + extra and extra in set("0123456789abcdefABCDEF"):
                continue
            with pytest.raises(ValidationError):
                validation.hex_color({"c": value}, "c", "Cor", required=True)
