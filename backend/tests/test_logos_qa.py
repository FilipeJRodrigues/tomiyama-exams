"""Logos (RN012): cases added by QA on top of tests/test_logos.py.

A settings record created only by a logo upload, independent slots and base64
variants that must be refused.
"""

import base64
import os
from typing import Any

import boto3
import pytest
from conftest import EXAMINER, MASTER, api_event, response_json

from domain.images import MSG_INVALID_IMAGE
from domain.settings import SETTINGS_ID
from handlers import logos as handlers
from handlers import settings as settings_handlers

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\xfb\xff\xfe" * 10


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _put(body: Any, slot: str = "primary") -> dict[str, Any]:
    return handlers.put_logo(api_event(EXAMINER, body=body, path={"slot": slot}), None)


def _stored() -> dict[str, Any] | None:
    table = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    return table.get_item(Key={"id": SETTINGS_ID}).get("Item")


def test_rn012_settings_created_by_a_logo_look_empty_and_can_be_saved(
    user_pool: str, images_bucket: str
) -> None:
    empty = response_json(settings_handlers.get_settings(api_event(EXAMINER), None))
    assert _put({"content_type": "image/png", "data": _b64(PNG_BYTES)})["statusCode"] == 200

    after = response_json(settings_handlers.get_settings(api_event(EXAMINER), None))
    assert after == empty

    # An examiner who is not the master may save while there is no sensei.
    payload = {"academy_name": "Tomiyama", "sensei_user_id": None, "certificate_city": None}
    response = settings_handlers.update_settings(api_event(EXAMINER, body=payload), None)
    assert response["statusCode"] == 200
    stored = _stored()
    assert stored is not None
    assert stored["created_at"]
    assert stored["logo_primary"]["size"] == len(PNG_BYTES)


def test_rn012_slots_are_independent(images_bucket: str) -> None:
    body = {"content_type": "image/png", "data": _b64(PNG_BYTES)}
    assert _put(body, "primary")["statusCode"] == 200
    assert _put(body, "secondary")["statusCode"] == 200

    assert (
        handlers.delete_logo(api_event(MASTER, path={"slot": "primary"}), None)["statusCode"] == 204
    )

    assert (
        handlers.get_logo(api_event(EXAMINER, path={"slot": "primary"}), None)["statusCode"] == 404
    )
    secondary = handlers.get_logo(api_event(EXAMINER, path={"slot": "secondary"}), None)
    assert secondary["statusCode"] == 200
    assert set(response_json(secondary)) == {
        "slot",
        "url",
        "expires_in",
        "content_type",
        "size",
        "updated_at",
        "updated_by",
    }


@pytest.mark.parametrize(
    "data",
    [
        base64.urlsafe_b64encode(PNG_BYTES).decode("ascii"),
        " " + _b64(PNG_BYTES) + " ",
        "ção" + _b64(PNG_BYTES),
    ],
    ids=["urlsafe-alphabet", "surrounding-spaces", "non-ascii"],
)
def test_rn012_non_standard_base64_is_refused(images_bucket: str, data: str) -> None:
    response = _put({"content_type": "image/png", "data": data})

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_IMAGE}
    assert _stored() is None


@pytest.mark.parametrize("slot", ["primary ", "Primary", "primary%20", "secondary/"])
def test_rn012_slot_variants_are_404(images_bucket: str, slot: str) -> None:
    body = {"content_type": "image/png", "data": _b64(PNG_BYTES)}

    assert _put(body, slot)["statusCode"] == 404
    assert _stored() is None
