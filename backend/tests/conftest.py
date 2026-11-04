"""Shared fixtures: mocked AWS (moto) mirroring infra/template.yaml, and API events."""

import json
import os
from collections.abc import Iterator
from datetime import date
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["AWS_ACCESS_KEY_ID"] = "testing"
os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"
os.environ["AWS_SESSION_TOKEN"] = "testing"
os.environ["BELTS_TABLE"] = "test-belts"
os.environ["STUDENTS_TABLE"] = "test-students"
os.environ["EXAMS_TABLE"] = "test-exams"
os.environ["REQUIREMENTS_TABLE"] = "test-requirements"
os.environ["SETTINGS_TABLE"] = "test-settings"
os.environ["EVENTS_TABLE"] = "test-events"
os.environ["ANSWERS_TABLE"] = "test-answers"
os.environ["IMAGES_BUCKET"] = "test-academy-images"

from domain.belts import SEED_BELTS, Belt, seed_belt_id  # noqa: E402
from domain.students import Student  # noqa: E402
from domain.users import ADMIN_GROUP, GUARDIAN_GROUP, MASTER_GROUP, User  # noqa: E402
from repository import belts as belt_repo  # noqa: E402
from repository import images as image_repo  # noqa: E402
from repository import tables  # noqa: E402
from repository import users as user_repo  # noqa: E402

GUARDIAN_SUB = "guardian-1"
OTHER_GUARDIAN_SUB = "guardian-2"
EXAMINER_SUB = "examiner-1"
MASTER_SUB = "master-1"


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

    client.create_table(
        TableName=os.environ["REQUIREMENTS_TABLE"],
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "id", "AttributeType": "S"},
            {"AttributeName": "belt_id", "AttributeType": "S"},
            {"AttributeName": "sort_order", "AttributeType": "N"},
        ],
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "by_belt",
                "KeySchema": [
                    {"AttributeName": "belt_id", "KeyType": "HASH"},
                    {"AttributeName": "sort_order", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
    )
    client.create_table(
        TableName=os.environ["SETTINGS_TABLE"],
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
    )
    client.create_table(
        TableName=os.environ["EVENTS_TABLE"],
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
    )
    client.create_table(
        TableName=os.environ["ANSWERS_TABLE"],
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": "exam_id", "AttributeType": "S"},
            {"AttributeName": "requirement_id", "AttributeType": "S"},
        ],
        KeySchema=[
            {"AttributeName": "exam_id", "KeyType": "HASH"},
            {"AttributeName": "requirement_id", "KeyType": "RANGE"},
        ],
    )


@pytest.fixture
def aws() -> Iterator[None]:
    """Mocked AWS account with empty tables (the images bucket: ``images_bucket``)."""
    with mock_aws():
        tables.reset_cache()
        user_repo.reset_cache()
        image_repo.reset_cache()
        _create_tables()
        yield
    tables.reset_cache()
    user_repo.reset_cache()
    image_repo.reset_cache()


@pytest.fixture
def images_bucket(aws: None) -> str:
    """Mocked AWS account with the empty private images bucket (``IMAGES_BUCKET``)."""
    region = os.environ.get("AWS_REGION") or os.environ["AWS_DEFAULT_REGION"]
    options: dict[str, Any] = {}
    if region != "us-east-1":
        options["CreateBucketConfiguration"] = {"LocationConstraint": region}
    name = os.environ["IMAGES_BUCKET"]
    boto3.client("s3", region_name=region).create_bucket(Bucket=name, **options)
    return name


@pytest.fixture
def user_pool(aws: None, monkeypatch: pytest.MonkeyPatch) -> str:
    """Mocked Cognito pool (e-mail as username; groups ``admin``, ``responsavel``, ``master``).

    Sets ``USER_POOL_ID`` as SAM does on the functions that read the pool.
    """
    client = boto3.client("cognito-idp")
    pool_id = client.create_user_pool(PoolName="test-users", UsernameAttributes=["email"])[
        "UserPool"
    ]["Id"]
    for group in (ADMIN_GROUP, GUARDIAN_GROUP, MASTER_GROUP):
        client.create_group(UserPoolId=pool_id, GroupName=group)
    monkeypatch.setenv(user_repo.USER_POOL_ID_ENV, pool_id)
    return pool_id


def add_user(
    pool_id: str,
    email: str,
    *,
    name: str | None = None,
    groups: tuple[str, ...] = (ADMIN_GROUP,),
    enabled: bool = True,
) -> str:
    """Create a Cognito user in the mocked pool and return its ``sub``."""
    client = boto3.client("cognito-idp")
    attributes = [{"Name": "email", "Value": email}]
    if name is not None:
        attributes.append({"Name": "name", "Value": name})
    user = client.admin_create_user(UserPoolId=pool_id, Username=email, UserAttributes=attributes)
    for group in groups:
        client.admin_add_user_to_group(UserPoolId=pool_id, Username=email, GroupName=group)
    if not enabled:
        client.admin_disable_user(UserPoolId=pool_id, Username=email)
    return next(attr["Value"] for attr in user["User"]["Attributes"] if attr["Name"] == "sub")


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
# Admin master: an examiner who also chooses the sensei (groups ``admin`` and ``master``).
MASTER = User(
    sub=MASTER_SUB, email="master@example.com", groups=frozenset({ADMIN_GROUP, MASTER_GROUP})
)


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


