"""Academy logos (§ 3.7, § 6.6, RN012): private S3 bucket, metadata in the settings record.

PNG or JPEG of at most 2 MB, with the type taken from the file's signature;
upload, removal and reading by examiners only; reading through a presigned
GET URL valid for 300 seconds.
"""

import base64
import os
from typing import Any
from urllib.parse import parse_qs, urlparse

import boto3
import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, GUARDIAN, MASTER, api_event, response_json

from domain import dates
from domain import images as image_rules
from domain.errors import ValidationError
from domain.images import MAX_BASE64_CHARS, MAX_IMAGE_BYTES, MSG_INVALID_IMAGE
from domain.settings import SETTINGS_ID
from domain.users import User
from handlers import logos as handlers
from handlers import settings as settings_handlers
from repository import images as image_repo
from repository import settings as settings_repo

MSG_BUSY = "Sistema ocupado no momento. Tente de novo em instantes."
MSG_NOT_FOUND = "Logo não encontrado"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JPEG_SIGNATURE = b"\xff\xd8\xff"
PNG_BYTES = PNG_SIGNATURE + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
JPEG_BYTES = JPEG_SIGNATURE + b"\xe0\x00\x10JFIF" + b"\x02" * 40
GIF_BYTES = b"GIF89a" + b"\x00" * 40
PDF_BYTES = b"%PDF-1.7\n" + b"\x00" * 40
NOW = "2026-11-02T12:00:00+00:00"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _body(data: bytes = PNG_BYTES, content_type: str = "image/png") -> dict[str, Any]:
    return {"content_type": content_type, "data": _b64(data)}


def _put(body: Any, slot: str = "primary", user: User | None = EXAMINER) -> dict[str, Any]:
    return handlers.put_logo(api_event(user, body=body, path={"slot": slot}), None)


def _delete(slot: str = "primary", user: User | None = EXAMINER) -> dict[str, Any]:
    return handlers.delete_logo(api_event(user, path={"slot": slot}), None)


def _get(slot: str = "primary", user: User | None = EXAMINER) -> dict[str, Any]:
    return handlers.get_logo(api_event(user, path={"slot": slot}), None)


def _s3() -> Any:
    return boto3.client("s3")


def _object(key: str) -> dict[str, Any] | None:
    try:
        response = _s3().get_object(Bucket=os.environ["IMAGES_BUCKET"], Key=key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "NoSuchKey":
            return None
        raise
    return {"body": response["Body"].read(), "content_type": response["ContentType"]}


def _settings_table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])


def _stored() -> dict[str, Any] | None:
    return _settings_table().get_item(Key={"id": SETTINGS_ID}).get("Item")


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "Operation")


@pytest.fixture
def frozen_now(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)
    return NOW


# --- access ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "call",
    [
        lambda user: _put(_body(), user=user),
        lambda user: _delete(user=user),
        lambda user: _get(user=user),
    ],
    ids=["PUT", "DELETE", "GET"],
)
def test_rn012_logo_routes_refuse_guardians(images_bucket: str, call: Any) -> None:
    response = call(GUARDIAN)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": "Esta área é dos examinadores"}
    assert _stored() is None
    assert _object("logos/primary") is None


@pytest.mark.parametrize(
    "call",
    [
        lambda user: _put(_body(), user=user),
        lambda user: _delete(user=user),
        lambda user: _get(user=user),
    ],
    ids=["PUT", "DELETE", "GET"],
)
def test_rn012_logo_routes_without_login_are_401(images_bucket: str, call: Any) -> None:
    response = call(None)

    assert response["statusCode"] == 401
    assert response_json(response) == {"message": "Faça login para continuar"}
    assert _object("logos/primary") is None


def test_rn012_guardian_cannot_replace_an_existing_logo(images_bucket: str) -> None:
    assert _put(_body())["statusCode"] == 200

    assert _put(_body(JPEG_BYTES, "image/jpeg"), user=GUARDIAN)["statusCode"] == 403
    assert _delete(user=GUARDIAN)["statusCode"] == 403

    assert _object("logos/primary") == {"body": PNG_BYTES, "content_type": "image/png"}


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
def test_rn012_every_examiner_manages_the_logos(images_bucket: str, user: User) -> None:
    assert _put(_body(), user=user)["statusCode"] == 200
    assert _get(user=user)["statusCode"] == 200
    assert _delete(user=user)["statusCode"] == 204


