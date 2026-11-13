"""Shared fixtures: mocked AWS (moto) mirroring infra/template.yaml, and API events."""

import json
import os
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
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
os.environ["REQUIREMENT_PROFILE_COPY_FUNCTION"] = "test-copy-requirement-profile"

from domain import dates  # noqa: E402
from domain.belts import SEED_BELTS, Belt, seed_belt_id  # noqa: E402
from domain.errors import MSG_SERVICE_BUSY  # noqa: E402
from domain.events import EventStatus, ExamEvent  # noqa: E402
from domain.requirements import Requirement, RequirementKind  # noqa: E402
from domain.settings import AcademySettings  # noqa: E402
from domain.students import Student  # noqa: E402
from domain.users import ADMIN_GROUP, GUARDIAN_GROUP, MASTER_GROUP, User  # noqa: E402
from handlers import belts as belt_handlers  # noqa: E402
from handlers import events as event_handlers  # noqa: E402
from handlers import exams as exam_handlers  # noqa: E402
from handlers import requirements as requirement_handlers  # noqa: E402
from handlers import students as student_handlers  # noqa: E402
from repository import belts as belt_repo  # noqa: E402
from repository import events as event_repo  # noqa: E402
from repository import images as image_repo  # noqa: E402
from repository import requirement_profiles as profile_repo  # noqa: E402
from repository import requirements as requirement_repo  # noqa: E402
from repository import settings as settings_repo  # noqa: E402
from repository import students as student_repo  # noqa: E402
from repository import tables  # noqa: E402
from repository import users as user_repo  # noqa: E402

GUARDIAN_SUB = "guardian-1"
OTHER_GUARDIAN_SUB = "guardian-2"
EXAMINER_SUB = "examiner-1"
MASTER_SUB = "master-1"

# Non-key attributes projected into ``Requirements.by_profile_belt`` (as in the
# template): every field of the model but ``id`` and ``sort_order``, never
# ``answer_count``, so a first mark (RN006) does not write to that index.
REQUIREMENT_PROFILE_BELT_ATTRIBUTES = [
    "belt_id",
    "kind",
    "category",
    "description",
    "expected_answer",
    "profile_id",
]


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
            {"AttributeName": "profile_belt", "AttributeType": "S"},
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
            },
            {
                "IndexName": "by_profile_belt",
                "KeySchema": [
                    {"AttributeName": "profile_belt", "KeyType": "HASH"},
                    {"AttributeName": "sort_order", "KeyType": "RANGE"},
                ],
                "Projection": {
                    "ProjectionType": "INCLUDE",
                    "NonKeyAttributes": REQUIREMENT_PROFILE_BELT_ATTRIBUTES,
                },
            },
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
        profile_repo.reset_cache()
        requirement_repo.reset_cache()
        _create_tables()
        yield
    tables.reset_cache()
    user_repo.reset_cache()
    image_repo.reset_cache()
    profile_repo.reset_cache()
    requirement_repo.reset_cache()


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


# --- Background copy of a requirement profile (#144) ---


@dataclass
class CopyInvocations:
    """Asynchronous ``Invoke`` calls of the profile copy function, caught before AWS.

    Attributes:
        calls: ``FunctionName``, ``InvocationType`` and decoded ``Payload`` of
            each call, in order.
        error_code: While set, every call fails with this AWS error code (the
            copy could not be queued).
    """

    calls: list[dict[str, Any]] = field(default_factory=list)
    error_code: str | None = None

    @property
    def profile_ids(self) -> list[str]:
        """The ``profile_id`` of every successful call, in order."""
        return [call["Payload"]["profile_id"] for call in self.calls]


@pytest.fixture
def copy_invocations(aws: None, monkeypatch: pytest.MonkeyPatch) -> CopyInvocations:
    """Catch Lambda ``Invoke`` (the copy is not run: tests call it themselves)."""
    from botocore.client import BaseClient

    invocations = CopyInvocations()
    original = BaseClient._make_api_call

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name != "Invoke":
            return original(self, operation_name, api_params)
        if invocations.error_code is not None:
            raise ClientError(
                {"Error": {"Code": invocations.error_code, "Message": "refused"}}, operation_name
            )
        invocations.calls.append(
            {
                "FunctionName": api_params["FunctionName"],
                "InvocationType": api_params["InvocationType"],
                "Payload": json.loads(api_params["Payload"]),
            }
        )
        return {"StatusCode": 202}

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return invocations


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


