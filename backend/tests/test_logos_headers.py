"""Logo object headers and the S3 client's timeouts (§ 3.7, RN012).

- The object is stored with ``Content-Type`` read from the bytes (never the
  client's header or text) and ``Content-Disposition: inline`` with a fixed
  file name; the presigned URL fixes the same two response headers.
- The S3 client has short timeouts and few attempts, below the Lambda's 10 s;
  a timeout or connection failure is a 503 "Sistema ocupado", with nothing
  half-written.
"""

import base64
import os
from typing import Any
from urllib.parse import parse_qs, urlparse

import boto3
import pytest
from botocore.exceptions import (
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)
from cfnlint.decode import decode
from conftest import EXAMINER, api_event, response_json
from test_template_images import TEMPLATE

from domain import images as image_rules
from domain.images import JPEG, PNG
from domain.settings import SETTINGS_ID
from handlers import logos as handlers
from repository import images as image_repo

MSG_BUSY = "Sistema ocupado no momento. Tente de novo em instantes."
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
JPEG_BYTES = b"\xff\xd8\xff" + b"\xe0\x00\x10JFIF" + b"\x02" * 40
PNG_DISPOSITION = 'inline; filename="logo.png"'
JPEG_DISPOSITION = 'inline; filename="logo.jpg"'
LOGO_FUNCTIONS = ("PutLogoFunction", "DeleteLogoFunction", "GetLogoFunction")


def _body(data: bytes, content_type: str) -> dict[str, Any]:
    return {"content_type": content_type, "data": base64.b64encode(data).decode("ascii")}


def _put(body: Any, slot: str = "primary", headers: dict[str, str] | None = None) -> Any:
    event = api_event(EXAMINER, body=body, path={"slot": slot})
    if headers is not None:
        event["headers"] = headers
    return handlers.put_logo(event, None)


def _head(key: str) -> dict[str, Any]:
    return boto3.client("s3").head_object(Bucket=os.environ["IMAGES_BUCKET"], Key=key)


def _keys() -> list[str]:
    listed = boto3.client("s3").list_objects_v2(Bucket=os.environ["IMAGES_BUCKET"])
    return [item["Key"] for item in listed.get("Contents", [])]


def _stored_settings() -> dict[str, Any] | None:
    table = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    return table.get_item(Key={"id": SETTINGS_ID}).get("Item")


# --- headers of the stored object -----------------------------------------------------


@pytest.mark.parametrize(
    ("data", "content_type", "disposition"),
    [(PNG_BYTES, PNG, PNG_DISPOSITION), (JPEG_BYTES, JPEG, JPEG_DISPOSITION)],
)
def test_rn012_object_is_stored_with_type_from_bytes_and_inline_disposition(
    images_bucket: str, data: bytes, content_type: str, disposition: str
) -> None:
    assert _put(_body(data, content_type))["statusCode"] == 200

    head = _head("logos/primary")
    assert head["ContentType"] == content_type
    assert head["ContentDisposition"] == disposition


@pytest.mark.parametrize(
    ("data", "content_type", "disposition"),
    [(PNG_BYTES, PNG, PNG_DISPOSITION), (JPEG_BYTES, JPEG, JPEG_DISPOSITION)],
)
@pytest.mark.parametrize(
    "header", ["text/html", "image/svg+xml", "application/octet-stream", "image/jpeg"]
)
def test_rn012_request_content_type_header_never_reaches_the_object(
    images_bucket: str, data: bytes, content_type: str, disposition: str, header: str
) -> None:
    # The HTTP header of the request says something else; only the bytes count.
    response = _put(_body(data, content_type), headers={"content-type": header})

    assert response["statusCode"] == 200
    head = _head("logos/primary")
    assert head["ContentType"] == content_type
    assert head["ContentDisposition"] == disposition
    assert response_json(response)["content_type"] == content_type


@pytest.mark.parametrize(
    ("data", "declared"), [(PNG_BYTES, JPEG), (JPEG_BYTES, PNG), (b"<svg></svg>", PNG)]
)
def test_rn012_declared_type_that_does_not_match_the_bytes_stores_nothing(
    images_bucket: str, data: bytes, declared: str
) -> None:
    assert _put(_body(data, declared))["statusCode"] == 400
    assert _keys() == []


def test_rn012_upload_type_is_the_detected_one() -> None:
    image = image_rules.parse_image_upload(_body(JPEG_BYTES, JPEG))

    assert image.content_type == image_rules.detect_content_type(JPEG_BYTES) == JPEG


