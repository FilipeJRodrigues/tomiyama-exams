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
