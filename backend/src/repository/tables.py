"""DynamoDB table access; table names come from environment variables set by SAM."""

import logging
import os
import random
import time
from collections.abc import Callable, Iterator
from functools import lru_cache
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

BELTS_TABLE_ENV = "BELTS_TABLE"
STUDENTS_TABLE_ENV = "STUDENTS_TABLE"
EXAMS_TABLE_ENV = "EXAMS_TABLE"
REQUIREMENTS_TABLE_ENV = "REQUIREMENTS_TABLE"
SETTINGS_TABLE_ENV = "SETTINGS_TABLE"
EVENTS_TABLE_ENV = "EVENTS_TABLE"


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


def replace_fields(item: dict[str, Any], key_names: tuple[str, ...] = ("id",)) -> dict[str, Any]:
    """Build ``update_item`` arguments that rewrite only the model's attributes.

    Unlike ``put_item``, attributes kept by other writers (for example the
    ``exam_count`` counter) survive. Attributes whose value is None are removed.

    Args:
        item: Every attribute of the model, keys included.
        key_names: Key attributes, left out of the expression.

    Returns:
        ``Key``, ``UpdateExpression``, ``ExpressionAttributeNames`` and
        ``ExpressionAttributeValues``; the caller may add a condition.
    """
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    sets: list[str] = []
    removes: list[str] = []
    for index, (attribute, value) in enumerate(item.items()):
        if attribute in key_names:
            continue
        names[f"#f{index}"] = attribute
        if value is None:
            removes.append(f"#f{index}")
        else:
            values[f":f{index}"] = value
            sets.append(f"#f{index} = :f{index}")
    expression = "SET " + ", ".join(sets)
    if removes:
        expression += " REMOVE " + ", ".join(removes)
    return {
        "Key": {name: item[name] for name in key_names},
        "UpdateExpression": expression,
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": values,
    }


# Exams counter kept on events and students by the attendance transaction.
# Items without the attribute count as zero.
EXAM_COUNT = "exam_count"
NO_EXAMS_CONDITION = f"attribute_not_exists({EXAM_COUNT}) OR {EXAM_COUNT} = :zero"


# Errors DynamoDB returns when a table or GSI runs out of provisioned capacity.
THROTTLING_ERRORS = frozenset(
    {"ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"}
)
BACKOFF_BASE_SECONDS = 0.1
BACKOFF_CAP_SECONDS = 5.0


class DeadlineExceededError(Exception):
    """The write did not finish before the caller's deadline."""


def put_if_absent(
    target: Any,
    item: dict[str, Any],
    *,
    deadline: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Insert ``item`` only if its ``id`` does not exist, retrying on throttling.

    Throttling (low provisioned capacity on the table or on a GSI) is retried
    with exponential backoff and full jitter until it succeeds or the deadline
    passes. Botocore's own retries (up to ~25 s in legacy mode) run first,
    inside each attempt, so callers should keep that much slack after the
    deadline.

    Args:
        target: DynamoDB ``Table`` resource.
        item: Item with an ``id`` attribute.
        deadline: ``clock()`` value after which no new attempt starts; None waits forever.
        sleep: Injected for tests.
        clock: Injected for tests.

    Returns:
        True if the item was inserted, False if it already existed.

    Raises:
        DeadlineExceededError: Still throttled when the deadline passed.
    """
    attempt = 0
    while True:
        if deadline is not None and clock() >= deadline:
            raise DeadlineExceededError(f"Deadline passed before writing {item.get('id')!r}")
        try:
            target.put_item(Item=item, ConditionExpression="attribute_not_exists(id)")
            return True
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code == "ConditionalCheckFailedException":
                return False
            if code not in THROTTLING_ERRORS:
                raise
        delay = random.uniform(0, min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2**attempt))
        if deadline is not None and clock() + delay >= deadline:
            raise DeadlineExceededError(f"Throttled writing {item.get('id')!r} until the deadline")
        attempt += 1
        logger.info("Throttled writing %s, retry %d in %.2fs", item.get("id"), attempt, delay)
        sleep(delay)
