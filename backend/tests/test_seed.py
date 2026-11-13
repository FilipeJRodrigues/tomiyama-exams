"""Initial-data load (custom resource ``InitialData``) under low provisioned capacity.

In dev the tables use a few provisioned WCU (free tier), so the 692 writes of
Appendix A are throttled. The load must retry with backoff, stay idempotent,
stop before the Lambda timeout and always answer CloudFormation.
"""

from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError

from domain.belts import SEED_BELTS
from domain.requirements import seed_requirements
from handlers import seed
from repository import belts as belt_repo
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import (
    BELTS_TABLE_ENV,
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    DeadlineExceededError,
    put_if_absent,
)


def _error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "PutItem")


class ThrottlingTable:
    """Wraps a moto table and throttles every ``every``-th write (moto never throttles)."""

    def __init__(self, inner: Any, every: int = 2) -> None:
        self.inner = inner
        self.every = every
        self.calls = 0
        self.throttled = 0

    def put_item(self, **kwargs: Any) -> Any:
        self.calls += 1
        if self.calls % self.every == 1:
            self.throttled += 1
            raise _error("ProvisionedThroughputExceededException")
        return self.inner.put_item(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the jittered delay zero so retry loops run instantly."""
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: 0.0)


@pytest.fixture
def throttled(monkeypatch: pytest.MonkeyPatch, aws: None, no_backoff: None) -> dict[str, Any]:
    """Every table used by the seed throttles half of its writes."""
    wrappers: dict[str, ThrottlingTable] = {}

    def fake_table(env_var: str) -> ThrottlingTable:
        if env_var not in wrappers:
            wrappers[env_var] = ThrottlingTable(tables.table(env_var))
        return wrappers[env_var]

    monkeypatch.setattr(belt_repo, "table", fake_table)
    monkeypatch.setattr(requirement_repo, "table", fake_table)
    return wrappers


def _cfn_event(request_type: str = "Create") -> dict[str, Any]:
    return {
        "RequestType": request_type,
        "ResponseURL": "https://example.invalid/response",
        "StackId": "stack",
        "RequestId": "request",
        "LogicalResourceId": "InitialData",
    }


def _context(remaining_ms: int) -> SimpleNamespace:
    return SimpleNamespace(get_remaining_time_in_millis=lambda: remaining_ms)


@pytest.fixture
def responses(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Capture the answers sent to CloudFormation instead of calling the ResponseURL."""
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(
        seed, "_send_response", lambda event, context, status, reason: sent.append((status, reason))
    )
    return sent


# --- put_if_absent ----------------------------------------------------------


def test_put_if_absent_retries_throttling_with_growing_capped_backoff(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    inner = tables.table(SETTINGS_TABLE_ENV)
    failures = iter([True] * 8)

    class Target:
        def put_item(self, **kwargs: Any) -> Any:
            if next(failures, False):
                raise _error("ProvisionedThroughputExceededException")
            return inner.put_item(**kwargs)

    upper_bounds: list[float] = []

    def uniform(low: float, high: float) -> float:
        upper_bounds.append(high)
        return high

    monkeypatch.setattr(tables.random, "uniform", uniform)
    clock = FakeClock()
    assert put_if_absent(Target(), {"id": "x"}, sleep=clock.sleep, clock=clock) is True

    assert inner.get_item(Key={"id": "x"})["Item"] == {"id": "x"}
    assert len(clock.sleeps) == 8
    assert upper_bounds == [0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 5.0, 5.0]


def test_put_if_absent_never_overwrites(aws: None) -> None:
    target = tables.table(SETTINGS_TABLE_ENV)
    target.put_item(Item={"id": "x", "edited": True})

    assert put_if_absent(target, {"id": "x"}) is False
    assert target.get_item(Key={"id": "x"})["Item"] == {"id": "x", "edited": True}


@pytest.mark.parametrize("code", ["ThrottlingException", "RequestLimitExceeded"])
def test_put_if_absent_retries_every_throttling_code(
    aws: None, no_backoff: None, code: str
) -> None:
    inner = tables.table(SETTINGS_TABLE_ENV)
    failures = iter([True])

    class Target:
        def put_item(self, **kwargs: Any) -> Any:
            if next(failures, False):
                raise _error(code)
            return inner.put_item(**kwargs)

    assert put_if_absent(Target(), {"id": "x"}) is True


def test_put_if_absent_retries_a_transaction_conflict(aws: None, no_backoff: None) -> None:
    # The item is held by a transaction in progress; the conflict ends with it.
    inner = tables.table(SETTINGS_TABLE_ENV)
    failures = iter([True, True])

    class Target:
        def put_item(self, **kwargs: Any) -> Any:
            if next(failures, False):
                raise _error("TransactionConflictException")
            return inner.put_item(**kwargs)

    assert put_if_absent(Target(), {"id": "x"}) is True
    assert inner.get_item(Key={"id": "x"})["Item"] == {"id": "x"}


def test_put_if_absent_raises_other_errors_at_once() -> None:
    calls = []

    class Target:
        def put_item(self, **kwargs: Any) -> Any:
            calls.append(kwargs)
            raise _error("ValidationException")

    with pytest.raises(ClientError):
        put_if_absent(Target(), {"id": "x"})
    assert len(calls) == 1


def test_put_if_absent_stops_at_the_deadline() -> None:
    class Target:
        def put_item(self, **kwargs: Any) -> Any:
            raise _error("ProvisionedThroughputExceededException")

    clock = FakeClock()
    with pytest.raises(DeadlineExceededError):
        put_if_absent(Target(), {"id": "x"}, deadline=10.0, sleep=clock.sleep, clock=clock)
    assert clock.now < 10.0


# --- seed under throttling --------------------------------------------------


def test_seed_completes_when_half_the_writes_are_throttled(throttled: dict[str, Any]) -> None:
    assert seed.seed_all() == {
        "belts": len(SEED_BELTS),
        "requirements": 692,
        "requirement_profiles": 0,
    }

    assert throttled[REQUIREMENTS_TABLE_ENV].throttled >= 692
    assert throttled[BELTS_TABLE_ENV].throttled >= len(SEED_BELTS)
    assert len(requirement_repo.list_all()) == 692
    assert len(belt_repo.list_belts()) == len(SEED_BELTS)
    settings = tables.table(SETTINGS_TABLE_ENV)
    assert settings.get_item(Key={"id": requirement_repo.SEED_MARKER_ID}).get("Item")


def test_seed_under_throttling_stays_idempotent(throttled: dict[str, Any]) -> None:
    items = seed_requirements()
    seed.seed_all()
    requirement_repo.delete_requirement(items[0].id)

    assert seed.seed_all() == {"belts": 0, "requirements": 0, "requirement_profiles": 0}
    assert requirement_repo.get_requirement(items[0].id) is None


def test_seed_stopped_by_deadline_resumes_without_marker(
    throttled: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    # Each clock reading advances one "second": the deadline hits midway.
    ticks = iter(range(10_000))
    real_put = requirement_repo.put_if_absent

    def ticking_put(target: Any, item: dict[str, Any], *, deadline: float | None = None) -> bool:
        return real_put(target, item, deadline=deadline, clock=lambda: next(ticks))

    monkeypatch.setattr(requirement_repo, "put_if_absent", ticking_put)
    with pytest.raises(DeadlineExceededError):
        requirement_repo.seed_requirements(seed_requirements(), deadline=100)
    monkeypatch.setattr(requirement_repo, "put_if_absent", real_put)

    settings = tables.table(SETTINGS_TABLE_ENV)
    assert not settings.get_item(Key={"id": requirement_repo.SEED_MARKER_ID}).get("Item")
    partial = len(requirement_repo.list_all())
    assert 0 < partial < 692

    assert requirement_repo.seed_requirements(seed_requirements()) == 692 - partial
    assert settings.get_item(Key={"id": requirement_repo.SEED_MARKER_ID}).get("Item")


# --- CloudFormation response ------------------------------------------------


def test_handler_create_seeds_and_answers_success(
    aws: None, responses: list[tuple[str, str]]
) -> None:
    seed.handler(_cfn_event("Create"), _context(900_000))

    assert responses == [("SUCCESS", "OK")]
    assert len(requirement_repo.list_all()) == 692


def test_handler_delete_answers_success_without_seeding(
    aws: None, responses: list[tuple[str, str]]
) -> None:
    seed.handler(_cfn_event("Delete"), _context(900_000))

    assert responses == [("SUCCESS", "OK")]
    assert belt_repo.list_belts() == []


def test_handler_answers_failed_before_the_lambda_timeout(
    aws: None, responses: list[tuple[str, str]]
) -> None:
    # Less time left than the safety margin: the load stops at once.
    seed.handler(_cfn_event("Create"), _context(seed.SAFETY_MARGIN_SECONDS * 1000 - 1))

    assert responses == [("FAILED", seed.DEADLINE_REASON)]
    settings = tables.table(SETTINGS_TABLE_ENV)
    assert not settings.get_item(Key={"id": requirement_repo.SEED_MARKER_ID}).get("Item")


def test_handler_answers_failed_on_any_error(
    aws: None, responses: list[tuple[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(deadline: float | None = None) -> dict[str, int]:
        raise RuntimeError("tabela inexistente")

    monkeypatch.setattr(seed, "seed_all", boom)
    seed.handler(_cfn_event("Update"), _context(900_000))

    assert responses == [("FAILED", "Falha na carga inicial: tabela inexistente")]
