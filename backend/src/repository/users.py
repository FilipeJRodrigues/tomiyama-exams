"""Read access to the Cognito user pool (examiners = group ``admin``).

The pool id comes from ``USER_POOL_ID``, set by SAM only on the functions that
need it. The client is cached across warm invocations and can be replaced in
tests (``client`` argument or ``reset_cache``).
"""

import logging
import os
from functools import lru_cache
from typing import Any

import boto3
from botocore.exceptions import ClientError

from domain.errors import MSG_SERVICE_BUSY, ServiceUnavailableError
from domain.users import ADMIN_GROUP, Examiner

logger = logging.getLogger(__name__)

USER_POOL_ID_ENV = "USER_POOL_ID"
# ListUsersInGroup returns at most 60 users per page.
PAGE_SIZE = 60
# Errors that mean "try again later" rather than a bug or a misconfiguration.
# botocore already retried throttling a few times before raising.
TEMPORARY_ERRORS = frozenset({"TooManyRequestsException", "InternalErrorException"})


@lru_cache(maxsize=1)
def _client() -> Any:
    """Return a cached Cognito client, reused across warm Lambda invocations."""
    return boto3.client("cognito-idp")


def reset_cache() -> None:
    """Drop the cached client (used by tests between mocked environments)."""
    _client.cache_clear()


def _attribute(user: dict[str, Any], name: str) -> str | None:
    for attribute in user.get("Attributes", []):
        if attribute.get("Name") == name:
            return attribute.get("Value") or None
    return None


def _to_examiner(user: dict[str, Any]) -> Examiner:
    return Examiner(
        # With e-mail as the username, Cognito's Username is an opaque id; the
        # token's ``sub`` (what the API stores) is an attribute.
        id=_attribute(user, "sub") or user["Username"],
        email=_attribute(user, "email"),
        name=_attribute(user, "name"),
        enabled=bool(user.get("Enabled", True)),
    )


def list_examiners(client: Any = None) -> list[Examiner]:
    """Return every member of the group ``admin``, enabled or not, following ``NextToken``.

    Args:
        client: Cognito client; the cached one when None.

    Raises:
        ServiceUnavailableError: If Cognito is throttling or temporarily failing.
    """
    client = client or _client()
    kwargs: dict[str, Any] = {
        "UserPoolId": os.environ[USER_POOL_ID_ENV],
        "GroupName": ADMIN_GROUP,
        "Limit": PAGE_SIZE,
    }
    examiners: list[Examiner] = []
    while True:
        try:
            response = client.list_users_in_group(**kwargs)
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code not in TEMPORARY_ERRORS:
                raise
            logger.warning("Cognito ListUsersInGroup failed after retries: %s", code)
            raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc
        examiners.extend(_to_examiner(user) for user in response.get("Users", []))
        token = response.get("NextToken")
        if not token:
            return examiners
        kwargs["NextToken"] = token