# --- slots ------------------------------------------------------------------------------


@pytest.mark.parametrize("slot", ["tertiary", "PRIMARY", "", "logos/primary", "../primary"])
@pytest.mark.parametrize(
    "call",
    [
        lambda slot: _put(_body(), slot=slot),
        lambda slot: _delete(slot=slot),
        lambda slot: _get(slot=slot),
    ],
    ids=["PUT", "DELETE", "GET"],
)
def test_rn012_unknown_slot_is_404(images_bucket: str, call: Any, slot: str) -> None:
    response = call(slot)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": MSG_NOT_FOUND}
    assert _stored() is None


def test_rn012_guardian_gets_403_before_the_slot_is_checked(images_bucket: str) -> None:
    assert _put(_body(), slot="tertiary", user=GUARDIAN)["statusCode"] == 403


# --- PUT: accepted images -------------------------------------------------------------


@pytest.mark.parametrize(
    ("data", "content_type"),
    [(PNG_BYTES, "image/png"), (JPEG_BYTES, "image/jpeg")],
    ids=["png", "jpeg"],
)
@pytest.mark.parametrize("slot", ["primary", "secondary"])
def test_rn012_png_and_jpeg_are_stored_in_the_slot(
    images_bucket: str, frozen_now: str, data: bytes, content_type: str, slot: str
) -> None:
    response = _put(_body(data, content_type), slot=slot)

    assert response["statusCode"] == 200, response["body"]
    expected_meta = {
        "content_type": content_type,
        "size": len(data),
        "updated_at": NOW,
        "updated_by": EXAMINER.sub,
    }
    assert response_json(response) == {"slot": slot, **expected_meta}
    assert _object(f"logos/{slot}") == {"body": data, "content_type": content_type}
    stored = _stored()
    assert stored is not None
    assert stored[f"logo_{slot}"] == expected_meta
    # Only metadata in DynamoDB, never the bytes; the other slot is untouched.
    other = "secondary" if slot == "primary" else "primary"
    assert f"logo_{other}" not in stored
    assert _object(f"logos/{other}") is None


def test_rn012_exactly_2_mb_is_accepted(images_bucket: str) -> None:
    data = PNG_SIGNATURE + b"\x00" * (MAX_IMAGE_BYTES - len(PNG_SIGNATURE))

    response = _put(_body(data))

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["size"] == 2 * 1024 * 1024
    stored = _object("logos/primary")
    assert stored is not None
    assert len(stored["body"]) == MAX_IMAGE_BYTES


def test_rn012_replacing_overwrites_the_same_key(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2026-11-01T10:00:00+00:00")
    assert _put(_body(PNG_BYTES, "image/png"), user=EXAMINER)["statusCode"] == 200
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2026-11-02T10:00:00+00:00")

    response = _put(_body(JPEG_BYTES, "image/jpeg"), user=MASTER)

    assert response["statusCode"] == 200
    assert _object("logos/primary") == {"body": JPEG_BYTES, "content_type": "image/jpeg"}
    listed = _s3().list_objects_v2(Bucket=os.environ["IMAGES_BUCKET"])
    assert [item["Key"] for item in listed["Contents"]] == ["logos/primary"]
    assert _stored()["logo_primary"] == {  # type: ignore[index]
        "content_type": "image/jpeg",
        "size": len(JPEG_BYTES),
        "updated_at": "2026-11-02T10:00:00+00:00",
        "updated_by": MASTER.sub,
    }


def test_rn012_logo_upload_keeps_the_settings_fields(images_bucket: str) -> None:
    _settings_table().put_item(
        Item={"id": SETTINGS_ID, "academy_name": "Tomiyama", "sensei_user_id": "s-1"}
    )

    assert _put(_body())["statusCode"] == 200

    stored = _stored()
    assert stored is not None
    assert stored["academy_name"] == "Tomiyama"
    assert stored["sensei_user_id"] == "s-1"


def test_rn012_settings_save_keeps_the_logo_and_hides_it_from_the_json(
    user_pool: str, images_bucket: str
) -> None:
    assert _put(_body())["statusCode"] == 200
    payload = {"academy_name": "Tomiyama", "sensei_user_id": None, "certificate_city": None}

    response = settings_handlers.update_settings(api_event(MASTER, body=payload), None)

    assert response["statusCode"] == 200
    assert "logo_primary" in _stored()  # type: ignore[operator]
    for body in (
        response_json(response),
        response_json(settings_handlers.get_settings(api_event(EXAMINER), None)),
    ):
        assert not {"logo_primary", "logo_secondary"} & set(body)
    assert _get()["statusCode"] == 200


# --- PUT: refused images --------------------------------------------------------------


def _assert_refused(response: dict[str, Any]) -> None:
    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_IMAGE}
    assert _object("logos/primary") is None
    assert _stored() is None


