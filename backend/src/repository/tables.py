"""DynamoDB table access; table names come from environment variables set by SAM."""

import logging
import os
import random
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from functools import lru_cache
from typing import Any

import boto3
from botocore.exceptions import ClientError

from domain.errors import MSG_SERVICE_BUSY, ServiceUnavailableError

logger = logging.getLogger(__name__)

BELTS_TABLE_ENV = "BELTS_TABLE"
STUDENTS_TABLE_ENV = "STUDENTS_TABLE"
EXAMS_TABLE_ENV = "EXAMS_TABLE"
REQUIREMENTS_TABLE_ENV = "REQUIREMENTS_TABLE"
SETTINGS_TABLE_ENV = "SETTINGS_TABLE"
EVENTS_TABLE_ENV = "EVENTS_TABLE"
ANSWERS_TABLE_ENV = "ANSWERS_TABLE"


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

    Raises:
        ServiceUnavailableError: If a page kept throttling after botocore's retries (503).
        ClientError: Any other DynamoDB error, unchanged.
    """
    while True:
        try:
            response = operation(**kwargs)
        except ClientError as exc:
            raise_if_throttled(exc, _describe(operation, kwargs))
            raise
        yield from response.get("Items", [])
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            return
        kwargs["ExclusiveStartKey"] = last_key


def _describe(operation: Any, kwargs: dict[str, Any]) -> str:
    """Describe a scan or query for the log, e.g. ``Query on Exams (index by_student)``."""
    name = getattr(operation, "__name__", "operation").capitalize()
    owner = getattr(getattr(operation, "__self__", None), "name", "table")
    index = kwargs.get("IndexName")
    return f"{name} on {owner}" + (f" (index {index})" if index else "")


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

# Id of the student's exam in progress, set by the attendance transaction only
# while absent (one exam in progress per student, RN005) and removed by the
# decision transaction (RN008). Not a model field: ``replace_fields`` keeps it.
# Exams confirmed before it existed (dev only) have no marker.
EXAM_IN_PROGRESS = "exam_in_progress_id"

# Answers counter kept on requirements by the marking transactions (RN006):
# +1 with the first answer of an (exam, item), -1 when it is unmarked.
ANSWER_COUNT = "answer_count"
NO_ANSWERS_CONDITION = f"attribute_not_exists({ANSWER_COUNT}) OR {ANSWER_COUNT} = :zero"


# Errors DynamoDB returns when a table or GSI runs out of provisioned capacity.
THROTTLING_ERRORS = frozenset(
    {"ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"}
)


def raise_if_throttled(exc: ClientError, source: str) -> None:
    """Turn throttling that outlasted botocore's retries into a 503; ignore other errors.

    Args:
        exc: Error raised by a DynamoDB call.
        source: What was being accessed, for the log.

    Raises:
        ServiceUnavailableError: If ``exc`` is a throttling error.
    """
    code = exc.response["Error"]["Code"]
    if code in THROTTLING_ERRORS:
        logger.warning("%s throttled after botocore retries: %s", source, code)
        raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc


def get_item_or_busy(target: Any, key: dict[str, Any], **options: Any) -> dict[str, Any] | None:
    """Read one item by key from the ``target`` table, turning persistent throttling into a 503.

    Extra ``options`` (e.g. ``ProjectionExpression``) go to ``get_item`` as given.

    Raises:
        ServiceUnavailableError: If the table kept throttling.
        ClientError: Any other DynamoDB error, unchanged.
    """
    try:
        return target.get_item(Key=key, **options).get("Item")
    except ClientError as exc:
        raise_if_throttled(exc, f"GetItem on {getattr(target, 'name', 'table')}")
        raise


BATCH_GET_LIMIT = 100
# Calls per block of keys in ``batch_get``: the first plus up to 3 retries of
# the unprocessed keys, waiting 0.05-0.1 s, 0.1-0.2 s and 0.2-0.4 s (at most
# 0.7 s in all), well inside the functions' 10 s timeout.
BATCH_GET_ATTEMPTS = 4
BATCH_GET_BACKOFF_SECONDS = 0.05


def batch_get(
    target: Any,
    keys: Iterable[dict[str, Any]],
    *,
    attributes: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Read items by key from the ``target`` table with ``BatchGetItem``.

    Eventually consistent, 100 keys per call; missing keys are left out of the
    result, in no particular order. Keys that DynamoDB returns as unprocessed
    (part of the batch ran out of capacity) are asked again with a short
    exponential backoff and jitter, as AWS recommends.

    Args:
        target: DynamoDB ``Table`` resource.
        keys: Distinct keys (``BatchGetItem`` refuses a repeated key).
        attributes: Top-level attributes to read (``ProjectionExpression``,
            with every name escaped); None reads whole items.

    Raises:
        ServiceUnavailableError: If the whole call kept throttling after
            botocore's retries, or keys were still unprocessed after
            ``BATCH_GET_ATTEMPTS`` calls (503).
        ClientError: Any other DynamoDB error, unchanged.
    """
    keys = list(keys)
    client = target.meta.client
    options: dict[str, Any] = {}
    if attributes:
        names = {f"#p{index}": attribute for index, attribute in enumerate(attributes)}
        options = {"ProjectionExpression": ", ".join(names), "ExpressionAttributeNames": names}
    items: list[dict[str, Any]] = []
    for start in range(0, len(keys), BATCH_GET_LIMIT):
        # DynamoDB echoes the projection in ``UnprocessedKeys``, so retries keep it.
        request: dict[str, Any] = {
            target.name: {"Keys": keys[start : start + BATCH_GET_LIMIT], **options}
        }
        for attempt in range(BATCH_GET_ATTEMPTS):
            if attempt:
                time.sleep(BATCH_GET_BACKOFF_SECONDS * 2 ** (attempt - 1) * (1 + random.random()))
            try:
                response = client.batch_get_item(RequestItems=request)
            except ClientError as exc:
                raise_if_throttled(exc, f"BatchGetItem on {target.name}")
                raise
            items.extend(response.get("Responses", {}).get(target.name, []))
            request = response.get("UnprocessedKeys") or {}
            if not request:
                break
        if request:
            logger.warning(
                "BatchGetItem on %s still had unprocessed keys after %d calls",
                target.name,
                BATCH_GET_ATTEMPTS,
            )
            raise ServiceUnavailableError(MSG_SERVICE_BUSY)
    return items


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
