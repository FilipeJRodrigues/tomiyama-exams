"""Private S3 bucket of the academy images (RN012).

The bucket name comes from ``IMAGES_BUCKET``, set by SAM only on the functions
that use it; each one may only touch its own prefix (``logos/*``, later the
signatures'). Objects are never public: reading goes through a presigned GET
URL signed with SigV4 against the Region's endpoint.

The client has short timeouts and few attempts so that a slow or unreachable
S3 ends the request in 503 well before the Lambda's 10 s limit, instead of the
botocore defaults (60 s per connect/read, which would let the Lambda be killed
mid-request with a generic 500 from API Gateway).
"""

import logging
import os
from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ConnectionError, HTTPClientError

from domain.errors import MSG_SERVICE_BUSY, ServiceUnavailableError
from domain.images import ImageUpload

logger = logging.getLogger(__name__)

IMAGES_BUCKET_ENV = "IMAGES_BUCKET"

# S3 answers 503 SlowDown when a prefix receives too many requests; botocore
# retries it a few times before raising.
TEMPORARY_ERRORS = frozenset({"SlowDown", "ServiceUnavailable", "503"})

# Worst case of one call: S3_MAX_ATTEMPTS x (connect + read) plus the backoff
# between attempts (at most 1 s before the 2nd one in "standard" mode), i.e.
# 2 x (1 + 2) + 1 = 7 s, below the functions' 10 s Timeout (Globals in
# infra/template.yaml) with room for the DynamoDB write. read_timeout is per
# socket operation, not for the whole 2 MB body, which in-Region takes far less.
S3_CONNECT_TIMEOUT_SECONDS = 1
S3_READ_TIMEOUT_SECONDS = 2
S3_MAX_ATTEMPTS = 2
S3_RETRY_MODE = "standard"
# Upper bound of the standard mode's backoff before the 2nd attempt.
S3_MAX_BACKOFF_SECONDS = 1

# Network failures (connect/read timeouts, refused or dropped connections):
# the same request may pass in a moment, so they are a 503 like throttling.
NETWORK_ERRORS = (ConnectionError, HTTPClientError)


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
        config=client_config(),
    )


def client_config() -> Config:
    """Return the S3 client configuration: SigV4, virtual-hosted style, short timeouts."""
    return Config(
        signature_version="s3v4",
        s3={"addressing_style": "virtual"},
        connect_timeout=S3_CONNECT_TIMEOUT_SECONDS,
        read_timeout=S3_READ_TIMEOUT_SECONDS,
        retries={"mode": S3_RETRY_MODE, "total_max_attempts": S3_MAX_ATTEMPTS},
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


def _network_busy(exc: Exception, action: str, key: str) -> ServiceUnavailableError:
    """Log a network failure that outlasted the retries and return the 503 to raise."""
    logger.warning("S3 %s of %s failed after retries: %s", action, key, type(exc).__name__)
    return ServiceUnavailableError(MSG_SERVICE_BUSY)


def put_image(key: str, image: ImageUpload, content_disposition: str) -> None:
    """Store (or overwrite) the image at ``key``.

    ``Content-Type`` is the type read from the bytes (``image.content_type``)
    and ``Content-Disposition`` the fixed inline value given by the caller.

    Raises:
        ServiceUnavailableError: If S3 kept throttling, timed out or could
            not be reached.
    """
    try:
        _client().put_object(
            Bucket=_bucket(),
            Key=key,
            Body=image.data,
            ContentType=image.content_type,
            ContentDisposition=content_disposition,
        )
    except ClientError as exc:
        _raise_busy(exc, "PutObject", key)
        raise
    except NETWORK_ERRORS as exc:
        raise _network_busy(exc, "PutObject", key) from exc


def delete_image(key: str) -> None:
    """Delete the object at ``key``; deleting a missing key succeeds (idempotent).

    Raises:
        ServiceUnavailableError: If S3 kept throttling, timed out or could
            not be reached.
    """
    try:
        _client().delete_object(Bucket=_bucket(), Key=key)
    except ClientError as exc:
        _raise_busy(exc, "DeleteObject", key)
        raise
    except NETWORK_ERRORS as exc:
        raise _network_busy(exc, "DeleteObject", key) from exc


def presigned_get_url(
    key: str, expires_in: int, content_type: str, content_disposition: str
) -> str:
    """Return a GET URL for ``key`` valid for ``expires_in`` seconds.

    The URL fixes the response's ``Content-Type`` and ``Content-Disposition``
    (``response-content-type``/``response-content-disposition``), so what the
    browser receives does not depend on the object's stored metadata.

    Signing is local (no request to S3, hence no timeout); the URL works only
    while the function's role may ``s3:GetObject`` the key.
    """
    return _client().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": _bucket(),
            "Key": key,
            "ResponseContentType": content_type,
            "ResponseContentDisposition": content_disposition,
        },
        ExpiresIn=expires_in,
    )
