"""Edge cases of the ``InitialData`` seed handler not covered by ``test_seed.py``.

Deadline on the marker write, a non-throttling error midway, Update with the
marker already present, slow attempts against the deadline, and the body sent
to CloudFormation.
"""

from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError

from domain.requirements import seed_requirements
from handlers import seed
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import (
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    DeadlineExceededError,
    put_if_absent,
)


def _error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "PutItem")


def _event(request_type: str) -> dict[str, Any]:
    return {
        "RequestType": request_type,
        "ResponseURL": "https://example.invalid/response",
        "StackId": "stack",
        "RequestId": "request",
        "LogicalResourceId": "InitialData",
        "PhysicalResourceId": "initial-data",
    }


def _context(ms: int) -> SimpleNamespace:
    return SimpleNamespace(get_remaining_time_in_millis=lambda: ms)


@pytest.fixture
def responses(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(seed, "_send_response", lambda e, c, s, r: sent.append((s, r)))
    return sent


def _marker() -> Any:
    settings = tables.table(SETTINGS_TABLE_ENV)
    return settings.get_item(Key={"id": requirement_repo.SEED_MARKER_ID}).get("Item")


def test_deadline_on_the_marker_write_then_resume(
    aws: None, responses: list[tuple[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    real_put = requirement_repo.put_if_absent

    def put(target: Any, item: dict[str, Any], *, deadline: float | None = None) -> bool:
        if item["id"] == requirement_repo.SEED_MARKER_ID:
            raise DeadlineExceededError("marker")
        return real_put(target, item, deadline=deadline)

    monkeypatch.setattr(requirement_repo, "put_if_absent", put)
    seed.handler(_event("Create"), _context(900_000))
    assert responses == [("FAILED", seed.DEADLINE_REASON)]
    assert len(requirement_repo.list_all()) == 692
    assert not _marker()

    monkeypatch.setattr(requirement_repo, "put_if_absent", real_put)
    seed.handler(_event("Update"), _context(900_000))
    assert responses[-1] == ("SUCCESS", "OK")
    assert _marker()
    assert len(requirement_repo.list_all()) == 692


def test_non_throttling_error_midway_answers_failed_and_resumes(
    aws: None, responses: list[tuple[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    real_table = requirement_repo.table
    calls = {"n": 0}

    class Breaking:
        def __init__(self, inner: Any) -> None:
            self.inner = inner

        def put_item(self, **kwargs: Any) -> Any:
            calls["n"] += 1
            if calls["n"] == 300:
                raise _error("ValidationException")
            return self.inner.put_item(**kwargs)

        def __getattr__(self, name: str) -> Any:
            return getattr(self.inner, name)

    def fake_table(env: str) -> Any:
        inner = real_table(env)
        return Breaking(inner) if env == REQUIREMENTS_TABLE_ENV else inner

    monkeypatch.setattr(requirement_repo, "table", fake_table)
    seed.handler(_event("Create"), _context(900_000))
    assert responses == [
        ("FAILED", "Falha na carga inicial: " + str(_error("ValidationException")))
    ]
    assert len(requirement_repo.list_all()) == 299
    assert not _marker()

    monkeypatch.setattr(requirement_repo, "table", real_table)
    seed.handler(_event("Update"), _context(900_000))
    assert responses[-1] == ("SUCCESS", "OK")
    assert len(requirement_repo.list_all()) == 692
    assert _marker()


def test_delete_with_no_time_left_still_succeeds(
    aws: None, responses: list[tuple[str, str]]
) -> None:
    seed.handler(_event("Delete"), _context(1))
    assert responses == [("SUCCESS", "OK")]


def test_update_with_marker_keeps_deleted_items_out(
    aws: None, responses: list[tuple[str, str]]
) -> None:
    seed.handler(_event("Create"), _context(900_000))
    first = seed_requirements()[0].id
    requirement_repo.delete_requirement(first)
    seed.handler(_event("Update"), _context(900_000))
    assert responses == [("SUCCESS", "OK"), ("SUCCESS", "OK")]
    assert requirement_repo.get_requirement(first) is None


def test_backoff_never_sleeps_past_the_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: high)
    now = [0.0]
    ends: list[float] = []

    def sleep(seconds: float) -> None:
        now[0] += seconds
        ends.append(now[0])

    class Target:
        def put_item(self, **kwargs: Any) -> Any:
            now[0] += 25.0  # botocore internal retries inside one attempt
            raise _error("ProvisionedThroughputExceededException")

    with pytest.raises(DeadlineExceededError):
        put_if_absent(Target(), {"id": "x"}, deadline=100.0, sleep=sleep, clock=lambda: now[0])
    assert all(end < 100.0 for end in ends)
    # The last attempt started before the deadline; it may run at most one attempt past it.
    assert now[0] < 100.0 + 25.0


def test_failed_response_body_reaches_cloudformation(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json
    import urllib.request

    sent: list[Any] = []

    class Response:
        status = 200

        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

    def urlopen(request: Any, timeout: float) -> Response:
        sent.append((request.get_method(), json.loads(request.data), timeout))
        return Response()

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    event = _event("Create")
    del event["PhysicalResourceId"]
    seed.handler(event, _context(1))

    method, body, timeout = sent[0]
    assert method == "PUT"
    assert body["Status"] == "FAILED"
    assert body["Reason"] == seed.DEADLINE_REASON
    assert body["PhysicalResourceId"] == "initial-data"
    assert len(json.dumps(body).encode()) < 4096