def test_rn012_content_disposition_is_inline_with_a_fixed_name() -> None:
    assert image_rules.content_disposition(PNG, "logo") == PNG_DISPOSITION
    assert image_rules.content_disposition(JPEG, "logo") == JPEG_DISPOSITION


@pytest.mark.parametrize(
    ("content_type", "basename"),
    [
        ("text/html", "logo"),
        ("image/svg+xml", "logo"),
        (PNG, 'logo"; x="'),
        (PNG, "../logo"),
        (PNG, "logo\r\nX-Evil: 1"),
        (PNG, "lógo"),
        (PNG, ""),
    ],
)
def test_rn012_content_disposition_refuses_unsafe_values(content_type: str, basename: str) -> None:
    with pytest.raises(ValueError):
        image_rules.content_disposition(content_type, basename)


# --- presigned URL ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("data", "content_type", "disposition"),
    [(PNG_BYTES, PNG, PNG_DISPOSITION), (JPEG_BYTES, JPEG, JPEG_DISPOSITION)],
)
def test_rn012_presigned_url_fixes_the_response_headers(
    images_bucket: str, data: bytes, content_type: str, disposition: str
) -> None:
    _put(_body(data, content_type))

    response = handlers.get_logo(api_event(EXAMINER, path={"slot": "primary"}), None)

    assert response["statusCode"] == 200
    query = parse_qs(urlparse(response_json(response)["url"]).query)
    assert query["response-content-type"] == [content_type]
    assert query["response-content-disposition"] == [disposition]
    assert query["X-Amz-Expires"] == ["300"]
    assert "X-Amz-Signature" in query


def test_rn012_presigned_url_headers_are_signed(images_bucket: str) -> None:
    # The response-* parameters are part of the signed query: changing them
    # breaks the signature instead of letting someone pick another type.
    url = image_repo.presigned_get_url("logos/primary", 300, PNG, PNG_DISPOSITION)
    query = parse_qs(urlparse(url).query)

    assert "X-Amz-Signature" in query
    other = image_repo.presigned_get_url("logos/primary", 300, "text/html", PNG_DISPOSITION)
    assert parse_qs(urlparse(other).query)["X-Amz-Signature"] != query["X-Amz-Signature"]


def test_rn012_get_uses_the_metadata_type_not_the_object_metadata(images_bucket: str) -> None:
    # Even if the object in S3 had other metadata, the URL serves the logo's type.
    _put(_body(PNG_BYTES, PNG))
    boto3.client("s3").put_object(
        Bucket=images_bucket,
        Key="logos/primary",
        Body=PNG_BYTES,
        ContentType="text/html",
        ContentDisposition="attachment; filename=x.html",
    )

    response = handlers.get_logo(api_event(EXAMINER, path={"slot": "primary"}), None)

    query = parse_qs(urlparse(response_json(response)["url"]).query)
    assert query["response-content-type"] == [PNG]
    assert query["response-content-disposition"] == [PNG_DISPOSITION]


@pytest.mark.parametrize("stored_type", ["text/html", "image/svg+xml", "", None])
def test_rn012_metadata_with_another_type_is_treated_as_no_logo(
    images_bucket: str, stored_type: str | None
) -> None:
    table = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    table.put_item(
        Item={
            "id": SETTINGS_ID,
            "logo_primary": {
                "content_type": stored_type,
                "size": 10,
                "updated_at": "2026-11-02T12:00:00+00:00",
                "updated_by": "someone",
            },
        }
    )

    response = handlers.get_logo(api_event(EXAMINER, path={"slot": "primary"}), None)

    assert response["statusCode"] == 404


# --- client configuration ---------------------------------------------------------------


def _lambda_timeout(function: str) -> int:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    properties = parsed["Resources"][function]["Properties"]
    return int(properties.get("Timeout", parsed["Globals"]["Function"]["Timeout"]))


def test_rn012_s3_client_has_short_timeouts_and_limited_retries(images_bucket: str) -> None:
    config = image_repo._client().meta.config

    assert config.connect_timeout == image_repo.S3_CONNECT_TIMEOUT_SECONDS == 1
    assert config.read_timeout == image_repo.S3_READ_TIMEOUT_SECONDS == 2
    assert config.retries == {"mode": "standard", "total_max_attempts": 2}
    assert config.signature_version == "s3v4"
    assert config.s3 == {"addressing_style": "virtual"}


