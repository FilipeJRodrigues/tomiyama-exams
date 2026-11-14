"""Template of step 3c of #144 (RN017): ``Requirements`` without the old ``by_belt`` index.

- ``by_profile_belt`` is the only GSI, and ``belt_id`` left the
  ``AttributeDefinitions`` (CloudFormation refuses an attribute no key uses);
- no function reaches ``index/by_belt`` any more; the fallback of the main
  profile before the v2 marker is a ``Scan`` of ``Requirements``, granted only
  to the functions whose code may run it and that had no ``Scan`` there;
- the dev capacity of ``by_belt`` (1 RCU, 4 WCU) is gone: Students,
  StudentsByOwner and Answers get back the WCU they lent in step 1, and one
  RCU and one WCU are spare (24/24).
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
REQUIREMENTS_ARN = {"Fn::GetAtt": ["RequirementsTable", "Arn"]}
# Functions that run the fallback of the main profile with explicit statements
# (the sheet and the score, the copy of a main source). The list and the
# creation of requirements run it too, under SAM policies that already allow
# Scan (DynamoDBReadPolicy, DynamoDBCrudPolicy).
FALLBACK_SCANNERS = {
    "GetExamSheetFunction",
    "MarkAnswerFunction",
    "UnmarkAnswerFunction",
    "CopyRequirementProfileFunction",
}
ANSWER_ROUTES = ["GetExamSheetFunction", "MarkAnswerFunction", "UnmarkAnswerFunction"]
DEV_CAPACITY_3C = {
    "Belts": {"Read": 2, "Write": 1},
    "Students": {"Read": 3, "Write": 2},
    "StudentsByOwner": {"Read": 2, "Write": 2},
    "Exams": {"Read": 2, "Write": 3},
    "ExamsByStudent": {"Read": 1, "Write": 1},
    "Requirements": {"Read": 3, "Write": 4},
    "RequirementsByProfileBelt": {"Read": 5, "Write": 4},
    "Settings": {"Read": 1, "Write": 1},
    "Events": {"Read": 2, "Write": 3},
    "Answers": {"Read": 3, "Write": 3},
}


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


def _requirements_table(template: dict[str, Any]) -> dict[str, Any]:
    return template["Resources"]["RequirementsTable"]["Properties"]


def _functions(template: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        name: resource["Properties"]
        for name, resource in template["Resources"].items()
        if resource["Type"] == "AWS::Serverless::Function"
    }


def _statements(properties: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        statement
        for policy in properties.get("Policies", [])
        if isinstance(policy, dict)
        for statement in policy.get("Statement", [])
    ]


def _actions(statement: dict[str, Any]) -> list[str]:
    actions = statement["Action"]
    return [actions] if isinstance(actions, str) else list(actions)


def _resources(statement: dict[str, Any]) -> list[Any]:
    resources = statement["Resource"]
    return resources if isinstance(resources, list) else [resources]


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _strings(item)]
    if isinstance(value, list):
        return [text for item in value for text in _strings(item)]
    return []


def test_rn017_requirements_has_only_the_profile_index(template: dict[str, Any]) -> None:
    table = _requirements_table(template)

    assert [index["IndexName"] for index in table["GlobalSecondaryIndexes"]] == ["by_profile_belt"]
    # Only the attributes some key uses: belt_id left with by_belt.
    definitions = {
        item["AttributeName"]: item["AttributeType"] for item in table["AttributeDefinitions"]
    }
    assert definitions == {"id": "S", "sort_order": "N", "profile_belt": "S"}
    keys = {part["AttributeName"] for part in table["KeySchema"]} | {
        part["AttributeName"]
        for index in table["GlobalSecondaryIndexes"]
        for part in index["KeySchema"]
    }
    assert keys == set(definitions)


def test_rn006_the_only_index_does_not_project_the_answer_counter(
    template: dict[str, Any],
) -> None:
    # The first mark of an item (RN006) changes only answer_count: with no
    # GSI projecting it, that write reaches no index.
    for index in _requirements_table(template)["GlobalSecondaryIndexes"]:
        assert index["Projection"]["ProjectionType"] == "INCLUDE", index["IndexName"]
        assert "answer_count" not in index["Projection"]["NonKeyAttributes"], index["IndexName"]


def test_rn017_no_function_reaches_by_belt(template: dict[str, Any]) -> None:
    for name, properties in _functions(template).items():
        for statement in _statements(properties):
            for resource in _resources(statement):
                assert "by_belt" not in str(resource), (name, statement)
    # Nor any other reference anywhere in the template (comments are not parsed).
    assert not [text for text in _strings(template) if "index/by_belt" in text]
    assert "RequirementsByBelt" not in template["Mappings"]["DevCapacity"]


def test_rn017_only_the_fallback_functions_get_a_scan_of_requirements(
    template: dict[str, Any],
) -> None:
    scanners = {
        name
        for name, properties in _functions(template).items()
        for statement in _statements(properties)
        if "dynamodb:Scan" in _actions(statement) and REQUIREMENTS_ARN in _resources(statement)
    }

    assert scanners == FALLBACK_SCANNERS
    # The background deletion never reads the main profile: no Scan.
    assert "DeleteRequirementProfileItemsFunction" not in scanners


@pytest.mark.parametrize("name", ANSWER_ROUTES)
def test_rn017_answer_routes_scan_only_requirements_for_the_fallback(
    template: dict[str, Any], name: str
) -> None:
    # The Scan replaces the Query on by_belt (projection ALL: the same items
    # were reachable) and runs only before the v2 marker (see
    # test_requirement_profile_index_without_by_belt.py: after it, no route
    # scans). Never a Scan of another table, a batch write or a wildcard.
    properties = _functions(template)[name]
    scans = [
        resource
        for statement in _statements(properties)
        if "dynamodb:Scan" in _actions(statement)
        for resource in _resources(statement)
    ]
    actions = {action for statement in _statements(properties) for action in _actions(statement)}

    assert scans == [REQUIREMENTS_ARN]
    assert all("Statement" in policy for policy in properties["Policies"])
    assert not actions & {"dynamodb:BatchWriteItem", "dynamodb:*"}


def test_rn017_dev_capacity_after_dropping_by_belt(template: dict[str, Any]) -> None:
    capacity = template["Mappings"]["DevCapacity"]

    assert capacity == DEV_CAPACITY_3C
    # One spare unit of each, as before step 1 of #144.
    assert sum(units["Read"] for units in capacity.values()) == 24
    assert sum(units["Write"] for units in capacity.values()) == 24
