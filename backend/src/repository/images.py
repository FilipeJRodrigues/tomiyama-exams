"""Private S3 bucket of the academy images (RN012).

The bucket name comes from ``IMAGES_BUCKET``, set by SAM only on the functions
that use it; each one may only touch its own prefix (``logos/*``, later the
signatures'). Objects are never public: reading goes through a presigned GET
URL signed with SigV4 against the Region's endpoint.
"""

import logging
import os
from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from domain.errors import MSG_SERVICE_BUSY, ServiceUnavailableError
from domain.images import ImageUpload

logger = logging.getLogger(__name__)

IMAGES_BUCKET_ENV = "IMAGES_BUCKET"

# S3 answers 503 SlowDown when a prefix receives too many requests; botocore
# retries it a few times before raising.
TEMPORARY_ERRORS = frozenset({"SlowDown", "ServiceUnavailable", "503"})


def _region() -> str:
    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"


@lru_cache(maxsize=1)
def _client() -> Any:
    """Return a cached S3 client, reused across warm Lambda invocations.

    SigV4 and the regional endpoint: the global endpoint may redirect a
    presigned URL of a new bucket to the Region's, which breaks the signature.
    """
    region = _region()
    return boto3.client(
        "s3",
        region_name=region,
        endpoint_url=f"https://s3.{region}.amazonaws.com",
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
    )


def reset_cache() -> None:
    """Drop the cached client (used by tests between mocked environments)."""
    _client.cache_clear()


def _bucket() -> str:
    return os.environ[IMAGES_BUCKET_ENV]


def _raise_busy(exc: ClientError, action: str, key: str) -> None:
    """Turn S3 throttling that outlasted botocore's retries into a 503; ignore other errors."""
    code = exc.response.get("Error", {}).get("Code")
    if code in TEMPORARY_ERRORS:
        logger.warning("S3 %s of %s throttled after botocore retries: %s", action, key, code)
        raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc


def put_image(key: str, image: ImageUpload) -> None:
    """Store (or overwrite) the image at ``key`` with its validated content type.

    Raises:
        ServiceUnavailableError: If S3 kept throttling.
    """
    try:
        _client().put_object(
            Bucket=_bucket(), Key=key, Body=image.data, ContentType=image.content_type
        )
    except ClientError as exc:
        _raise_busy(exc, "PutObject", key)
        raise


def delete_image(key: str) -> None:
    """Delete the object at ``key``; deleting a missing key succeeds (idempotent).

    Raises:
        ServiceUnavailableError: If S3 kept throttling.
    """
    try:
        _client().delete_object(Bucket=_bucket(), Key=key)
    except ClientError as exc:
        _raise_busy(exc, "DeleteObject", key)
        raise


def presigned_get_url(key: str, expires_in: int) -> str:
    """Return a GET URL for ``key`` valid for ``expires_in`` seconds.

    Signing is local (no request to S3); the URL works only while the
    function's role may ``s3:GetObject`` the key.
    """
    return _client().generate_presigned_url(
        "get_object", Params={"Bucket": _bucket(), "Key": key}, ExpiresIn=expires_in
    )
