"""Shared fixtures: mocked AWS (moto), tables that mirror infra/template.yaml, and API events."""

import json
import os
from collections.abc import Iterator
from datetime import date
from typing import Any

import boto3
import pytest
from moto import mock_aws

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["AWS_ACCESS_KEY_ID"] = "testing"
os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"
os.environ["AWS_SESSION_TOKEN"] = "testing"
os.environ["BELTS_TABLE"] = "test-belts"
os.environ["STUDENTS_TABLE"] = "test-students"
os.environ["EXAMS_TABLE"] = "test-exams"

from domain.belts import SEED_BELTS, Belt, seed_belt_id  # noqa: E402
from domain.students import Student  # noqa: E402
from domain.users import ADMIN_GROUP, GUARDIAN_GROUP, User  # noqa: E402
from repository import belts as belt_repo  # noqa: E402
from repository import tables  # noqa: E402

GUARDIAN_SUB = "guardian-1"
OTHER_GUARDIAN_SUB = "guardian-2"
EXAMINER_SUB = "examiner-1"


def _create_tables() -> None:
    client = boto3.client("dynamodb")
    client.create_table(
        TableName=os.environ["BELTS_TABLE"],
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
    )
    client.create_table(
        TableName=os.environ["STUDENTS_TABLE"],
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "id", "AttributeType": "S"},
            {"AttributeName": "owner_id", "AttributeType": "S"},
        ],
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "by_owner",
                "KeySchema": [{"AttributeName": "owner_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
    )
    client.create_table(
        TableName=os.environ["EXAMS_TABLE"],
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "event_id", "AttributeType": "S"},
            {"AttributeName": "student_id", "AttributeType": "S"},
        ],
        KeySchema=[
            {"AttributeName": "event_id", "KeyType": "HASH"},
            {"AttributeName": "student_id", "KeyType": "RANGE"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "by_student",
                "KeySchema": [
                    {"AttributeName": "student_id", "KeyType": "HASH"},
                    {"AttributeName": "event_id", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
    )


@pytest.fixture
def aws() -> Iterator[None]:
    """Mocked AWS account with empty tables."""
    with mock_aws():
        tables.reset_cache()
        _create_tables()
        yield
    tables.reset_cache()


@pytest.fixture
def seeded(aws: None) -> list[Belt]:
    """Mocked AWS account with the seed belts loaded."""
    belt_repo.seed_belts(SEED_BELTS)
    return list(SEED_BELTS)


def belt(name: str) -> Belt:
    """Return a seed belt by name."""
    return next(item for item in SEED_BELTS if item.name == name)


def belt_id(name: str) -> str:
    """Return the id of a seed belt by name."""
    return seed_belt_id(name)


def make_student(
    *,
    belt_name: str = "Cinza",
    birth: date = date(2018, 5, 10),
    since: date = date(2026, 3, 14),
    stripes: int = 0,
    owner_id: str = GUARDIAN_SUB,
    active: bool = True,
) -> Student:
    """Build a student for domain tests."""
    return Student(
        id="student-1",
        owner_id=owner_id,
        full_name="Ana",
        birth_date=birth,
        current_belt_id=belt_id(belt_name),
        current_belt_since=since,
        stripes=stripes,
        federation_id=None,
        active=active,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )


GUARDIAN = User(sub=GUARDIAN_SUB, email="pai@example.com", groups=frozenset({GUARDIAN_GROUP}))
OTHER_GUARDIAN = User(
    sub=OTHER_GUARDIAN_SUB, email="mae@example.com", groups=frozenset({GUARDIAN_GROUP})
)
EXAMINER = User(sub=EXAMINER_SUB, email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


def api_event(
    user: User | None,
    *,
    body: Any = None,
    path: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build an HTTP API (payload 2.0) event as delivered after the JWT authorizer.

    Groups are flattened into a string the way the HTTP API authorizer does.
    """
    claims: dict[str, Any] = {}
    if user is not None:
        claims = {
            "sub": user.sub,
            "email": user.email,
            "cognito:groups": f"[{' '.join(user.groups)}]",
        }
    return {
        "requestContext": {"authorizer": {"jwt": {"claims": claims}}},
        "pathParameters": path,
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }


def response_json(response: dict[str, Any]) -> Any:
    """Return the decoded JSON body of a handler response."""
    return json.loads(response["body"])