# --- Certificate signature images (RN012), independent of the S3 key format ---


def signature_object_keys(bucket: str, signature_id: str) -> list[str]:
    """Return, sorted, the objects ``signatures/{id}`` and ``signatures/{id}/...``."""
    base = f"signatures/{signature_id}"
    paginator = boto3.client("s3").get_paginator("list_objects_v2")
    keys = [
        item["Key"]
        for page in paginator.paginate(Bucket=bucket, Prefix=base)
        for item in page.get("Contents", [])
    ]
    return sorted(key for key in keys if key == base or key.startswith(f"{base}/"))


def signature_image_meta(signature_id: str) -> dict[str, Any] | None:
    """Return the image metadata stored for the signature (None without image or signature)."""
    item = (
        boto3.resource("dynamodb")
        .Table(os.environ["SETTINGS_TABLE"])
        .get_item(Key={"id": "certificate_signatures"}, ConsistentRead=True)
        .get("Item")
    )
    for entry in (item or {}).get("signatures", []):
        if entry.get("id") == signature_id:
            image = entry.get("image")
            return dict(image) if isinstance(image, dict) else None
    return None


def signature_image_key(bucket: str, signature_id: str) -> str | None:
    """Return the S3 key the metadata points to (None without image metadata).

    Reads the key registered in the metadata, whatever the field name: a value
    that is the full key (``signatures/{id}...``) or its last part under
    ``signatures/{id}/``. Without a registered key (metadata of the fixed-key
    format), falls back to the signature's only object; with several objects and
    no registered key the metadata is ambiguous and the test fails.
    """
    meta = signature_image_meta(signature_id)
    if meta is None:
        return None
    base = f"signatures/{signature_id}"
    objects = signature_object_keys(bucket, signature_id)
    for value in meta.values():
        if not isinstance(value, str):
            continue
        if value == base or value.startswith(f"{base}/"):
            return value
        if f"{base}/{value}" in objects:
            return f"{base}/{value}"
    if len(objects) > 1:
        raise AssertionError(f"metadados sem chave registrada e vários objetos: {objects}")
    return objects[0] if objects else base


def read_signature_image(bucket: str, signature_id: str) -> tuple[bytes, str] | None:
    """Return (bytes, ContentType) of the object the metadata points to.

    None if there is no image metadata or the pointed object does not exist
    (never raises ``NoSuchKey``).
    """
    key = signature_image_key(bucket, signature_id)
    if key is None:
        return None
    try:
        stored = boto3.client("s3").get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] in {"NoSuchKey", "404"}:
            return None
        raise
    return stored["Body"].read(), stored["ContentType"]


# --- Eventually consistent reads (moto is always strongly consistent) ---


def _key_id(key: dict[str, Any]) -> str:
    return repr(sorted(key.items()))


def lag_eventual_reads(monkeypatch: pytest.MonkeyPatch, table_env: str) -> list[dict[str, Any]]:
    """Make the table behave like a DynamoDB replica one write behind.

    From this call on, each ``PutItem``, ``UpdateItem`` and ``DeleteItem`` on the
    table (PK ``id``) records the item as it was before the write. A ``GetItem``
    without ``ConsistentRead=True`` on that key gets the recorded old version
    (no item for one just created), as an eventually consistent read can up to
    about one second after the write. Strongly consistent reads, keys not
    written since the call and other tables go to moto unchanged.

    Returns:
        The parameters of every ``GetItem`` on the table, in call order.
    """
    from botocore.client import BaseClient

    table_name = os.environ[table_env]
    behind: dict[str, Any] = {}
    get_calls: list[dict[str, Any]] = []
    original = BaseClient._make_api_call

    def lagging(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if api_params.get("TableName") != table_name:
            return original(self, operation_name, api_params)
        if operation_name in {"PutItem", "UpdateItem", "DeleteItem"}:
            key = api_params.get("Key") or {"id": api_params["Item"]["id"]}
            before = original(
                self, "GetItem", {"TableName": table_name, "Key": key, "ConsistentRead": True}
            )
            behind[_key_id(key)] = before.get("Item")
        elif operation_name == "GetItem":
            get_calls.append(dict(api_params))
            key_id = _key_id(api_params["Key"])
            if api_params.get("ConsistentRead") is not True and key_id in behind:
                old = behind[key_id]
                return {"Item": dict(old)} if old is not None else {}
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", lagging)
    return get_calls