@pytest.mark.parametrize(
    ("data", "content_type"),
    [(JPEG_BYTES, "image/png"), (PNG_BYTES, "image/jpeg")],
    ids=["jpeg-declared-png", "png-declared-jpeg"],
)
def test_rn012_declared_type_must_match_the_bytes(
    images_bucket: str, data: bytes, content_type: str
) -> None:
    _assert_refused(_put(_body(data, content_type)))


@pytest.mark.parametrize(
    ("data", "content_type"),
    [
        (GIF_BYTES, "image/gif"),
        (GIF_BYTES, "image/png"),
        (PDF_BYTES, "application/pdf"),
        (PDF_BYTES, "image/jpeg"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/png"),
    ],
    ids=["gif", "gif-declared-png", "pdf", "pdf-declared-jpeg", "svg-declared-png"],
)
def test_rn012_gif_pdf_and_others_are_refused(
    images_bucket: str, data: bytes, content_type: str
) -> None:
    _assert_refused(_put(_body(data, content_type)))


def test_rn012_empty_image_is_refused(images_bucket: str) -> None:
    _assert_refused(_put({"content_type": "image/png", "data": ""}))


def test_rn012_more_than_2_mb_is_refused(images_bucket: str) -> None:
    data = PNG_SIGNATURE + b"\x00" * (MAX_IMAGE_BYTES - len(PNG_SIGNATURE) + 1)

    _assert_refused(_put(_body(data)))


@pytest.mark.parametrize(
    "data",
    [
        "não é base64",
        "iVBORw0KGgo",  # missing padding
        "data:image/png;base64," + _b64(PNG_BYTES),
        _b64(PNG_BYTES)[:20] + "\n" + _b64(PNG_BYTES)[20:],
        "####",
    ],
    ids=["text", "bad-padding", "data-url", "line-break", "symbols"],
)
def test_rn012_invalid_base64_is_refused(images_bucket: str, data: str) -> None:
    _assert_refused(_put({"content_type": "image/png", "data": data}))


@pytest.mark.parametrize(
    "body",
    [
        {"data": _b64(PNG_BYTES)},
        {"content_type": "image/png"},
        {"content_type": "image/png", "data": None},
        {"content_type": "image/png", "data": 123},
        {"content_type": ["image/png"], "data": _b64(PNG_BYTES)},
        {"content_type": "IMAGE/PNG", "data": _b64(PNG_BYTES)},
        {"content_type": "image/jpg", "data": _b64(JPEG_BYTES)},
    ],
    ids=["no-type", "no-data", "null-data", "number", "list-type", "upper-type", "jpg-alias"],
)
def test_rn012_missing_or_wrong_fields_are_refused(
    images_bucket: str, body: dict[str, Any]
) -> None:
    _assert_refused(_put(body))


@pytest.mark.parametrize("raw", [None, "", "[]", "não é json"])
def test_rn012_upload_requires_a_json_object(images_bucket: str, raw: Any) -> None:
    event = api_event(EXAMINER, path={"slot": "primary"})
    event["body"] = raw

    response = handlers.put_logo(event, None)

    assert response["statusCode"] == 400
    assert response_json(response) == {
        "message": "Corpo da requisição inválido: envie um objeto JSON"
    }


def test_rn012_refused_upload_keeps_the_current_logo(images_bucket: str) -> None:
    assert _put(_body())["statusCode"] == 200
    before = _stored()

    assert _put(_body(GIF_BYTES, "image/png"))["statusCode"] == 400

    assert _object("logos/primary") == {"body": PNG_BYTES, "content_type": "image/png"}
    assert _stored() == before


def test_rn012_base64_encoded_request_body_is_accepted(images_bucket: str) -> None:
    # API Gateway may deliver the body base64-encoded (isBase64Encoded).
    event = api_event(EXAMINER, body=_body(), path={"slot": "primary"})
    event["body"] = base64.b64encode(event["body"].encode("utf-8")).decode("ascii")
    event["isBase64Encoded"] = True

    assert handlers.put_logo(event, None)["statusCode"] == 200
    assert _object("logos/primary") == {"body": PNG_BYTES, "content_type": "image/png"}


# --- validation (pure) ----------------------------------------------------------------


def test_rn012_detects_the_type_from_the_signature() -> None:
    assert image_rules.detect_content_type(PNG_BYTES) == "image/png"
    assert image_rules.detect_content_type(JPEG_BYTES) == "image/jpeg"
    assert image_rules.detect_content_type(PNG_SIGNATURE[:-1]) is None
    assert image_rules.detect_content_type(JPEG_SIGNATURE[:2]) is None
    assert image_rules.detect_content_type(GIF_BYTES) is None
    assert image_rules.detect_content_type(b"") is None


def test_rn012_base64_longer_than_2_mb_is_refused_before_decoding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_decode(*args: Any, **kwargs: Any) -> bytes:
        raise AssertionError("decoded an oversized payload")

    monkeypatch.setattr(image_rules.base64, "b64decode", no_decode)

    with pytest.raises(ValidationError, match=MSG_INVALID_IMAGE):
        image_rules.parse_image_upload(
            {"content_type": "image/png", "data": "A" * (MAX_BASE64_CHARS + 4)}
        )


def test_rn012_base64_limit_matches_2_mb() -> None:
    assert len(_b64(b"\x00" * MAX_IMAGE_BYTES)) == MAX_BASE64_CHARS
    # 2 MB + 1 byte still fits the same padded length (2 MiB is not a multiple
    # of 3): that case is refused after decoding; + 2 bytes is refused before.
    assert len(_b64(b"\x00" * (MAX_IMAGE_BYTES + 1))) == MAX_BASE64_CHARS
    assert len(_b64(b"\x00" * (MAX_IMAGE_BYTES + 2))) > MAX_BASE64_CHARS


# --- DELETE -----------------------------------------------------------------------------


def test_rn012_delete_removes_object_and_metadata(images_bucket: str) -> None:
    assert _put(_body(), slot="primary")["statusCode"] == 200
    assert _put(_body(JPEG_BYTES, "image/jpeg"), slot="secondary")["statusCode"] == 200

    response = _delete("primary")

    assert response["statusCode"] == 204
    assert _object("logos/primary") is None
    stored = _stored()
    assert stored is not None
    assert "logo_primary" not in stored
    assert stored["logo_secondary"]["content_type"] == "image/jpeg"
    assert _object("logos/secondary") is not None
    assert _get("primary")["statusCode"] == 404


def test_rn012_delete_is_idempotent_and_creates_nothing(images_bucket: str) -> None:
    assert _delete()["statusCode"] == 204
    assert _delete()["statusCode"] == 204

    assert _stored() is None


def test_rn012_delete_without_logo_keeps_the_settings(images_bucket: str) -> None:
    _settings_table().put_item(Item={"id": SETTINGS_ID, "academy_name": "Tomiyama"})

    assert _delete("secondary")["statusCode"] == 204

    assert _stored() == {"id": SETTINGS_ID, "academy_name": "Tomiyama"}


def test_rn012_delete_removes_an_object_left_without_metadata(images_bucket: str) -> None:
    # A PUT whose metadata write failed leaves the object behind; DELETE cleans it.
    _s3().put_object(Bucket=os.environ["IMAGES_BUCKET"], Key="logos/primary", Body=PNG_BYTES)

    assert _delete()["statusCode"] == 204

    assert _object("logos/primary") is None


# --- GET --------------------------------------------------------------------------------


def test_rn012_get_returns_a_presigned_url_for_the_slot_key(
    images_bucket: str, frozen_now: str
) -> None:
    assert _put(_body(JPEG_BYTES, "image/jpeg"), slot="secondary")["statusCode"] == 200

    response = _get("secondary")

    assert response["statusCode"] == 200
    body = response_json(response)
    url = urlparse(body.pop("url"))
    assert body == {
        "slot": "secondary",
        "expires_in": 300,
        "content_type": "image/jpeg",
        "size": len(JPEG_BYTES),
        "updated_at": NOW,
        "updated_by": EXAMINER.sub,
    }
    query = parse_qs(url.query)
    assert url.scheme == "https"
    assert url.netloc.startswith(f"{os.environ['IMAGES_BUCKET']}.s3.")
    assert url.path == "/logos/secondary"
    assert query["X-Amz-Expires"] == ["300"]
    assert query["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert "X-Amz-Signature" in query


def test_rn012_get_never_returns_the_bytes(images_bucket: str) -> None:
    assert _put(_body())["statusCode"] == 200

    raw = _get()["body"]

    assert _b64(PNG_BYTES) not in raw
    assert set(response_json(_get())) == {
        "slot",
        "url",
        "expires_in",
        "content_type",
        "size",
        "updated_at",
        "updated_by",
    }


@pytest.mark.parametrize("slot", ["primary", "secondary"])
def test_rn012_get_without_logo_is_404(images_bucket: str, slot: str) -> None:
    response = _get(slot)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": MSG_NOT_FOUND}


def test_rn012_get_other_slot_is_404(images_bucket: str) -> None:
    assert _put(_body(), slot="primary")["statusCode"] == 200

    assert _get("secondary")["statusCode"] == 404


def test_rn012_get_ignores_malformed_metadata(images_bucket: str) -> None:
    # Something that is not the metadata map (e.g. bytes from an old draft) is "no logo".
    _settings_table().put_item(Item={"id": SETTINGS_ID, "logo_primary": b"\x89PNG..."})

    assert _get()["statusCode"] == 404


# --- throttling and write order -------------------------------------------------------


class _ThrottledTable:
    name = "test-settings"

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error("ProvisionedThroughputExceededException")

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error("ProvisionedThroughputExceededException")


class _ThrottledS3:
    def __init__(self, code: str = "SlowDown") -> None:
        self.code = code

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error(self.code)

    def delete_object(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error(self.code)


def _assert_busy(response: dict[str, Any]) -> None:
    assert response["statusCode"] == 503
    assert response_json(response) == {"message": MSG_BUSY}


def test_rn012_settings_throttling_on_read_is_503(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings_repo, "table", lambda env_var: _ThrottledTable())

    _assert_busy(_get())


def test_rn012_settings_throttling_on_upload_is_503_after_the_object(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # S3 first, metadata after: the object is written but stays invisible
    # (no metadata, GET is 404) until the upload is sent again.
    monkeypatch.setattr(settings_repo, "table", lambda env_var: _ThrottledTable())

    _assert_busy(_put(_body()))

    monkeypatch.undo()
    assert _stored() is None
    assert _get()["statusCode"] == 404
    assert _put(_body())["statusCode"] == 200
    assert _get()["statusCode"] == 200


@pytest.mark.parametrize("code", ["SlowDown", "ServiceUnavailable"])
def test_rn012_s3_throttling_on_upload_is_503_and_writes_nothing(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    monkeypatch.setattr(image_repo, "_client", lambda: _ThrottledS3(code))

    _assert_busy(_put(_body()))

    assert _stored() is None


def test_rn012_settings_throttling_on_delete_is_503_and_keeps_the_logo(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Metadata first: if it cannot be removed, the object is not touched either.
    assert _put(_body())["statusCode"] == 200
    monkeypatch.setattr(settings_repo, "table", lambda env_var: _ThrottledTable())

    _assert_busy(_delete())

    monkeypatch.undo()
    assert _object("logos/primary") is not None
    assert _get()["statusCode"] == 200


def test_rn012_s3_throttling_on_delete_is_503_and_hides_the_logo(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _put(_body())["statusCode"] == 200
    monkeypatch.setattr(image_repo, "_client", lambda: _ThrottledS3())

    _assert_busy(_delete())

    monkeypatch.undo()
    assert _get()["statusCode"] == 404
    assert _object("logos/primary") is not None
    # Sending the DELETE again finishes the job.
    assert _delete()["statusCode"] == 204
    assert _object("logos/primary") is None


def test_rn012_other_s3_errors_are_500(images_bucket: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(image_repo, "_client", lambda: _ThrottledS3("AccessDenied"))

    response = _put(_body())

    assert response["statusCode"] == 500
    assert response_json(response) == {"message": "Erro interno. Tente de novo."}
    assert _stored() is None
