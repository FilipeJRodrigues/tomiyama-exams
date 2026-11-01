"""Helpers shared by the API Gateway HTTP API handlers (payload format 2.0)."""

import base64
import functools
import json
import logging
import os
from collections.abc import Callable
from datetime import date
from decimal import Decimal
from typing import Any

from domain.errors import DomainError, ForbiddenError, UnauthorizedError, ValidationError
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

    The user id always comes from the token, never from the request body.

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


def json_body(event: Event) -> dict[str, Any]:
    """Return the request body parsed as a JSON object.

    Raises:
        ValidationError: If the body is missing or not a JSON object.
    """
    raw = event.get("body")
    if event.get("isBase64Encoded") and raw:
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        body = json.loads(raw or "")
    except json.JSONDecodeError as exc:
        raise ValidationError("Corpo da requisição inválido: envie um objeto JSON") from exc
    if not isinstance(body, dict):
        raise ValidationError("Corpo da requisição inválido: envie um objeto JSON")
    return body


def path_param(event: Event, name: str) -> str:
    """Return a path parameter (always present when the route matched)."""
    return event["pathParameters"][name]


def query_param(event: Event, name: str) -> str | None:
    """Return a query string parameter, or None."""
    return (event.get("queryStringParameters") or {}).get(name)
