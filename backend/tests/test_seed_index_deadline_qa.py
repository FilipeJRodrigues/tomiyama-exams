"""QA (#144, pending items of stage 3a): which FAILED reason the InitialData load gives.

Only a deadline met while the v2 migration waits for ``by_profile_belt`` gets
``INDEX_DEADLINE_REASON``; every other deadline (capacity on the load, a
transaction conflict that lasts, ``DescribeTable`` throttled to the end, the
marker write throttled) keeps ``DEADLINE_REASON``, and a missing index keeps
the generic failure. No case writes the v2 marker, and the next deploy ends
the migration. Also checks that ``fake_seed_time`` is undone with the
``monkeypatch`` that installed it.
"""

from types import SimpleNamespace
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import belt_id, fake_seed_time, throttle_dynamodb

from domain.requirement_profiles import MAIN_PROFILE_ID
from domain.requirements import seed_requirements
from handlers import seed
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV, SETTINGS_TABLE_ENV

V1_MARKER = requirement_repo.PROFILE_MIGRATION_MARKER_ID
V2_MARKER = requirement_repo.PROFILE_BELT_MIGRATION_MARKER_ID
# 900 s of Lambda: the deadline is 840 s ahead on the injected clock.
CONTEXT = SimpleNamespace(get_remaining_time_in_millis=lambda: 900_000)


def _event() -> dict[str, Any]:
    return {
        "RequestType": "Update",
        "ResponseURL": "https://example.invalid/r",
        "StackId": "s",
        "RequestId": "r",
        "LogicalResourceId": "InitialData",
        "PhysicalResourceId": "initial-data",
    }


def _settings_item(item_id: str) -> Any:
    return (
        tables.table(SETTINGS_TABLE_ENV)
        .get_item(Key={"id": item_id}, ConsistentRead=True)
        .get("Item")
    )


def _raw(requirement_id: str) -> dict[str, Any] | None:
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )


def _put_main_without_profile_belt(requirement_id: str) -> None:
    """An item v1 does not touch (it has ``profile_id``) and v2 must fix."""
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": requirement_id,
            "belt_id": belt_id("Cinza"),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": "Item sem profile_belt",
            "sort_order": 900,
            "profile_id": MAIN_PROFILE_ID,
        }
    )