_WRITE_OPERATIONS = frozenset({"PutItem", "UpdateItem", "DeleteItem"})
_TRANSACTION_WRITES = ("Put", "Update", "Delete")


def _projected(api_params: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """Apply a ``GetItem`` ``ProjectionExpression`` of top-level attributes to ``item``."""
    projection = api_params.get("ProjectionExpression")
    if not projection:
        return dict(item)
    names = api_params.get("ExpressionAttributeNames") or {}
    wanted = {names.get(part.strip(), part.strip()) for part in projection.split(",")}
    return {attribute: value for attribute, value in item.items() if attribute in wanted}


def lag_eventual_reads(
    monkeypatch: pytest.MonkeyPatch, table_env: str, *, writes_behind: int = 1
) -> list[dict[str, Any]]:
    """Make the table behave like a DynamoDB replica ``writes_behind`` writes behind.

    From this call on, each write that lands on the table records the item as
    it was before the write: ``PutItem``, ``UpdateItem``, ``DeleteItem`` and the
    ``Put``/``Update``/``Delete`` items of a ``TransactWriteItems`` (attendance,
    decision and marking only write through transactions), for any key schema
    (``id``, or ``event_id`` + ``student_id`` on ``Exams``). A write refused by
    its condition, or a cancelled transaction, records nothing.

    A ``GetItem`` without ``ConsistentRead=True`` on a key written since the
    call gets the version from ``writes_behind`` writes ago (no item for one
    created within them; the version from the call when fewer writes were
    made), with its ``ProjectionExpression`` applied, as an eventually
    consistent read can up to about one second after the writes. Strongly
    consistent reads, keys not written since the call and other tables go to
    moto unchanged. Calls for different tables stack.

    Args:
        monkeypatch: The test's ``monkeypatch``.
        table_env: Environment variable with the table name (``*_TABLE_ENV``).
        writes_behind: How many of the latest writes of each key the
            eventually consistent reads miss (default 1).

    Returns:
        The parameters of every ``GetItem`` on the table, in call order.
    """
    from botocore.client import BaseClient

    table_name = os.environ[table_env]
    key_schema = boto3.client("dynamodb").describe_table(TableName=table_name)["Table"]["KeySchema"]
    key_names = [part["AttributeName"] for part in key_schema]
    # Per key, the item before each write that landed since the call (None: absent).
    history: dict[str, list[dict[str, Any] | None]] = {}
    get_calls: list[dict[str, Any]] = []
    original = BaseClient._make_api_call

    def written_keys(operation_name: str, api_params: dict[str, Any]) -> list[dict[str, Any]]:
        if operation_name == "TransactWriteItems":
            entries = [
                entry[kind]
                for entry in api_params.get("TransactItems", [])
                for kind in _TRANSACTION_WRITES
                if kind in entry
            ]
        elif operation_name in _WRITE_OPERATIONS:
            entries = [api_params]
        else:
            return []
        return [
            entry.get("Key") or {name: entry["Item"][name] for name in key_names}
            for entry in entries
            if entry.get("TableName") == table_name
        ]

    def lagging(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name == "GetItem" and api_params.get("TableName") == table_name:
            get_calls.append(dict(api_params))
            versions = history.get(_key_id(api_params["Key"]))
            if api_params.get("ConsistentRead") is not True and versions:
                old = versions[max(0, len(versions) - writes_behind)]
                return {"Item": _projected(api_params, old)} if old is not None else {}
            return original(self, operation_name, api_params)
        keys = written_keys(operation_name, api_params)
        if not keys:
            return original(self, operation_name, api_params)
        before = [
            original(
                self, "GetItem", {"TableName": table_name, "Key": key, "ConsistentRead": True}
            ).get("Item")
            for key in keys
        ]
        response = original(self, operation_name, api_params)
        # Reached only when the write landed: a refused condition raises above.
        for key, item in zip(keys, before, strict=True):
            history.setdefault(_key_id(key), []).append(item)
        return response

    monkeypatch.setattr(BaseClient, "_make_api_call", lagging)
    return get_calls


# --- DynamoDB capacity limit that outlasted botocore's retries (#43) ---

DYNAMODB_THROTTLING_CODES = (
    "ProvisionedThroughputExceededException",
    "ThrottlingException",
    "RequestLimitExceeded",
)
# Every DynamoDB operation that writes, so a test throttles the write whatever
# call the repository uses for it.
DYNAMODB_WRITES = ("PutItem", "UpdateItem", "DeleteItem", "BatchWriteItem", "TransactWriteItems")


def dynamodb_tables_of(api_params: dict[str, Any]) -> set[str]:
    """Return the names of the tables a DynamoDB call touches (any operation)."""
    names = set(api_params.get("RequestItems") or {})
    if api_params.get("TableName"):
        names.add(api_params["TableName"])
    for entry in api_params.get("TransactItems") or []:
        names.update(body.get("TableName") for body in entry.values() if isinstance(body, dict))
    return names


class CallLimitExceededError(Exception):
    """A stubbed DynamoDB call was repeated more times than the test allows."""


@dataclass
class DynamoStub:
    """State of a stubbed DynamoDB call: on/off switch and the calls it answered.

    Attributes:
        calls: Parameters of every call the stub answered, in order.
        max_calls: Most calls the stub answers; the next one raises
            ``CallLimitExceededError`` (a retry loop without a limit).
        active: While False, the calls go to moto unchanged and are not recorded.
    """

    max_calls: int
    active: bool = True
    calls: list[dict[str, Any]] = field(default_factory=list)

    def answer(self, api_params: dict[str, Any]) -> None:
        """Record a call, refusing it past ``max_calls``."""
        self.calls.append(dict(api_params))
        if len(self.calls) > self.max_calls:
            raise CallLimitExceededError(f"more than {self.max_calls} calls")


def _stub_dynamodb(
    monkeypatch: pytest.MonkeyPatch,
    operations: str | Iterable[str],
    table_env: str,
    stub: DynamoStub,
    respond: Callable[[str, dict[str, Any]], Any],
    matches: Callable[[dict[str, Any]], bool] | None,
) -> None:
    from botocore.client import BaseClient

    wanted = {operations} if isinstance(operations, str) else set(operations)
    table_name = os.environ[table_env]
    original = BaseClient._make_api_call

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if (
            stub.active
            and operation_name in wanted
            and table_name in dynamodb_tables_of(api_params)
            and (matches is None or matches(api_params))
        ):
            stub.answer(api_params)
            return respond(operation_name, api_params)
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)


def throttle_dynamodb(
    monkeypatch: pytest.MonkeyPatch,
    operations: str | Iterable[str],
    table_env: str,
    *,
    code: str = "ProvisionedThroughputExceededException",
    matches: Callable[[dict[str, Any]], bool] | None = None,
    active: bool = True,
    max_calls: int = 10,
    cancellation_reason: str | None = None,
) -> DynamoStub:
    """Make ``operations`` on the table fail with ``code``, as after botocore's retries.

    Patches ``BaseClient._make_api_call``, so the throttling reaches the call
    whatever path the repository takes (the ``Table`` resource or its
    ``meta.client``, with or without ``get_item_or_busy``). Calls of other
    operations and tables go to moto unchanged. Stubs stack.

    Args:
        monkeypatch: The test's ``monkeypatch``.
        operations: DynamoDB operation names (``GetItem``, ``DYNAMODB_WRITES``...).
        table_env: Environment variable with the table name (``*_TABLE_ENV``).
        code: Error code, one of ``DYNAMODB_THROTTLING_CODES``.
        matches: Only calls whose parameters it accepts are throttled.
        active: Start switched on (set ``stub.active`` to change it later).
        max_calls: Throttled calls allowed before ``CallLimitExceededError``.
        cancellation_reason: For ``TransactWriteItems``, throttle inside the
            transaction instead: ``TransactionCanceledException`` with this
            reason (``ThrottlingError`` or ``ProvisionedThroughputExceeded``)
            on every item; ``code`` is then ignored.

    Returns:
        The stub, with every throttled call's parameters in ``calls``.
    """
    stub = DynamoStub(max_calls=max_calls, active=active)

    def respond(operation_name: str, api_params: dict[str, Any]) -> Any:
        if cancellation_reason is not None:
            items = api_params.get("TransactItems") or []
            raise ClientError(
                {
                    "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                    "CancellationReasons": [{"Code": cancellation_reason} for _ in items],
                },
                operation_name,
            )
        raise ClientError({"Error": {"Code": code, "Message": "throttled"}}, operation_name)

    _stub_dynamodb(monkeypatch, operations, table_env, stub, respond, matches)
    return stub


def leave_batch_unprocessed(
    monkeypatch: pytest.MonkeyPatch, table_env: str, *, times: int | None, max_calls: int = 10
) -> DynamoStub:
    """Answer ``BatchGetItem`` on the table with every key in ``UnprocessedKeys``.

    That is what DynamoDB answers when the whole batch ran out of capacity.

    Args:
        times: How many calls get that answer before the table answers for
            real; None for every call (capacity that never comes back).
        max_calls: Unprocessed answers allowed before ``CallLimitExceededError``.
    """
    from botocore.client import BaseClient

    table_name = os.environ[table_env]
    stub = DynamoStub(max_calls=max_calls)
    original = BaseClient._make_api_call

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if (
            stub.active
            and operation_name == "BatchGetItem"
            and table_name in api_params.get("RequestItems", {})
            and (times is None or len(stub.calls) < times)
        ):
            stub.answer(api_params)
            return {"Responses": {table_name: []}, "UnprocessedKeys": api_params["RequestItems"]}
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return stub


def before_dynamodb_call(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    table_env: str,
    action: Callable[[], None],
) -> list[dict[str, Any]]:
    """Run ``action`` right before the first ``operation`` on the table reaches moto.

    Used to change the state between the handler's reads and its write (a
    concurrent request) or to switch a stub on only for what comes after.

    Returns:
        Parameters of the call that triggered ``action`` (empty if none did).
    """
    from botocore.client import BaseClient

    table_name = os.environ[table_env]
    triggered: list[dict[str, Any]] = []
    original = BaseClient._make_api_call

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if (
            not triggered
            and operation_name == operation
            and table_name in dynamodb_tables_of(api_params)
        ):
            triggered.append(dict(api_params))
            action()
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return triggered


def assert_service_busy(response: dict[str, Any], stub: DynamoStub) -> None:
    """Assert the route answered 503 with only the busy message after hitting ``stub``.

    Also checks the stub was reached (the test simulates what it claims) and
    that the calls stopped within ``stub.max_calls`` (no retry loop without a
    limit).
    """
    assert stub.calls, f"a chamada limitada não foi feita ({response.get('body')})"
    assert len(stub.calls) <= stub.max_calls, (
        f"novas tentativas sem limite: mais de {stub.max_calls} chamadas"
    )
    assert response["statusCode"] == 503, response.get("body")
    assert response_json(response) == {"message": MSG_SERVICE_BUSY}


def dynamodb_snapshot() -> dict[str, list[str]]:
    """Return every item of every table (strongly consistent), to compare before and after.

    Call it with the throttling stubs switched off (``stub.active = False``).
    """
    resource = boto3.resource("dynamodb")
    snapshot: dict[str, list[str]] = {}
    for env in (
        "BELTS_TABLE",
        "STUDENTS_TABLE",
        "EXAMS_TABLE",
        "REQUIREMENTS_TABLE",
        "SETTINGS_TABLE",
        "EVENTS_TABLE",
        "ANSWERS_TABLE",
    ):
        target = resource.Table(os.environ[env])
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"ConsistentRead": True}
        while True:
            page = target.scan(**kwargs)
            items.extend(page.get("Items", []))
            if not page.get("LastEvaluatedKey"):
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        snapshot[env] = sorted(repr(sorted(item.items())) for item in items)
    return snapshot


