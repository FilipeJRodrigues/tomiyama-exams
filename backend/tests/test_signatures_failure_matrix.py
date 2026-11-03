"""Failure matrix of the signature image writes (RN012, qa of #19).

Every image operation (first upload, replacement, image removal, signature
removal) x every class of transaction failure x when the transaction is
recorded (before the error, after the answer, never), optionally with another
image operation in the middle. Invariant (backend/README.md, "O que pode
sobrar"): an orphan may be left, metadata never point to a missing object.
"""

import base64
import os
from typing import Any

import boto3
import pytest
from botocore.exceptions import (
    ClientError,
    ConnectionClosedError,
    EndpointConnectionError,
    ParamValidationError,
    ReadTimeoutError,
)
from conftest import MASTER, api_event, response_json, signature_object_keys

from domain.settings import SETTINGS_ID
from handlers import signatures as handlers
from repository import signatures as signature_repo
from repository import tables

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
JPEG = b"\xff\xd8\xff" + b"\xe0\x00\x10JFIF" + b"\x02" * 40


def _ce(code: str, reasons: list[str] | None = None) -> ClientError:
    resp: dict[str, Any] = {"Error": {"Code": code, "Message": "x"}}
    if reasons is not None:
        resp["CancellationReasons"] = [{"Code": r} for r in reasons]
    return ClientError(resp, "TransactWriteItems")


AMBIGUOUS = {
    "ise": lambda: _ce("InternalServerError"),
    "unavail": lambda: _ce("ServiceUnavailable"),
    "inprogress": lambda: _ce("TransactionInProgressException"),
    "idem": lambda: _ce("IdempotentParameterMismatchException"),
    "cancel-unknown": lambda: _ce("TransactionCanceledException", ["None", "Weird"]),
    "cancel-noreasons": lambda: _ce("TransactionCanceledException"),
    "closed": lambda: ConnectionClosedError(endpoint_url="https://x"),
    "readtimeout": lambda: ReadTimeoutError(endpoint_url="https://x"),
    "runtime": lambda: RuntimeError("boom"),
}
# Refused for sure, plus client-side errors the code keeps as ambiguous (safe).
DEFINITIVE = {
    "throttle": lambda: _ce("ThrottlingException"),
    "pte": lambda: _ce("ProvisionedThroughputExceededException"),
    "rle": lambda: _ce("RequestLimitExceeded"),
    "validation": lambda: _ce("ValidationException"),
    "cancel-validation": lambda: _ce("TransactionCanceledException", ["None", "ValidationError"]),
    "cancel-throttle": lambda: _ce("TransactionCanceledException", ["None", "ThrottlingError"]),
    "endpoint": lambda: EndpointConnectionError(endpoint_url="https://x"),
    "paramval": lambda: ParamValidationError(report="x"),
}


def _img(data: bytes, ct: str) -> dict[str, Any]:
    return {"content_type": ct, "data": base64.b64encode(data).decode()}


def _setup(with_image: bool) -> str:
    boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"]).put_item(
        Item={"id": SETTINGS_ID, "academy_name": "T"}
    )
    r = handlers.create_signature(api_event(MASTER, body={"name": "a", "graduation": "b"}), None)
    sid = response_json(r)["id"]
    if with_image:
        _put(sid, PNG, "image/png")
    return sid


def _put(sid: str, data: bytes = JPEG, ct: str = "image/jpeg") -> Any:
    return handlers.put_signature_image(
        api_event(MASTER, body=_img(data, ct), path={"id": sid}), None
    )


def _del_img(sid: str) -> Any:
    return handlers.delete_signature_image(api_event(MASTER, path={"id": sid}), None)


def _del_sig(sid: str) -> Any:
    return handlers.delete_signature(api_event(MASTER, path={"id": sid}), None)


