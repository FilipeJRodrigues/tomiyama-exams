"""DynamoDB table access; table names come from environment variables set by SAM."""

import os
from collections.abc import Iterator
from functools import lru_cache
from typing import Any

import boto3

BELTS_TABLE_ENV = "BELTS_TABLE"
STUDENTS_TABLE_ENV = "STUDENTS_TABLE"
EXAMS_TABLE_ENV = "EXAMS_TABLE"
REQUIREMENTS_TABLE_ENV = "REQUIREMENTS_TABLE"
SETTINGS_TABLE_ENV = "SETTINGS_TABLE"


@lru_cache(maxsize=1)
def _resource() -> Any:
    """Return a cached DynamoDB resource, reused across warm Lambda invocations."""
    return boto3.resource("dynamodb")


def reset_cache() -> None:
    """Drop the cached resource (used by tests between mocked environments)."""
    _resource.cache_clear()


def table(env_var: str) -> Any:
    """Return the DynamoDB table whose name is in ``env_var``."""
    return _resource().Table(os.environ[env_var])


def paginate(operation: Any, **kwargs: Any) -> Iterator[dict[str, Any]]:
    """Yield every item of a scan or query, following ``LastEvaluatedKey``.

    Args:
        operation: ``table.scan`` or ``table.query``.
        **kwargs: Arguments forwarded to the operation.
    """
    while True:
        response = operation(**kwargs)
        yield from response.get("Items", [])
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            return
        kwargs["ExclusiveStartKey"] = last_key