# --- One exam in progress, reached by every route that reads by key (#43) ---

SCENARIO_NOW = "2026-11-01T12:00:00+00:00"
SCENARIO_EVENT_ID = "event-1"
SCENARIO_EMPTY_EVENT_ID = "event-empty"
SCENARIO_STUDENT_ID = "student-1"
SCENARIO_OTHER_STUDENT_ID = "student-2"
SCENARIO_REQUIREMENT = Requirement(
    id="t1",
    belt_id=seed_belt_id("Cinza/Azul"),
    kind=RequirementKind.THEORY,
    category="Vocabulário",
    description="Item t1",
    expected_answer="Resposta",
    sort_order=1,
)
SCENARIO_SENSEI = User(
    sub="sensei-1", email="sensei-1@example.com", groups=frozenset({ADMIN_GROUP})
)
_SCENARIO_EXAM_PATH = {"id": SCENARIO_EVENT_ID, "student_id": SCENARIO_STUDENT_ID}
_SCENARIO_ANSWER_PATH = {**_SCENARIO_EXAM_PATH, "requirement_id": SCENARIO_REQUIREMENT.id}


@pytest.fixture
def exam_scenario(seeded: list[Belt], monkeypatch: pytest.MonkeyPatch) -> None:
    """Data every route of ``SCENARIO_ROUTES`` succeeds on, with a fixed clock (2026-11-01).

    Open event ``event-1`` (2027-03-20) with Ana's exam in progress (attendance
    confirmed through the route) and item ``t1`` of her target belt
    (Cinza/Azul); open event ``event-empty`` without exams; Bia, eligible and
    not confirmed; ``SCENARIO_SENSEI`` set as sensei in the settings.
    """
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: SCENARIO_NOW)
    for event_id in (SCENARIO_EVENT_ID, SCENARIO_EMPTY_EVENT_ID):
        event_repo.create_event(
            ExamEvent(
                event_id,
                "Exame março/2027",
                date(2027, 3, 20),
                EventStatus.OPEN,
                SCENARIO_NOW,
                SCENARIO_NOW,
            )
        )
    for student_id, name in ((SCENARIO_STUDENT_ID, "Ana"), (SCENARIO_OTHER_STUDENT_ID, "Bia")):
        student = make_student()
        student_repo.create_student(
            Student(**{**vars(student), "id": student_id, "full_name": name})
        )
    requirement_repo.create_requirement(SCENARIO_REQUIREMENT)
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SCENARIO_SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=SCENARIO_NOW,
        )
    )
    confirmed = exam_handlers.confirm_attendance(
        api_event(
            EXAMINER, path={"id": SCENARIO_EVENT_ID}, body={"student_id": SCENARIO_STUDENT_ID}
        ),
        None,
    )
    assert confirmed["statusCode"] == 201, confirmed["body"]