def _index_status(monkeypatch: pytest.MonkeyPatch, statuses: list[str | None]) -> list[str]:
    """Make ``DescribeTable`` report these statuses of ``by_profile_belt``, then the real one."""
    original = BaseClient._make_api_call
    reported: list[str] = []

    def describe(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        response = original(self, operation_name, api_params)
        if operation_name != "DescribeTable" or not statuses:
            return response
        status = statuses.pop(0)
        indexes = response["Table"]["GlobalSecondaryIndexes"]
        if status is None:
            response["Table"]["GlobalSecondaryIndexes"] = [
                index for index in indexes if index["IndexName"] != "by_profile_belt"
            ]
        else:
            for index in indexes:
                if index["IndexName"] == "by_profile_belt":
                    index["IndexStatus"] = status
        reported.append(str(status))
        return response

    monkeypatch.setattr(BaseClient, "_make_api_call", describe)
    return reported


def _run(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(seed, "_send_response", lambda e, c, s, r: sent.append((s, r)))
    seed.handler(_event(), CONTEXT)
    return sent


def _next_deploy_ends_the_migration(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _run(monkeypatch) == [("SUCCESS", "OK")]
    assert _settings_item(V2_MARKER)


def test_rn017_qa_v2_conflict_until_the_deadline_keeps_the_capacity_message(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirement_repo.seed_requirements(seed_requirements())
    _put_main_without_profile_belt("drift")

    with monkeypatch.context() as patch:
        patch.setattr(tables.random, "uniform", lambda low, high: high)
        clock = fake_seed_time(patch)
        stub = throttle_dynamodb(
            patch,
            "UpdateItem",
            REQUIREMENTS_TABLE_ENV,
            code="TransactionConflictException",
            max_calls=10_000,
        )
        sent = _run(patch)

    assert sent == [("FAILED", seed.DEADLINE_REASON)]
    assert len(stub.calls) > 1 and len(clock.sleeps) > 1
    assert _settings_item(V1_MARKER)  # v1 ended: the conflict was in v2's fixes
    assert not _settings_item(V2_MARKER)
    assert "profile_belt" not in _raw("drift")
    _next_deploy_ends_the_migration(monkeypatch)
    assert _raw("drift")["profile_belt"] == f"{MAIN_PROFILE_ID}#{belt_id('Cinza')}"


def test_rn017_qa_capacity_on_the_load_keeps_the_capacity_message(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    with monkeypatch.context() as patch:
        patch.setattr(tables.random, "uniform", lambda low, high: high)
        fake_seed_time(patch)
        stub = throttle_dynamodb(patch, "PutItem", REQUIREMENTS_TABLE_ENV, max_calls=10_000)
        sent = _run(patch)

    assert sent == [("FAILED", seed.DEADLINE_REASON)]
    assert len(stub.calls) > 1
    assert not _settings_item(V2_MARKER)
    _next_deploy_ends_the_migration(monkeypatch)


def test_rn017_qa_missing_index_keeps_the_generic_failure(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirement_repo.seed_requirements(seed_requirements())

    with monkeypatch.context() as patch:
        _index_status(patch, [None])
        fake_seed_time(patch)
        sent = _run(patch)

    assert sent == [
        ("FAILED", "Falha na carga inicial: Index by_profile_belt not found on Requirements")
    ]
    assert not _settings_item(V2_MARKER)
    _next_deploy_ends_the_migration(monkeypatch)


def test_rn017_qa_index_updating_until_the_deadline_gets_the_index_message(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirement_repo.seed_requirements(seed_requirements())

    with monkeypatch.context() as patch:
        reported = _index_status(patch, ["UPDATING"] * 1_000)
        fake_seed_time(patch)
        sent = _run(patch)

    assert sent == [("FAILED", seed.INDEX_DEADLINE_REASON)]
    assert len(reported) > 1
    assert not _settings_item(V2_MARKER)


def test_rn017_qa_describe_throttled_then_index_building_gets_the_index_message(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A few throttled DescribeTable calls first, then the index is still being
    # built at the deadline: what stopped the load is the index.
    requirement_repo.seed_requirements(seed_requirements())
    throttled = [0]

    def first_three(_: dict[str, Any]) -> bool:
        throttled[0] += 1
        return throttled[0] <= 3

    with monkeypatch.context() as patch:
        patch.setattr(tables.random, "uniform", lambda low, high: high)
        reported = _index_status(patch, ["CREATING"] * 1_000)
        stub = throttle_dynamodb(
            patch, "DescribeTable", REQUIREMENTS_TABLE_ENV, matches=first_three, max_calls=3
        )
        fake_seed_time(patch)
        sent = _run(patch)

    assert len(stub.calls) == 3
    assert len(reported) > 1
    assert sent == [("FAILED", seed.INDEX_DEADLINE_REASON)]
    assert not _settings_item(V2_MARKER)


def test_rn017_qa_index_building_then_describe_throttled_to_the_deadline_gets_the_capacity_message(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Documented in the README: DescribeTable throttled to the end keeps the
    # capacity message, even after the index was seen CREATING.
    requirement_repo.seed_requirements(seed_requirements())
    seen = [0]

    def after_the_second(_: dict[str, Any]) -> bool:
        seen[0] += 1
        return seen[0] > 2

    with monkeypatch.context() as patch:
        patch.setattr(tables.random, "uniform", lambda low, high: high)
        reported = _index_status(patch, ["CREATING"] * 1_000)
        throttle_dynamodb(
            patch,
            "DescribeTable",
            REQUIREMENTS_TABLE_ENV,
            matches=after_the_second,
            max_calls=10_000,
        )
        fake_seed_time(patch)
        sent = _run(patch)

    assert reported == ["CREATING", "CREATING"]
    assert sent == [("FAILED", seed.DEADLINE_REASON)]
    assert not _settings_item(V2_MARKER)


def test_rn017_qa_marker_write_throttled_after_the_index_is_active_gets_the_capacity_message(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirement_repo.seed_requirements(seed_requirements())

    with monkeypatch.context() as patch:
        patch.setattr(tables.random, "uniform", lambda low, high: high)
        fake_seed_time(patch)
        stub = throttle_dynamodb(
            patch,
            "PutItem",
            SETTINGS_TABLE_ENV,
            matches=lambda params: params["Item"]["id"] == V2_MARKER,
            max_calls=10_000,
        )
        sent = _run(patch)

    assert sent == [("FAILED", seed.DEADLINE_REASON)]
    assert len(stub.calls) > 1
    assert not _settings_item(V2_MARKER)
    _next_deploy_ends_the_migration(monkeypatch)


def test_rn017_qa_fake_seed_time_is_undone_with_its_monkeypatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    originals = (
        tables.retry_throttled,
        requirement_repo.retry_throttled,
        requirement_repo.wait_for_profile_index,
        seed._deadline,
    )
    assert originals[0] is originals[1]

    with monkeypatch.context() as patch:
        fake_seed_time(patch)
        assert seed._deadline is not originals[3]

    assert (
        tables.retry_throttled,
        requirement_repo.retry_throttled,
        requirement_repo.wait_for_profile_index,
        seed._deadline,
    ) == originals
