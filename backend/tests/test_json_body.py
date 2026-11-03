"""Reading the request body (handlers.http.json_body) never ends in a 500.

Anything that is not a JSON object is a 400 "Corpo da requisição inválido:
envie um objeto JSON"; a body above the size cap is a 413 "Corpo da requisição
grande demais". Both go through the same domain error path as every other
response (api_handler).
"""

import base64
import json
import os
import random
from typing import Any

import boto3
import pytest
from conftest import EXAMINER, api_event, response_json

from domain.errors import PayloadTooLargeError, ValidationError
from domain.images import MAX_IMAGE_BYTES
from handlers import events as event_handlers
from handlers import logos as logo_handlers
from handlers.http import (
    MAX_BODY_BASE64_CHARS,
    MAX_BODY_BYTES,
    MSG_BODY_TOO_LARGE,
    MSG_INVALID_BODY,
    json_body,
)
from repository import events as event_repo

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ENCODINGS = pytest.mark.parametrize("encoded", [False, True], ids=["plain", "base64"])


def _event(raw: str | bytes, encoded: bool, path: dict[str, str] | None = None) -> dict[str, Any]:
    event = api_event(EXAMINER, path=path)
    data = raw.encode("utf-8") if isinstance(raw, str) else raw
    if encoded:
        event["body"] = base64.b64encode(data).decode("ascii")
        event["isBase64Encoded"] = True
    else:
        event["body"] = raw if isinstance(raw, str) else data.decode("utf-8", "replace")
        event["isBase64Encoded"] = False
    return event


def _padded_object(size: int, filler: str = "x") -> str:
    """A JSON object whose UTF-8 encoding has exactly ``size`` bytes."""
    skeleton = '{"pad": ""}'
    count = (size - len(skeleton)) // len(filler.encode("utf-8"))
    text = '{"pad": "' + filler * count + '"}'
    assert len(text.encode("utf-8")) == size
    return text


# --- NaN, Infinity and floats that overflow ---------------------------------


@ENCODINGS
@pytest.mark.parametrize(
    "raw",
    [
        '{"value": NaN}',
        '{"value": Infinity}',
        '{"value": -Infinity}',
        '{"value": 1e999}',
        '{"value": -1e999}',
        '{"value": 1.5e400}',
        '{"list": [1, 2, {"deep": NaN}]}',
        '{"list": [0.5, 1E+999]}',
        "NaN",
        "1e999",
    ],
)
def test_non_finite_numbers_are_400(raw: str, encoded: bool) -> None:
    with pytest.raises(ValidationError) as exc:
        json_body(_event(raw, encoded))

    assert exc.value.message == MSG_INVALID_BODY


@ENCODINGS
def test_finite_floats_are_still_accepted(encoded: bool) -> None:
    body = json_body(_event('{"a": 1.5, "b": -2e10, "c": 1e-999, "d": 10}', encoded))

    assert body == {"a": 1.5, "b": -2e10, "c": 0.0, "d": 10}


@ENCODINGS
def test_rn016_nan_in_event_body_is_400_and_nothing_is_stored(aws: None, encoded: bool) -> None:
    raw = '{"name": "Exame", "exam_date": "2026-12-01", "status": "OPEN", "x": NaN}'

    response = event_handlers.create_event(_event(raw, encoded), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_BODY}
    assert event_repo.list_all() == []


# --- Size cap (413) ----------------------------------------------------------


def test_cap_leaves_room_for_the_largest_logo() -> None:
    logo = PNG_SIGNATURE + b"\x00" * (MAX_IMAGE_BYTES - len(PNG_SIGNATURE))
    body = json.dumps({"content_type": "image/png", "data": base64.b64encode(logo).decode()})

    assert len(body.encode("utf-8")) < MAX_BODY_BYTES
    assert MAX_BODY_BYTES == 3_145_728
    assert MAX_BODY_BASE64_CHARS >= len(base64.b64encode(b"\x00" * MAX_BODY_BYTES))


@ENCODINGS
def test_body_of_exactly_the_cap_is_accepted(encoded: bool) -> None:
    body = json_body(_event(_padded_object(MAX_BODY_BYTES), encoded))

    assert len(body["pad"]) == MAX_BODY_BYTES - len('{"pad": ""}')


@ENCODINGS
def test_body_one_byte_above_the_cap_is_413(encoded: bool) -> None:
    with pytest.raises(PayloadTooLargeError) as exc:
        json_body(_event(_padded_object(MAX_BODY_BYTES + 1), encoded))

    assert exc.value.status_code == 413
    assert exc.value.message == MSG_BODY_TOO_LARGE


def test_cap_counts_utf8_bytes_not_characters() -> None:
    # "é" is 2 bytes in UTF-8: fewer characters than the cap, more bytes.
    raw = _padded_object(MAX_BODY_BYTES + 1, filler="é")
    assert len(raw) < MAX_BODY_BYTES

    with pytest.raises(PayloadTooLargeError):
        json_body(_event(raw, encoded=False))


def test_oversized_base64_is_413_before_being_decoded() -> None:
    # Not even valid base64: only the length check can answer, and it is 413.
    event = api_event(EXAMINER)
    event["body"] = "!" * (MAX_BODY_BASE64_CHARS + 1)
    event["isBase64Encoded"] = True

    with pytest.raises(PayloadTooLargeError):
        json_body(event)


