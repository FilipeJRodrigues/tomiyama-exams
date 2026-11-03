"""Image orders of events not covered elsewhere (RN012, qa of #19).

Invariant (backend/README.md, "O que pode sobrar"): an orphan object may be
left, but never metadata pointing to a missing object.
"""

import base64
import os
from typing import Any

import boto3
from conftest import (
    MASTER,
    api_event,
    read_signature_image,
    response_json,
    signature_image_meta,
    signature_object_keys,
)

from domain.settings import SETTINGS_ID
from handlers import signatures as handlers
from repository import images as image_repo
from repository import signatures as signature_repo

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
JPEG = b"\xff\xd8\xff" + b"\xe0\x00\x10JFIF" + b"\x02" * 40


def _img(data: bytes, ct: str) -> dict[str, Any]:
    return {"content_type": ct, "data": base64.b64encode(data).decode()}


def _setup() -> str:
    boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"]).put_item(
        Item={"id": SETTINGS_ID, "academy_name": "T"}
    )
    r = handlers.create_signature(api_event(MASTER, body={"name": "a", "graduation": "b"}), None)
    return response_json(r)["id"]


def _put(sid: str, data: bytes, ct: str) -> dict[str, Any]:
    return handlers.put_signature_image(
        api_event(MASTER, body=_img(data, ct), path={"id": sid}), None
    )


def _consistent(bucket: str, sid: str) -> None:
    meta = signature_image_meta(sid)
    if meta is not None:
        got = read_signature_image(bucket, sid)
        assert got is not None
        assert got[1] == meta["content_type"]


def test_rn012_upload_spanning_a_removal_and_another_upload_ends_coherent(
    images_bucket: str, monkeypatch: Any
) -> None:
    sid = _setup()
    assert _put(sid, PNG, "image/png")["statusCode"] == 200
    real = image_repo.put_image
    n: list[int] = []

    def hook(key: str, *a: Any, **k: Any) -> None:
        real(key, *a, **k)
        n.append(1)
        if len(n) == 1:
            p = api_event(MASTER, path={"id": sid})
            assert handlers.delete_signature_image(p, None)["statusCode"] == 204
            assert _put(sid, JPEG, "image/jpeg")["statusCode"] == 200

    monkeypatch.setattr(image_repo, "put_image", hook)
    assert _put(sid, PNG, "image/png")["statusCode"] == 200
    monkeypatch.undo()
    _consistent(images_bucket, sid)
    assert read_signature_image(images_bucket, sid) == (PNG, "image/png")
    assert len(signature_object_keys(images_bucket, sid)) == 1


def test_rn012_signature_removed_after_the_upload_commit_leaves_nothing(
    images_bucket: str, monkeypatch: Any
) -> None:
    sid = _setup()
    assert _put(sid, PNG, "image/png")["statusCode"] == 200
    real = signature_repo.apply_signatures

    def hook(*a: Any, **k: Any) -> Any:
        out = real(*a, **k)
        monkeypatch.setattr(signature_repo, "apply_signatures", real)
        assert (
            handlers.delete_signature(api_event(MASTER, path={"id": sid}), None)["statusCode"]
            == 204
        )
        return out

    monkeypatch.setattr(signature_repo, "apply_signatures", hook)
    r = _put(sid, JPEG, "image/jpeg")
    # Response view of a signature that is already gone: should not crash.
    assert r["statusCode"] == 200, r
    assert signature_image_meta(sid) is None
    assert signature_object_keys(images_bucket, sid) == []


def test_rn012_legacy_metadata_without_key_count_as_no_image(images_bucket: str) -> None:
    sid = _setup()
    t = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    item = t.get_item(Key={"id": "certificate_signatures"})["Item"]
    item["signatures"][0]["image"] = {
        "content_type": "image/png",
        "size": 1,
        "updated_at": "x",
        "updated_by": "y",
    }
    t.put_item(Item=item)
    boto3.client("s3").put_object(Bucket=images_bucket, Key=f"signatures/{sid}", Body=PNG)
    listed = response_json(handlers.list_signatures(api_event(MASTER), None))["signatures"][0]
    assert listed["complete"] is False and listed["image"] is None
    g = handlers.get_signature_image(api_event(MASTER, path={"id": sid}), None)
    assert g["statusCode"] == 404, g
    d = handlers.delete_signature_image(api_event(MASTER, path={"id": sid}), None)
    assert d["statusCode"] == 204
    assert _put(sid, JPEG, "image/jpeg")["statusCode"] == 200
    _consistent(images_bucket, sid)
