"""Template of the requirement profiles, step 1 of #144 (RN017).

``Requirements`` gains the GSI ``by_profile_belt`` (items of one profile in a
belt, in sheet order) and keeps ``by_belt`` until the exam sheet moves to the
new index: CloudFormation creates or deletes only one GSI per table update.
"""

import dataclasses
from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode
from conftest import REQUIREMENT_PROFILE_BELT_ATTRIBUTES

from domain.requirements import Requirement
from repository import requirements as requirement_repo

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
REQUIREMENTS_ARN = {"Fn::GetAtt": ["RequirementsTable", "Arn"]}


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


def _requirements_table(template: dict[str, Any]) -> dict[str, Any]:
    return template["Resources"]["RequirementsTable"]["Properties"]


def _index(template: dict[str, Any], name: str) -> dict[str, Any]:
    indexes = _requirements_table(template)["GlobalSecondaryIndexes"]
    return next(index for index in indexes if index["IndexName"] == name)


def test_rn017_profile_belt_index_lists_a_profile_belt_in_sheet_order(
    template: dict[str, Any],
) -> None:
    index = _index(template, "by_profile_belt")
    definitions = {
        item["AttributeName"]: item["AttributeType"]
        for item in _requirements_table(template)["AttributeDefinitions"]
    }

    assert index["KeySchema"] == [
        {"AttributeName": "profile_belt", "KeyType": "HASH"},
        {"AttributeName": "sort_order", "KeyType": "RANGE"},
    ]
    assert definitions["profile_belt"] == "S"
    assert definitions["sort_order"] == "N"


def test_rn017_profile_belt_index_projects_the_model_but_not_answer_count(
    template: dict[str, Any],
) -> None:
    projection = _index(template, "by_profile_belt")["Projection"]
    model_fields = {field.name for field in dataclasses.fields(Requirement)}

    assert projection["ProjectionType"] == "INCLUDE"
    # Keys (id, sort_order, profile_belt) are always projected; every other
    # field of the model must be listed, or a read from the index would miss it.
    assert set(projection["NonKeyAttributes"]) == model_fields - {"id", "sort_order"}
    # The answers counter changes on every first mark (RN006): not projected,
    # so marking never writes to this index.
    assert "answer_count" not in projection["NonKeyAttributes"]
    # The moto table of the tests mirrors the template.
    assert projection["NonKeyAttributes"] == REQUIREMENT_PROFILE_BELT_ATTRIBUTES


def test_rn017_by_belt_stays_until_the_sheet_moves(template: dict[str, Any]) -> None:
    names = [
        index["IndexName"] for index in _requirements_table(template)["GlobalSecondaryIndexes"]
    ]

    assert names == ["by_belt", "by_profile_belt"]
    assert _index(template, "by_belt")["Projection"] == {"ProjectionType": "ALL"}


def _policies(template: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return template["Resources"][name]["Properties"]["Policies"]


@pytest.mark.parametrize(
    ("name", "policy"),
    [
        ("ListRequirementsFunction", "DynamoDBReadPolicy"),
        ("CreateRequirementFunction", "DynamoDBCrudPolicy"),
        ("UpdateRequirementFunction", "DynamoDBCrudPolicy"),
        ("DeleteRequirementFunction", "DynamoDBCrudPolicy"),
        ("SeedFunction", "DynamoDBCrudPolicy"),
    ],
)
def test_rn017_requirement_functions_reach_the_table_and_its_indexes(
    template: dict[str, Any], name: str, policy: str
) -> None:
    # The SAM policy templates grant the table and "table/index/*", so the
    # listing and the default order of other profiles may query
    # by_profile_belt, and the migration may Scan and UpdateItem the table.
    assert {policy: {"TableName": {"Ref": "RequirementsTable"}}} in _policies(template, name)


def test_rn017_seed_function_writes_the_migration_marker(template: dict[str, Any]) -> None:
    assert {"DynamoDBCrudPolicy": {"TableName": {"Ref": "SettingsTable"}}} in _policies(
        template, "SeedFunction"
    )


@pytest.mark.parametrize(
    "name", ["GetExamSheetFunction", "MarkAnswerFunction", "UnmarkAnswerFunction"]
)
def test_rn017_exam_functions_read_both_requirement_indexes_and_only_the_v2_marker(
    template: dict[str, Any], name: str
) -> None:
    # Step 3a of #144: the sheet's items come from by_profile_belt; the main
    # profile from by_belt only until the v2 migration marker is seen.
    resources: list[Any] = []
    settings_statements: list[dict[str, Any]] = []
    for policy in _policies(template, name):
        for statement in policy.get("Statement", []):
            resource = statement["Resource"]
            resources.extend(resource if isinstance(resource, list) else [resource])
            if resource == {"Fn::GetAtt": ["SettingsTable", "Arn"]}:
                settings_statements.append(statement)
    index_resources = [
        resource
        for resource in resources
        if isinstance(resource, dict) and "/index/" in str(resource.get("Fn::Sub", ""))
    ]

    # Least privilege: only the two indexes of Requirements, only to query.
    assert index_resources == [
        {"Fn::Sub": "${RequirementsTable.Arn}/index/by_belt"},
        {"Fn::Sub": "${RequirementsTable.Arn}/index/by_profile_belt"},
    ]
    # Settings: only GetItem, only on the v2 marker (never the academy record,
    # the signatures nor the profiles item), and nothing else reaches it.
    assert settings_statements == [
        {
            "Effect": "Allow",
            "Action": "dynamodb:GetItem",
            "Resource": {"Fn::GetAtt": ["SettingsTable", "Arn"]},
            "Condition": {
                "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": [requirement_repo.PROFILE_BELT_MIGRATION_MARKER_ID]
                }
            },
        }
    ]
    assert resources.count({"Fn::GetAtt": ["SettingsTable", "Arn"]}) == 1