OPS = {
    "upload-first": (_put, False),
    "upload-replace": (_put, True),
    "del-image": (_del_img, True),
    "del-sig": (_del_sig, True),
}
OTHERS = {"none": None, "upload": _put, "del-image": _del_img, "del-sig": _del_sig}


def _assert_every_key_exists(bucket: str) -> None:
    stored = signature_repo.get_signatures().signatures
    s3 = boto3.client("s3")
    for sig in stored:
        if sig.image_key is not None:
            s3.head_object(Bucket=bucket, Key=sig.image_key)  # raises if missing


def _run(
    bucket: str, monkeypatch: Any, op: str, other: str, err: Any, timing: str, other_when: str
) -> None:
    fn, with_image = OPS[op]
    sid = _setup(with_image)
    client = tables.table(tables.SETTINGS_TABLE_ENV).meta.client
    real = client.transact_write_items
    state = {"armed": True, "later": None}

    def fake(**kw: Any) -> Any:
        if not state["armed"]:
            return real(**kw)
        state["armed"] = False
        if other_when == "before" and OTHERS[other]:
            try:
                OTHERS[other](sid)
            except Exception:  # noqa: BLE001
                pass
        if timing == "now":
            real(**kw)
        elif timing == "later":
            state["later"] = kw
        if other_when == "after" and OTHERS[other]:
            try:
                OTHERS[other](sid)
            except Exception:  # noqa: BLE001
                pass
        raise err()

    monkeypatch.setattr(client, "transact_write_items", fake)
    try:
        fn(sid)
    except Exception:  # noqa: BLE001
        pass
    if state["later"] is not None:
        try:
            real(**state["later"])
        except ClientError:
            pass
    monkeypatch.undo()
    _assert_every_key_exists(bucket)


@pytest.mark.parametrize("timing", ["now", "later", "never"])
@pytest.mark.parametrize("err", ["ise", "closed", "cancel-unknown", "runtime"])
@pytest.mark.parametrize("op", list(OPS))
def test_rn012_ambiguous_failure_never_leaves_metadata_without_object(
    images_bucket: str, monkeypatch: Any, op: str, err: str, timing: str
) -> None:
    _run(images_bucket, monkeypatch, op, "none", AMBIGUOUS[err], timing, "before")


@pytest.mark.parametrize("other_when", ["after"])
@pytest.mark.parametrize("other", ["upload", "del-image", "del-sig"])
@pytest.mark.parametrize("timing", ["now", "later"])
@pytest.mark.parametrize("op", list(OPS))
def test_rn012_ambiguous_failure_with_a_concurrent_image_operation_stays_coherent(
    images_bucket: str, monkeypatch: Any, op: str, timing: str, other: str, other_when: str
) -> None:
    _run(images_bucket, monkeypatch, op, other, AMBIGUOUS["ise"], timing, other_when)


@pytest.mark.parametrize("err", ["throttle", "validation", "cancel-validation", "cancel-throttle"])
@pytest.mark.parametrize("op", list(OPS))
def test_rn012_definitive_failure_never_leaves_metadata_without_object(
    images_bucket: str, monkeypatch: Any, op: str, err: str
) -> None:
    _run(images_bucket, monkeypatch, op, "none", DEFINITIVE[err], "never", "before")


def test_rn012_upload_refused_definitively_leaves_no_orphan(
    images_bucket: str, monkeypatch: Any
) -> None:
    for name, err in DEFINITIVE.items():
        if name in ("endpoint", "paramval"):  # classified as ambiguous: kept on purpose
            continue
        sid = _setup(True)
        client = tables.table(tables.SETTINGS_TABLE_ENV).meta.client

        def refuse(make: Any = err, **kw: Any) -> Any:
            raise make()

        monkeypatch.setattr(client, "transact_write_items", refuse)
        assert _put(sid)["statusCode"] >= 400, name
        monkeypatch.undo()
        assert len(signature_object_keys(images_bucket, sid)) == 1, name
        _del_sig(sid)
