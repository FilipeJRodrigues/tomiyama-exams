"""QA (#144 retest): conflict retry stays out of HTTP; skipped migration items stay usable."""

from types import SimpleNamespace
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    MASTER,
    api_event,
    before_dynamodb_call,
    belt_id,
    response_json,
    throttle_dynamodb,
)

from domain.requirement_profiles import MAIN_PROFILE_ID, MSG_MAIN_PROFILE_MASTER_ONLY
from domain.requirements import seed_requirements
from handlers import requirements as handlers
from handlers import seed
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV, SETTINGS_TABLE_ENV

LEGACY = "legacy-qa"


def _put_legacy() -> None:
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": LEGACY,
            "belt_id": belt_id("Cinza"),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": "Item antigo",
            "sort_order": 50,
            "answer_count": 1,
        }
    )


def _raw() -> dict[str, Any]:
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": LEGACY}, ConsistentRead=True)
        .get("Item")
    )


def _marker() -> Any:
    return (
        tables.table(SETTINGS_TABLE_ENV)
        .get_item(Key={"id": requirement_repo.PROFILE_MIGRATION_MARKER_ID}, ConsistentRead=True)
        .get("Item")
    )


def _body(**changes: Any) -> dict[str, Any]:
    data = {
        "belt_id": belt_id("Cinza"),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Editado",
        "sort_order": 50,
    }
    data.update(changes)
    return data


@pytest.mark.parametrize(
    ("code", "status"),
    [("TransactionConflictException", 500), ("ProvisionedThroughputExceededException", 503)],
)
def test_rn017_route_write_is_not_retried_on_conflict_and_throttling_is_still_503(
    seeded: list, monkeypatch: pytest.MonkeyPatch, code: str, status: int
) -> None:
    _put_legacy()
    stub = throttle_dynamodb(
        monkeypatch, ["UpdateItem", "PutItem"], REQUIREMENTS_TABLE_ENV, code=code
    )

    response = handlers.update_requirement(
        api_event(MASTER, path={"id": LEGACY}, body=_body()), None
    )

    assert response["statusCode"] == status, response.get("body")
    assert len(stub.calls) == 1  # no retry loop in the route
    assert "profile_id" not in _raw()


def test_rn017_handler_failed_in_pt_br_when_conflict_outlasts_the_deadline(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirement_repo.seed_requirements(seed_requirements())
    _put_legacy()
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: 0.05)
    stub = throttle_dynamodb(
        monkeypatch,
        "UpdateItem",
        REQUIREMENTS_TABLE_ENV,
        code="TransactionConflictException",
        max_calls=10_000,
    )
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(seed, "_send_response", lambda e, c, s, r: sent.append((s, r)))
    event = {
        "RequestType": "Update",
        "ResponseURL": "https://example.invalid/r",
        "StackId": "s",
        "RequestId": "r",
        "LogicalResourceId": "InitialData",
        "PhysicalResourceId": "initial-data",
    }

    seed.handler(event, SimpleNamespace(get_remaining_time_in_millis=lambda: 61_000))

    assert sent == [("FAILED", seed.DEADLINE_REASON)]
    assert len(stub.calls) > 1
    assert "profile_id" not in _raw()
    assert not _marker()


def test_rn017_item_skipped_by_belt_condition_stays_listed_and_master_only(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_legacy()

    def move_belt() -> None:
        tables.table(REQUIREMENTS_TABLE_ENV).update_item(
            Key={"id": LEGACY},
            UpdateExpression="SET belt_id = :b",
            ExpressionAttributeValues={":b": belt_id("Azul")},
        )

    triggered = before_dynamodb_call(monkeypatch, "UpdateItem", REQUIREMENTS_TABLE_ENV, move_belt)

    assert requirement_repo.migrate_to_main_profile() == 0
    assert triggered
    assert _marker()
    assert "profile_id" not in _raw()

    listed = handlers.list_requirements(
        api_event(EXAMINER, query={"belt_id": belt_id("Azul")}), None
    )
    assert listed["statusCode"] == 200
    items = {item["id"]: item for item in response_json(listed)}
    assert items[LEGACY]["profile_id"] == MAIN_PROFILE_ID
    old_belt = handlers.list_requirements(
        api_event(EXAMINER, query={"belt_id": belt_id("Cinza")}), None
    )
    assert LEGACY not in {item["id"] for item in response_json(old_belt)}

    denied = handlers.update_requirement(
        api_event(EXAMINER, path={"id": LEGACY}, body=_body(belt_id=belt_id("Azul"))), None
    )
    assert denied["statusCode"] == 403
    assert response_json(denied) == {"message": MSG_MAIN_PROFILE_MASTER_ONLY}

    edited = handlers.update_requirement(
        api_event(MASTER, path={"id": LEGACY}, body=_body(belt_id=belt_id("Azul"))), None
    )
    assert edited["statusCode"] == 200, edited.get("body")
    assert _raw()["profile_belt"] == f"main#{belt_id('Azul')}"
