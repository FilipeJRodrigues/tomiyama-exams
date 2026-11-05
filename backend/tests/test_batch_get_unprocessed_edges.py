"""Edges of the limited ``BatchGetItem`` retries and of the HTTP safety net (qa, #43).

- Unprocessed keys that come back in part, over two blocks of 100 keys, keep
  the projection and stop after ``BATCH_GET_ATTEMPTS`` calls per block.
- An ``UnprocessedKeys`` without the projection still yields the names.
- No ids, no call; the worst wait per block stays within 0.7 s.
- The net leaves the S3 and Cognito throttling codes (handled where those
  clients are called) as 500 if they ever escape.
"""

import os
from typing import Any

import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from conftest import make_student

from domain.errors import ServiceUnavailableError
from domain.students import Student
from handlers.http import api_handler
from repository import students as student_repo
from repository import tables
from repository.tables import STUDENTS_TABLE_ENV


def _many_students(count: int) -> list[str]:
    base = make_student()
    ids = []
    for index in range(count):
        student_id = f"s-{index:03d}"
        student_repo.create_student(
            Student(**{**vars(base), "id": student_id, "full_name": f"Aluno {index:03d}"})
        )
        ids.append(student_id)
    return ids


def test_partially_unprocessed_block_keeps_projection_and_stops(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = _many_students(150)
    monkeypatch.setattr(tables.time, "sleep", lambda _s: None)
    name = os.environ[STUDENTS_TABLE_ENV]
    original = BaseClient._make_api_call
    requests: list[dict[str, Any]] = []

    def patched(self: BaseClient, op: str, params: dict[str, Any]) -> Any:
        if op == "BatchGetItem" and name in params.get("RequestItems", {}):
            request = params["RequestItems"][name]
            requests.append(dict(request))
            if len(request["Keys"]) > 1:
                half = len(request["Keys"]) // 2
                processed = {**params["RequestItems"]}
                processed[name] = {**request, "Keys": request["Keys"][:half]}
                answer = original(self, op, {"RequestItems": processed})
                answer["UnprocessedKeys"] = {name: {**request, "Keys": request["Keys"][half:]}}
                return answer
        return original(self, op, params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    # The first block halves 100 -> 50 -> 25 -> 13 and still has keys left
    # after 4 calls: 503 without reaching the second block.
    with pytest.raises(ServiceUnavailableError):
        student_repo.get_names(ids)
    assert all("ProjectionExpression" in r for r in requests)
    assert len(requests) == 4


def test_unprocessed_keys_without_projection_still_give_the_names(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = _many_students(150)
    monkeypatch.setattr(tables.time, "sleep", lambda _s: None)
    name = os.environ[STUDENTS_TABLE_ENV]
    original = BaseClient._make_api_call
    requests: list[dict[str, Any]] = []

    def patched(self: BaseClient, op: str, params: dict[str, Any]) -> Any:
        if op == "BatchGetItem" and name in params.get("RequestItems", {}):
            request = params["RequestItems"][name]
            requests.append(dict(request))
            if len(requests) in (1, 3):  # first call of each chunk: 10 keys unprocessed
                keep = {name: {**request, "Keys": request["Keys"][10:]}}
                answer = original(self, op, {"RequestItems": keep})
                # Unlike DynamoDB, the echo leaves the projection out.
                answer["UnprocessedKeys"] = {name: {"Keys": request["Keys"][:10]}}
                return answer
        return original(self, op, params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    names = student_repo.get_names(ids)
    assert len(names) == 150
    assert names["s-000"] == "Aluno 000"
    assert len(requests) == 4


def test_empty_names_make_no_call(aws: None, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    original = BaseClient._make_api_call

    def patched(self: BaseClient, op: str, params: dict[str, Any]) -> Any:
        calls.append(op)
        return original(self, op, params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    assert student_repo.get_names([]) == {}
    assert calls == []


def test_worst_wait_per_block_is_at_most_0_7_s(aws: None, monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(tables.time, "sleep", slept.append)
    monkeypatch.setattr(tables.random, "random", lambda: 0.999999)
    name = os.environ[STUDENTS_TABLE_ENV]

    def patched(self: BaseClient, op: str, params: dict[str, Any]) -> Any:
        return {"Responses": {name: []}, "UnprocessedKeys": params["RequestItems"]}

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    with pytest.raises(ServiceUnavailableError):
        student_repo.get_names([f"s-{i}" for i in range(250)])
    assert len(slept) == 3
    assert sum(slept) <= 0.7


@pytest.mark.parametrize(
    "code", ["SlowDown", "TooManyRequestsException", "LimitExceededException", "Throttling"]
)
def test_net_ignores_non_dynamodb_throttling_codes(code: str) -> None:
    @api_handler
    def handler(event: Any, context: Any) -> Any:
        raise ClientError({"Error": {"Code": code, "Message": "x"}}, "PutObject")

    assert handler({}, None)["statusCode"] == 500


def test_net_with_empty_error_is_500() -> None:
    @api_handler
    def handler(event: Any, context: Any) -> Any:
        raise ClientError({"Error": {}}, "GetItem")

    assert handler({}, None)["statusCode"] == 500
