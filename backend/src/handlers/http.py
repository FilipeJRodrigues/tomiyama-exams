"""Helpers shared by the API Gateway HTTP API handlers (payload format 2.0)."""

import base64
import binascii
import functools
import json
import logging
import math
import os
from collections.abc import Callable
from datetime import date
from decimal import Decimal
from typing import Any

from domain.errors import (
    DomainError,
    ForbiddenError,
    PayloadTooLargeError,
    UnauthorizedError,
    ValidationError,
)
from domain.users import User

Event = dict[str, Any]
Response = dict[str, Any]
Handler = Callable[[Event, Any], Response]

logging.getLogger().setLevel(os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"Not JSON serializable: {type(value).__name__}")


def json_response(status_code: int, body: Any) -> Response:
    """Build an HTTP API response with a JSON body."""
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(body, ensure_ascii=False, default=_json_default),
    }


def no_content() -> Response:
    """Build an empty 204 response."""
    return {"statusCode": 204}


def api_handler(func: Handler) -> Handler:
    """Turn domain errors into JSON error responses and log unexpected failures.

    Domain errors become ``{"message": ...}`` with their status code; anything
    else becomes a generic 500 so internal details never reach the client.
    """

    @functools.wraps(func)
    def wrapper(event: Event, context: Any) -> Response:
        try:
            return func(event, context)
        except DomainError as exc:
            logger.info("Request rejected (%d): %s", exc.status_code, exc.message)
            return json_response(exc.status_code, {"message": exc.message})
        except Exception:
            logger.exception("Unhandled error")
            return json_response(500, {"message": "Erro interno. Tente de novo."})

    return wrapper


def _parse_groups(raw: Any) -> frozenset[str]:
    """Parse ``cognito:groups``.

    The HTTP API JWT authorizer flattens list claims into a string such as
    ``"[admin responsavel]"``; a real list is accepted as well.
    """
    if not raw:
        return frozenset()
    if isinstance(raw, list):
        return frozenset(str(group) for group in raw)
    cleaned = str(raw).strip().strip("[]").replace(",", " ")
    return frozenset(part.strip("\"'") for part in cleaned.split() if part)


def current_user(event: Event) -> User:
    """Return the caller from the JWT claims validated by API Gateway.

    The user id always comes from the token, never from the request body. The
    groups come from ``cognito:groups``: ``user.is_examiner`` (group ``admin``)
    and ``user.is_master`` (groups ``master`` and ``admin``).

    Raises:
        UnauthorizedError: If the request carries no valid claims.
    """
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    sub = claims.get("sub")
    if not sub:
        raise UnauthorizedError("Faça login para continuar")
    return User(
        sub=sub, email=claims.get("email"), groups=_parse_groups(claims.get("cognito:groups"))
    )


def require_examiner(user: User) -> None:
    """Allow only examiners (Cognito group ``admin``).

    Raises:
        ForbiddenError: If the user is not an examiner.
    """
    if not user.is_examiner:
        raise ForbiddenError("Esta área é dos examinadores")


MSG_MASTER_ONLY = "Esta ação é do administrador master"


def require_master(user: User, message: str = MSG_MASTER_ONLY) -> None:
    """Allow only the admin master (Cognito groups ``master`` and ``admin``).

    Args:
        user: The caller.
        message: 403 message, so each route can explain what is reserved.

    Raises:
        ForbiddenError: If the user is not the master.
    """
    if not user.is_master:
        raise ForbiddenError(message)


MSG_INVALID_BODY = "Corpo da requisição inválido: envie um objeto JSON"
MSG_BODY_TOO_LARGE = "Corpo da requisição grande demais"

