"""QA coverage for json_body: surrogate edge cases, legitimate text and big bodies.

Complements tests/test_json_body.py: escapes that look like a pair but are not
one, uppercase and raw (unescaped) legitimate text, and 3 MiB bodies with a
lone surrogate at the very end or with hundreds of thousands of strings, which
must still answer quickly.
"""

import base64
import time
from typing import Any

import pytest
from conftest import EXAMINER, api_event

from domain.errors import ValidationError
from handlers.http import MAX_BODY_BYTES, MSG_INVALID_BODY, json_body

B = chr(92)
ENCODINGS = pytest.mark.parametrize("encoded", [False, True], ids=["plain", "base64"])
# Generous bound: the walk over a 3 MiB body takes tens of milliseconds locally.
TIME_BUDGET_SECONDS = 2.0


def _event(raw: str, encoded: bool) -> dict[str, Any]:
    event = api_event(EXAMINER)
    if encoded:
        event["body"] = base64.b64encode(raw.encode("utf-8")).decode("ascii")
        event["isBase64Encoded"] = True
    else:
        event["body"] = raw
        event["isBase64Encoded"] = False
    return event


@ENCODINGS
@pytest.mark.parametrize(
    "text",
    [
        B + "udc00" + B + "ud800",  # low before high: two lone surrogates
        B + "ud800" + B + "u0041",  # high followed by a normal character
        B + "ud800" + B + "ud800",  # two highs
        "abc" + B + "udfff",  # lone low at the end
    ],
    ids=["reversed-pair", "high-then-letter", "two-highs", "low-at-end"],
)
def test_broken_surrogate_pairs_are_400(text: str, encoded: bool) -> None:
    with pytest.raises(ValidationError) as caught:
        json_body(_event('{"name": "' + text + '"}', encoded))

    assert caught.value.message == MSG_INVALID_BODY


@ENCODINGS
def test_lone_surrogate_in_top_level_string_is_400(encoded: bool) -> None:
    with pytest.raises(ValidationError) as caught:
        json_body(_event('"' + B + 'ud800"', encoded))

    assert caught.value.message == MSG_INVALID_BODY


@ENCODINGS
def test_uppercase_surrogate_pair_escape_is_accepted(encoded: bool) -> None:
    raw = '{"name": "Judô ' + B + "uD83E" + B + 'uDD4B"}'

    assert json_body(_event(raw, encoded)) == {"name": "Judô \U0001f94b"}


@ENCODINGS
def test_raw_accents_and_emoji_are_accepted(encoded: bool) -> None:
    raw = '{"full_name": "Conceição Ñuñez 🥋", "notes": ["ação", "faixa marrom 🟫"]}'

    assert json_body(_event(raw, encoded)) == {
        "full_name": "Conceição Ñuñez 🥋",
        "notes": ["ação", "faixa marrom 🟫"],
    }


@ENCODINGS
def test_lone_surrogate_at_the_end_of_a_3_mib_body_is_400_quickly(encoded: bool) -> None:
    filler = (B + "u00e9") * ((MAX_BODY_BYTES - 30) // 6)
    raw = '{"a": "' + filler + B + 'ud800"}'
    assert len(raw.encode("utf-8")) <= MAX_BODY_BYTES

    start = time.perf_counter()
    with pytest.raises(ValidationError):
        json_body(_event(raw, encoded))

    assert time.perf_counter() - start < TIME_BUDGET_SECONDS


@ENCODINGS
def test_3_mib_body_with_many_strings_is_parsed_quickly(encoded: bool) -> None:
    count = (MAX_BODY_BYTES - 20) // 4
    raw = '{"a": [' + ",".join(['"x"'] * count) + "]}"
    assert len(raw.encode("utf-8")) <= MAX_BODY_BYTES

    start = time.perf_counter()
    body = json_body(_event(raw, encoded))

    assert time.perf_counter() - start < TIME_BUDGET_SECONDS
    assert len(body["a"]) == count
