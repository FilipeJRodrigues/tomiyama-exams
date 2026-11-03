"""Certificate signatures (RN012): a sensei replaced mid-request writes nothing on any route.

The handler reads the sensei at the start; the write transaction checks it
again. ``test_signatures.py`` covers the create; here every other write route
(edit, reorder, removal of the signature and of its image) answers 403 and
leaves the list and the bucket as they were.
"""

import base64
import os
from collections.abc import Callable
from typing import Any

import boto3
import pytest
from conftest import MASTER, api_event, read_signature_image, response_json, signature_image_key

from domain.settings import SETTINGS_ID
from domain.signatures import SIGNATURES_ID
from domain.users import ADMIN_GROUP, User
from handlers import signatures as handlers
from repository import settings as settings_repo

SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
MSG_FORBIDDEN = "Somente o master e o sensei gerem as assinaturas"


def _settings_table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])


def _set_sensei(sub: str) -> None:
    _settings_table().put_item(
        Item={"id": SETTINGS_ID, "academy_name": "Tomiyama", "sensei_user_id": sub}
    )


def _bucket_keys(bucket: str) -> list[str]:
    listed = boto3.client("s3").list_objects_v2(Bucket=bucket)
    return [item["Key"] for item in listed.get("Contents", [])]


def _other_id(signature_id: str) -> str:
    listed = handlers.list_signatures(api_event(MASTER), None)
    ids = [item["id"] for item in response_json(listed)["signatures"]]
    return next(item for item in ids if item != signature_id)


WRITES: dict[str, Callable[[str], dict[str, Any]]] = {
    "update": lambda sid: handlers.update_signature(
        api_event(SENSEI, body={"name": "Outro", "graduation": "x"}, path={"id": sid}), None
    ),
    "reorder": lambda sid: handlers.reorder_signatures(
        api_event(SENSEI, body={"ids": [_other_id(sid), sid]}), None
    ),
    "delete": lambda sid: handlers.delete_signature(api_event(SENSEI, path={"id": sid}), None),
    "delete-image": lambda sid: handlers.delete_signature_image(
        api_event(SENSEI, path={"id": sid}), None
    ),
}


@pytest.mark.parametrize("route", list(WRITES))
def test_rn012_sensei_replaced_mid_request_writes_nothing(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    _set_sensei(SENSEI.sub)
    created = handlers.create_signature(
        api_event(MASTER, body={"name": "Jigoro Kano", "graduation": "Fundador"}), None
    )
    signature_id = response_json(created)["id"]
    second = api_event(MASTER, body={"name": "Segunda", "graduation": None})
    assert handlers.create_signature(second, None)["statusCode"] == 201
    body = {"content_type": "image/png", "data": base64.b64encode(PNG_BYTES).decode("ascii")}
    image = api_event(MASTER, body=body, path={"id": signature_id})
    assert handlers.put_signature_image(image, None)["statusCode"] == 200
    before_item = _settings_table().get_item(Key={"id": SIGNATURES_ID})["Item"]
    image_key = signature_image_key(images_bucket, signature_id)
    assert image_key is not None
    assert _bucket_keys(images_bucket) == [image_key]
    # The handler's check still sees the old sensei; the transaction sees the new one.
    _set_sensei("someone-else")
    monkeypatch.setattr(settings_repo, "get_sensei_user_id", lambda: SENSEI.sub)

    response = WRITES[route](signature_id)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_FORBIDDEN}
    assert _settings_table().get_item(Key={"id": SIGNATURES_ID})["Item"] == before_item
    assert _bucket_keys(images_bucket) == [image_key]
    assert signature_image_key(images_bucket, signature_id) == image_key
    assert read_signature_image(images_bucket, signature_id) == (PNG_BYTES, "image/png")