# Largest JSON body accepted, in UTF-8 bytes. The biggest legitimate body is a
# logo of 2 MiB (domain.images.MAX_IMAGE_BYTES): base64 turns 2,097,152 bytes
# into 2,796,204 characters, plus a few dozen for the JSON around them, so
# 3 MiB (3,145,728 bytes) leaves ~340 KB of room and still stays well below
# the 6 MB Lambda payload limit.
MAX_BODY_BYTES = 3 * 1024 * 1024
# Longest base64 text (``isBase64Encoded``) that can decode to MAX_BODY_BYTES:
# 4 characters per 3 bytes, rounded up to a whole quantum.
MAX_BODY_BASE64_CHARS = 4 * -(-MAX_BODY_BYTES // 3)


def _reject_constant(name: str) -> Any:
    """Refuse ``NaN``, ``Infinity`` and ``-Infinity``, which are not JSON."""
    raise ValueError(f"Invalid JSON constant: {name}")


def _finite_float(text: str) -> float:
    """Parse a JSON float, refusing values that overflow to infinity (``1e999``)."""
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"Float out of range: {text[:20]}")
    return value


def _body_text(event: Event) -> str:
    """Return the request body as text, checking its size before decoding.

    Raises:
        PayloadTooLargeError: If the body is above MAX_BODY_BYTES.
        ValueError: If the body is missing or cannot be decoded (callers turn
            it into a 400).
    """
    raw = event.get("body")
    if not isinstance(raw, str) or not raw:
        raise ValueError("Missing body")
    encoded = bool(event.get("isBase64Encoded"))
    # Cheap length checks first, so an oversized body is never decoded or
    # copied: base64 against its own limit, and plain text by characters
    # (a str never has more characters than UTF-8 bytes).
    if len(raw) > (MAX_BODY_BASE64_CHARS if encoded else MAX_BODY_BYTES):
        raise PayloadTooLargeError(MSG_BODY_TOO_LARGE)
    data = base64.b64decode(raw, validate=True) if encoded else raw.encode("utf-8")
    if len(data) > MAX_BODY_BYTES:
        raise PayloadTooLargeError(MSG_BODY_TOO_LARGE)
    return data.decode("utf-8") if encoded else raw


def _check_utf8_strings(value: Any) -> None:
    """Refuse strings (values and keys, at any depth) that are not valid Unicode.

    ``json.loads`` accepts escapes of lone surrogates such as ``\\ud800`` and
    returns a str that cannot be encoded in UTF-8, which would break later when
    the text is stored. The walk uses an explicit stack, so it never hits the
    recursion limit on bodies the parser accepted.

    Raises:
        UnicodeEncodeError: On the first string that is not valid UTF-8.
    """
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            item.encode("utf-8")
        elif isinstance(item, dict):
            stack.extend(item.keys())
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)


def json_body(event: Event) -> dict[str, Any]:
    """Return the request body parsed as a JSON object.

    Every way of failing to read the body is a 400, never a 500: invalid base64
    or bytes that are not UTF-8 (such as a raw image sent with
    ``isBase64Encoded``), malformed JSON, JSON nested too deeply for the parser
    (``RecursionError``), integers above Python's digit limit, the non-JSON
    constants ``NaN``/``Infinity``/``-Infinity``, floats that overflow to
    infinity (``1e999``) and escaped lone surrogates (``\\ud800``) in any
    string or key, which cannot be encoded in UTF-8. The size is checked before parsing: above
    MAX_BODY_BYTES the answer is 413.

    Raises:
        PayloadTooLargeError: If the body is above MAX_BODY_BYTES.
        ValidationError: If the body is missing, unreadable or not a JSON
            object.
    """
    try:
        body = json.loads(
            _body_text(event), parse_constant=_reject_constant, parse_float=_finite_float
        )
        _check_utf8_strings(body)
    # ValueError covers JSONDecodeError, UnicodeDecodeError/UnicodeEncodeError
    # and the integer digit limit; binascii.Error is a ValueError as well, but
    # is listed to make the base64 case explicit.
    except (ValueError, RecursionError, binascii.Error) as exc:
        raise ValidationError(MSG_INVALID_BODY) from exc
    if not isinstance(body, dict):
        raise ValidationError(MSG_INVALID_BODY)
    return body


def path_param(event: Event, name: str) -> str:
    """Return a path parameter (always present when the route matched)."""
    return event["pathParameters"][name]


def query_param(event: Event, name: str) -> str | None:
    """Return a query string parameter, or None."""
    return (event.get("queryStringParameters") or {}).get(name)
