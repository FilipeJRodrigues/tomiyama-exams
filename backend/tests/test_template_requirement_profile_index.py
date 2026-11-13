"""Template of step 3a of #144 (RN017): every profile read through ``by_profile_belt``.

- ``InitialData`` runs the v2 migration on the next deploy (``SeedVersion``
  "4") and only after the functions that write requirements run the new code;
- only the functions that read a profile's items read the v2 marker in
  ``Settings``, with ``GetItem`` on that item only;
- the read capacity of ``by_belt`` moved to ``by_profile_belt`` (dev free tier,
  still 25/25).
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

from repository.requirements import PROFILE_BELT_MIGRATION_MARKER_ID

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
SETTINGS_ARN = {"Fn::GetAtt": ["SettingsTable", "Arn"]}
# Every function whose code reads a profile's items in a belt (the exam
# sheet and the score after a mark or unmark, the list, the default order
# of a new item and the copy).
MARKER_READERS = {
    "GetExamSheetFunction",
    "MarkAnswerFunction",
    "UnmarkAnswerFunction",
    "ListRequirementsFunction",
    "CreateRequirementFunction",
    "CopyRequirementProfileFunction",
}


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


def _statements(properties: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        statement
        for policy in properties.get("Policies", [])
        if isinstance(policy, dict)
        for statement in policy.get("Statement", [])
    ]


def test_rn017_next_deploy_runs_the_v2_migration(template: dict[str, Any]) -> None:
    initial_data = template["Resources"]["InitialData"]

    assert initial_data["Properties"]["SeedVersion"] == "4"
    assert initial_data["Properties"]["ServiceToken"] == {"Fn::GetAtt": ["SeedFunction", "Arn"]}


def test_rn017_migrations_wait_for_the_requirement_writers_to_run_the_new_code(
    template: dict[str, Any],
) -> None:
    # Code from before profiles creates items without profile_belt and moves
    # items without updating it; once these two functions are updated, nothing
    # writes requirements that way after the v2 migration checked them.
    assert template["Resources"]["InitialData"]["DependsOn"] == [
        "CreateRequirementFunction",
        "UpdateRequirementFunction",
    ]


def test_rn017_only_the_readers_of_profile_items_read_the_v2_marker(
    template: dict[str, Any],
) -> None:
    readers = set()
    for name, resource in template["Resources"].items():
        if resource["Type"] != "AWS::Serverless::Function":
            continue
        for statement in _statements(resource["Properties"]):
            condition = statement.get("Condition", {})
            keys = condition.get("ForAllValues:StringEquals", {}).get("dynamodb:LeadingKeys", [])
            if PROFILE_BELT_MIGRATION_MARKER_ID not in keys:
                continue
            readers.add(name)
            # Read only (never written by a route), only in Settings.
            assert statement["Action"] == "dynamodb:GetItem", name
            assert statement["Resource"] == SETTINGS_ARN, name

    assert readers == MARKER_READERS


def test_rn017_dev_read_capacity_moves_from_by_belt_to_by_profile_belt(
    template: dict[str, Any],
) -> None:
    capacity = template["Mappings"]["DevCapacity"]

    assert capacity["RequirementsByBelt"] == {"Read": 1, "Write": 4}
    assert capacity["RequirementsByProfileBelt"] == {"Read": 5, "Write": 4}
    # by_belt is still written until it is dropped (step 3c): same WCU.
    assert sum(units["Read"] for units in capacity.values()) == 25
    assert sum(units["Write"] for units in capacity.values()) == 25