def _belt_edit() -> dict[str, Any]:
    cinza = belt("Cinza")
    body = {**cinza.to_dict(), "min_months_previous": cinza.min_months_previous + 1}
    return belt_handlers.update_belt(api_event(EXAMINER, path={"id": cinza.id}, body=body), None)


def _student_registration() -> dict[str, Any]:
    body = {
        "full_name": "Caio",
        "birth_date": "2018-05-10",
        "current_belt_id": seed_belt_id("Cinza"),
        "current_belt_since": "2026-03-14",
        "stripes": 0,
    }
    return student_handlers.create_student(api_event(GUARDIAN, body=body), None)


def scenario_requirement_body(**changes: Any) -> dict[str, Any]:
    """Body of ``PUT /requirements/{id}`` for item ``t1``, with ``changes`` applied."""
    return {**SCENARIO_REQUIREMENT.to_dict(), **changes}


Route = Callable[[], dict[str, Any]]

# Every route of the scenario, called by a user allowed to use it. Writes
# change data that exists only in ``exam_scenario``.
SCENARIO_ROUTES: dict[str, Route] = {
    "GET /belts": lambda: belt_handlers.list_belts(api_event(EXAMINER), None),
    "PUT /belts/{id}": _belt_edit,
    "GET /students": lambda: student_handlers.list_students(api_event(EXAMINER), None),
    "GET /students (responsável)": lambda: student_handlers.list_students(
        api_event(GUARDIAN), None
    ),
    "POST /students": _student_registration,
    "GET /students/{id}": lambda: student_handlers.get_student(
        api_event(GUARDIAN, path={"id": SCENARIO_STUDENT_ID}), None
    ),
    "GET /requirements": lambda: requirement_handlers.list_requirements(api_event(EXAMINER), None),
    "GET /requirements?belt_id": lambda: requirement_handlers.list_requirements(
        api_event(EXAMINER, query={"belt_id": SCENARIO_REQUIREMENT.belt_id}), None
    ),
    # Items of the main profile: only the admin master writes them (#144).
    "POST /requirements": lambda: requirement_handlers.create_requirement(
        api_event(
            MASTER,
            body={
                "belt_id": SCENARIO_REQUIREMENT.belt_id,
                "kind": "THEORY",
                "category": "Vocabulário",
                "description": "Item novo",
            },
        ),
        None,
    ),
    "PUT /requirements/{id}": lambda: requirement_handlers.update_requirement(
        api_event(
            MASTER,
            path={"id": SCENARIO_REQUIREMENT.id},
            body=scenario_requirement_body(description="Item t1 (editado)"),
        ),
        None,
    ),
    "DELETE /requirements/{id}": lambda: requirement_handlers.delete_requirement(
        api_event(MASTER, path={"id": SCENARIO_REQUIREMENT.id}), None
    ),
    "GET /events": lambda: event_handlers.list_events(api_event(EXAMINER), None),
    "POST /events": lambda: event_handlers.create_event(
        api_event(EXAMINER, body={"name": "Exame setembro/2027", "exam_date": "2027-09-25"}), None
    ),
    "GET /events/{id}": lambda: event_handlers.get_event(
        api_event(EXAMINER, path={"id": SCENARIO_EVENT_ID}), None
    ),
    "PUT /events/{id}": lambda: event_handlers.update_event(
        api_event(
            EXAMINER,
            path={"id": SCENARIO_EVENT_ID},
            body={
                "name": "Exame março/2027 (editado)",
                "exam_date": "2027-03-20",
                "status": "OPEN",
            },
        ),
        None,
    ),
    "DELETE /events/{id}": lambda: event_handlers.delete_event(
        api_event(EXAMINER, path={"id": SCENARIO_EMPTY_EVENT_ID}), None
    ),
    "POST /events/{id}/exams": lambda: exam_handlers.confirm_attendance(
        api_event(
            EXAMINER,
            path={"id": SCENARIO_EVENT_ID},
            body={"student_id": SCENARIO_OTHER_STUDENT_ID},
        ),
        None,
    ),
    "GET /events/{id}/exams": lambda: exam_handlers.list_event_exams(
        api_event(EXAMINER, path={"id": SCENARIO_EVENT_ID}), None
    ),
    "GET /events/{id}/exams/{student_id}": lambda: exam_handlers.get_exam_sheet(
        api_event(EXAMINER, path=_SCENARIO_EXAM_PATH), None
    ),
    "PUT .../answers/{requirement_id}": lambda: exam_handlers.mark_answer(
        api_event(EXAMINER, path=_SCENARIO_ANSWER_PATH, body={"correct": True}), None
    ),
    "DELETE .../answers/{requirement_id}": lambda: exam_handlers.unmark_answer(
        api_event(EXAMINER, path=_SCENARIO_ANSWER_PATH), None
    ),
    "POST .../decision": lambda: exam_handlers.decide_exam(
        api_event(SCENARIO_SENSEI, path=_SCENARIO_EXAM_PATH, body={"result": "APPROVED"}), None
    ),
}