@pytest.mark.parametrize("function", LOGO_FUNCTIONS)
def test_rn012_s3_worst_case_fits_in_the_lambda_timeout(function: str) -> None:
    worst = (
        image_repo.S3_MAX_ATTEMPTS
        * (image_repo.S3_CONNECT_TIMEOUT_SECONDS + image_repo.S3_READ_TIMEOUT_SECONDS)
        + (image_repo.S3_MAX_ATTEMPTS - 1) * image_repo.S3_MAX_BACKOFF_SECONDS
    )

    # Room left for the DynamoDB write after the S3 call.
    assert worst < _lambda_timeout(function) - 2


# --- timeouts and connection failures ---------------------------------------------------


def _network_errors() -> list[Exception]:
    endpoint = "https://test-academy-images.s3.us-east-1.amazonaws.com/logos/primary"
    return [
        ReadTimeoutError(endpoint_url=endpoint),
        ConnectTimeoutError(endpoint_url=endpoint),
        EndpointConnectionError(endpoint_url=endpoint),
        ConnectionClosedError(endpoint_url=endpoint),
    ]


class _UnreachableS3:
    """S3 client whose network calls fail the way botocore does after the retries."""

    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls: list[str] = []

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append("put_object")
        raise self.error

    def delete_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append("delete_object")
        raise self.error


@pytest.mark.parametrize("error", _network_errors(), ids=lambda e: type(e).__name__)
def test_rn012_s3_timeout_on_upload_is_503_and_writes_nothing(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    stub = _UnreachableS3(error)
    monkeypatch.setattr(image_repo, "_client", lambda: stub)

    response = _put(_body(PNG_BYTES, PNG))

    assert response["statusCode"] == 503
    assert response_json(response) == {"message": MSG_BUSY}
    assert stub.calls == ["put_object"]
    monkeypatch.undo()
    assert _keys() == []
    assert _stored_settings() is None


@pytest.mark.parametrize("error", _network_errors(), ids=lambda e: type(e).__name__)
def test_rn012_s3_timeout_on_replace_is_503_and_keeps_the_current_logo(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    _put(_body(PNG_BYTES, PNG))
    before = _stored_settings()
    monkeypatch.setattr(image_repo, "_client", lambda: _UnreachableS3(error))

    response = _put(_body(JPEG_BYTES, JPEG))

    assert response["statusCode"] == 503
    monkeypatch.undo()
    assert _stored_settings() == before
    assert _head("logos/primary")["ContentType"] == PNG


@pytest.mark.parametrize("error", _network_errors(), ids=lambda e: type(e).__name__)
def test_rn012_s3_timeout_on_delete_is_503_and_hides_the_logo(
    images_bucket: str, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    # Same order as with throttling: the metadata goes first, the object stays
    # orphaned and the next DELETE removes it.
    _put(_body(PNG_BYTES, PNG))
    monkeypatch.setattr(image_repo, "_client", lambda: _UnreachableS3(error))

    response = handlers.delete_logo(api_event(EXAMINER, path={"slot": "primary"}), None)

    assert response["statusCode"] == 503
    assert response_json(response) == {"message": MSG_BUSY}
    monkeypatch.undo()
    assert "logo_primary" not in (_stored_settings() or {})
    assert (
        handlers.delete_logo(api_event(EXAMINER, path={"slot": "primary"}), None)["statusCode"]
        == 204
    )
    assert _keys() == []


def test_rn012_real_client_timeout_is_503(images_bucket: str) -> None:
    # With the real botocore client (not a stub): a read timeout raised by the
    # HTTP layer passes through botocore's retries and still ends in 503.
    attempts: list[int] = []
    endpoint = "https://test-academy-images.s3.us-east-1.amazonaws.com/logos/primary"

    def timeout(request: Any, **kwargs: Any) -> None:
        attempts.append(1)
        raise ReadTimeoutError(endpoint_url=endpoint)

    client = image_repo._client()
    client.meta.events.register_first("before-send.s3.PutObject", timeout)
    try:
        response = _put(_body(PNG_BYTES, PNG))
    finally:
        client.meta.events.unregister("before-send.s3.PutObject", timeout)

    assert response["statusCode"] == 503
    assert len(attempts) == image_repo.S3_MAX_ATTEMPTS
    assert _keys() == []
    assert _stored_settings() is None