@ENCODINGS
def test_rn012_logo_of_exactly_2_mb_is_still_accepted(images_bucket: str, encoded: bool) -> None:
    logo = PNG_SIGNATURE + b"\x00" * (MAX_IMAGE_BYTES - len(PNG_SIGNATURE))
    raw = json.dumps({"content_type": "image/png", "data": base64.b64encode(logo).decode()})

    response = logo_handlers.put_logo(_event(raw, encoded, {"slot": "primary"}), None)

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["size"] == MAX_IMAGE_BYTES


@ENCODINGS
def test_rn012_logo_body_above_the_cap_is_413_and_nothing_is_stored(
    images_bucket: str, encoded: bool
) -> None:
    raw = _padded_object(MAX_BODY_BYTES + 1)

    response = logo_handlers.put_logo(_event(raw, encoded, {"slot": "primary"}), None)

    assert response["statusCode"] == 413
    assert response_json(response) == {"message": MSG_BODY_TOO_LARGE}
    listed = boto3.client("s3").list_objects_v2(Bucket=images_bucket)
    assert listed.get("Contents", []) == []
    table = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    assert table.scan()["Items"] == []


@ENCODINGS
def test_rn016_event_body_above_the_cap_is_413(aws: None, encoded: bool) -> None:
    response = event_handlers.create_event(
        _event(_padded_object(MAX_BODY_BYTES + 1), encoded), None
    )

    assert response["statusCode"] == 413
    assert response_json(response) == {"message": MSG_BODY_TOO_LARGE}
    assert event_repo.list_all() == []


# --- Many varied bodies: always a dict or a ValidationError -----------------

SEEDS = [
    '{"name": "Exame", "status": "OPEN"}',
    '{"content_type": "image/png", "data": "iVBORw0KGgo="}',
    '{"a": [1, 2.5, true, false, null, {"b": "ç"}]}',
    "[1, 2, 3]",
    '"text"',
    "42",
]
TOKENS = [
    "{", "}", "[", "]", ",", ":", '"', "\\", "\\u", "\\ud800", "NaN", "Infinity",
    "-", "1e999", "1" * 5000, "0x10", "true", "null", "é", "\x00", "﻿", " ",
]  # fmt: skip


def _random_body(rng: random.Random) -> str | bytes:
    kind = rng.randrange(5)
    if kind == 0:  # raw bytes (an image, garbage)
        return bytes(rng.randrange(256) for _ in range(rng.randrange(1, 64)))
    if kind == 1:  # random tokens glued together
        return "".join(rng.choice(TOKENS) for _ in range(rng.randrange(1, 12)))
    if kind == 2:  # deep nesting
        depth = rng.choice([10, 1000, 5000, 20000])
        opener = rng.choice(["[", '{"a":'])
        closer = "]" if opener == "[" else "}"
        return opener * depth + "1" + closer * depth
    text = list(rng.choice(SEEDS))
    for _ in range(rng.randrange(1, 4)):  # mutate a valid body
        pos = rng.randrange(len(text) + 1)
        if kind == 3 and text:
            del text[min(pos, len(text) - 1)]
        else:
            text.insert(pos, rng.choice(TOKENS))
    return "".join(text)


def _random_cases(count: int, seed: int) -> list[tuple[str | bytes, bool]]:
    rng = random.Random(seed)
    return [(_random_body(rng), rng.random() < 0.5) for _ in range(count)]


@pytest.mark.parametrize("seed", range(4))
def test_any_body_is_a_dict_or_a_validation_error(seed: int) -> None:
    for raw, encoded in _random_cases(150, seed):
        try:
            result = json_body(_event(raw, encoded))
        except ValidationError as exc:
            assert exc.message == MSG_INVALID_BODY
        else:
            assert isinstance(result, dict), (raw, encoded)


@pytest.mark.parametrize("body", [None, "", 123, ["{}"], b"{}"], ids=repr)
def test_missing_or_non_text_body_is_400(body: Any) -> None:
    event = api_event(EXAMINER)
    event["body"] = body

    with pytest.raises(ValidationError):
        json_body(event)


# --- Escaped lone surrogates --------------------------------------------------

SURROGATE = chr(92) + "ud800"


@ENCODINGS
@pytest.mark.parametrize(
    "raw",
    [
        '{"k' + SURROGATE + '": 1}',
        '{"list": [1, "a", {"deep": ["x' + SURROGATE + '"]}]}',
        '{"a": ' * 900 + '"' + SURROGATE + '"' + "}" * 900,
        "[" * 900 + '"' + SURROGATE + '"' + "]" * 900,
    ],
    ids=["key", "nested", "deep-object", "deep-array"],
)
def test_lone_surrogate_anywhere_is_400(raw: str, encoded: bool) -> None:
    with pytest.raises(ValidationError) as caught:
        json_body(_event(raw, encoded))

    assert caught.value.message == MSG_INVALID_BODY


@ENCODINGS
def test_valid_surrogate_pair_escape_is_accepted(encoded: bool) -> None:
    raw = '{"name": "Judo ' + chr(92) + "ud83e" + chr(92) + 'udd4b"}'

    assert json_body(_event(raw, encoded)) == {"name": "Judo \U0001f94b"}


def test_deeply_nested_valid_body_is_still_accepted() -> None:
    raw = '{"a": ' * 950 + '"ok"' + "}" * 950

    body = json_body(_event(raw, False))

    assert isinstance(body, dict)
