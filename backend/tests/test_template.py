"""Free-tier guard for ``infra/template.yaml``.

In dev every table and GSI is PROVISIONED, and the sum over all of them must
stay within the permanent free tier (25 RCU and 25 WCU per account and Region).
In prod they go back to PAY_PER_REQUEST with PITR, as the architecture asks.
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
FREE_TIER_UNITS = 25
NO_VALUE = {"Ref": "AWS::NoValue"}


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


def _tables(template: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        name: resource["Properties"]
        for name, resource in template["Resources"].items()
        if resource["Type"] == "AWS::DynamoDB::Table"
    }


def _dev_capacity(template: dict[str, Any], throughput: Any) -> tuple[int, int]:
    """Resolve ``!If [IsProd, NoValue, {Read..., Write...}]`` to the dev numbers."""
    condition, prod, dev = throughput["Fn::If"]
    assert condition == "IsProd"
    assert prod == NO_VALUE
    mapping = template["Mappings"]
    units = []
    for field in ("ReadCapacityUnits", "WriteCapacityUnits"):
        map_name, key, attribute = dev[field]["Fn::FindInMap"]
        units.append(int(mapping[map_name][key][attribute]))
    return units[0], units[1]


def _capacities(template: dict[str, Any]) -> dict[str, tuple[int, int]]:
    capacities: dict[str, tuple[int, int]] = {}
    for name, properties in _tables(template).items():
        capacities[name] = _dev_capacity(template, properties["ProvisionedThroughput"])
        for index in properties.get("GlobalSecondaryIndexes", []):
            capacities[f"{name}.{index['IndexName']}"] = _dev_capacity(
                template, index["ProvisionedThroughput"]
            )
    return capacities


def test_every_table_and_gsi_is_provisioned_in_dev(template: dict[str, Any]) -> None:
    capacities = _capacities(template)

    assert len(capacities) == 9  # 6 tables + 3 GSIs
    assert all(read >= 1 and write >= 1 for read, write in capacities.values())
    for properties in _tables(template).values():
        assert properties["BillingMode"] == {"Fn::If": ["IsProd", "PAY_PER_REQUEST", "PROVISIONED"]}


def test_dev_capacity_fits_the_free_tier(template: dict[str, Any]) -> None:
    capacities = _capacities(template)

    assert sum(read for read, _ in capacities.values()) <= FREE_TIER_UNITS
    assert sum(write for _, write in capacities.values()) <= FREE_TIER_UNITS


def test_seed_table_and_gsi_get_the_most_write_capacity(template: dict[str, Any]) -> None:
    capacities = _capacities(template)
    seed_writes = min(
        capacities["RequirementsTable"][1], capacities["RequirementsTable.by_belt"][1]
    )

    others = [
        write for name, (_, write) in capacities.items() if not name.startswith("Requirements")
    ]
    assert seed_writes > max(others)


def test_pitr_only_in_prod(template: dict[str, Any]) -> None:
    for properties in _tables(template).values():
        assert properties["PointInTimeRecoverySpecification"] == {
            "PointInTimeRecoveryEnabled": {"Fn::If": ["IsProd", True, False]}
        }


def test_environment_parameter_defaults_to_dev(template: dict[str, Any]) -> None:
    environment = template["Parameters"]["Environment"]

    assert environment["Default"] == "dev"
    assert environment["AllowedValues"] == ["dev", "prod"]
    assert template["Conditions"]["IsProd"] == {"Fn::Equals": [{"Ref": "Environment"}, "prod"]}


def test_budget_alert_defaults_to_one_dollar(template: dict[str, Any]) -> None:
    assert template["Parameters"]["BudgetLimitUsd"]["Default"] == 1
    budget = template["Resources"]["MonthlyBudget"]["Properties"]
    for notification in budget["NotificationsWithSubscribers"]:
        assert notification["Subscribers"] == [
            {"SubscriptionType": "EMAIL", "Address": {"Ref": "AdminEmail"}}
        ]


def test_function_logs_have_short_retention_in_dev(template: dict[str, Any]) -> None:
    assert template["Globals"]["Function"]["LoggingConfig"] == {
        "LogGroup": {"Ref": "FunctionsLogGroup"}
    }
    log_group = template["Resources"]["FunctionsLogGroup"]["Properties"]
    assert log_group["RetentionInDays"] == {
        "Fn::FindInMap": ["EnvConfig", {"Ref": "Environment"}, "LogRetentionDays"]
    }
    assert template["Mappings"]["EnvConfig"]["dev"]["LogRetentionDays"] == 7


def test_seed_function_outlives_the_throttled_load(template: dict[str, Any]) -> None:
    timeout = template["Resources"]["SeedFunction"]["Properties"]["Timeout"]
    service_timeout = template["Resources"]["InitialData"]["Properties"]["ServiceTimeout"]
    capacities = _capacities(template)
    # Each item writes the table and the GSI: the slower of the two sets the pace.
    seed_writes = min(
        capacities["RequirementsTable"][1], capacities["RequirementsTable.by_belt"][1]
    )
    expected_seconds = 692 / seed_writes

    assert timeout >= 4 * expected_seconds
    assert service_timeout > timeout


def _resolve_if(value: Any, *, is_prod: bool) -> Any:
    """Resolve ``!If [IsProd, prod, dev]`` the way LanguageExtensions does."""
    condition, prod, dev = value["Fn::If"]
    assert condition == "IsProd"
    return prod if is_prod else dev


def test_language_extensions_runs_before_sam(template: dict[str, Any]) -> None:
    # !If in DeletionPolicy needs LanguageExtensions, which must precede SAM.
    assert template["Transform"] == ["AWS::LanguageExtensions", "AWS::Serverless-2016-10-31"]


@pytest.mark.parametrize(("environment", "expected"), [("dev", "Delete"), ("prod", "Retain")])
def test_tables_are_deleted_in_dev_and_retained_in_prod(
    template: dict[str, Any], environment: str, expected: str
) -> None:
    tables = {
        name: resource
        for name, resource in template["Resources"].items()
        if resource["Type"] == "AWS::DynamoDB::Table"
    }

    assert len(tables) == 6
    for name, resource in tables.items():
        for policy in ("DeletionPolicy", "UpdateReplacePolicy"):
            resolved = _resolve_if(resource[policy], is_prod=environment == "prod")
            assert resolved == expected, (name, policy)
