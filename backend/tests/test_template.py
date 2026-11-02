"""Free-tier guard for ``infra/template.yaml``.

In dev every table and GSI is PROVISIONED, and the sum over all of them must
stay within the permanent free tier (25 RCU and 25 WCU per account and Region).
In prod they go back to PAY_PER_REQUEST with PITR, as the architecture asks.
"""

import re
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

    assert len(capacities) == 10  # 7 tables + 3 GSIs
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

    assert len(tables) == 7
    for name, resource in tables.items():
        for policy in ("DeletionPolicy", "UpdateReplacePolicy"):
            resolved = _resolve_if(resource[policy], is_prod=environment == "prod")
            assert resolved == expected, (name, policy)


def _route(function: dict[str, Any]) -> tuple[str, str]:
    api = function["Properties"]["Events"]["Api"]["Properties"]
    return api["Method"], api["Path"]


def _actions(function: dict[str, Any]) -> set[str]:
    actions: set[str] = set()
    for policy in function["Properties"]["Policies"]:
        for statement in policy.get("Statement", []):
            action = statement["Action"]
            actions |= {action} if isinstance(action, str) else set(action)
    return actions


@pytest.mark.parametrize(
    ("name", "method", "path", "needed"),
    [
        (
            "GetExamSheetFunction",
            "GET",
            "/events/{id}/exams/{student_id}",
            {"dynamodb:GetItem", "dynamodb:Query"},
        ),
        (
            "MarkAnswerFunction",
            "PUT",
            "/events/{id}/exams/{student_id}/answers/{requirement_id}",
            {"dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem"},
        ),
        (
            "UnmarkAnswerFunction",
            "DELETE",
            "/events/{id}/exams/{student_id}/answers/{requirement_id}",
            {"dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"},
        ),
    ],
)
def test_rn006_answer_routes_with_least_privilege(
    template: dict[str, Any], name: str, method: str, path: str, needed: set[str]
) -> None:
    function = template["Resources"][name]
    actions = _actions(function)

    assert _route(function) == (method, path)
    assert needed <= actions
    # Only explicit statements: no table-wide CRUD policy, scans or batch writes.
    assert all("Statement" in policy for policy in function["Properties"]["Policies"])
    assert not actions & {"dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:*"}


def test_rn017_mark_answer_may_check_the_requirement_in_the_transaction(
    template: dict[str, Any],
) -> None:
    # Replacing a mark checks the requirement's belt (ConditionCheck) in the same
    # transaction, so the function needs ConditionCheckItem on that table.
    function = template["Resources"]["MarkAnswerFunction"]
    requirement_actions: set[str] = set()
    for policy in function["Properties"]["Policies"]:
        for statement in policy.get("Statement", []):
            if statement["Resource"] == {"Fn::GetAtt": ["RequirementsTable", "Arn"]}:
                action = statement["Action"]
                requirement_actions |= {action} if isinstance(action, str) else set(action)

    assert "dynamodb:ConditionCheckItem" in requirement_actions
    assert "dynamodb:DeleteItem" not in requirement_actions


# A literal pool ID looks like "us-east-2_AbC123xyz"; a client ID is 26 lowercase alphanumerics.
POOL_ID_LITERAL = re.compile(r"[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+")
CLIENT_ID_LITERAL = re.compile(r"\b[a-z0-9]{26}\b")


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _strings(item)]
    if isinstance(value, list):
        return [text for item in value for text in _strings(item)]
    return []


def test_user_pool_ignores_case_in_the_email_username(template: dict[str, Any]) -> None:
    pool = template["Resources"]["UserPool"]["Properties"]

    assert pool["UsernameAttributes"] == ["email"]
    assert pool["UsernameConfiguration"] == {"CaseSensitive": False}


def test_user_pool_is_only_referenced_through_the_resource(template: dict[str, Any]) -> None:
    # Recreating the pool (the only way to change CaseSensitive) gives new IDs:
    # every reference must follow them.
    resources = template["Resources"]
    referencing = [
        name
        for name, resource in resources.items()
        if "UserPoolId" in resource.get("Properties", {})
    ]
    # client, 3 groups (admin, responsavel, master), first examiner and its 2 attachments
    assert len(referencing) == 7
    for name in referencing:
        assert resources[name]["Properties"]["UserPoolId"] == {"Ref": "UserPool"}, name

    jwt = resources["HttpApi"]["Properties"]["Auth"]["Authorizers"]["CognitoJwt"]
    assert jwt["JwtConfiguration"] == {
        "issuer": {"Fn::Sub": "https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}"},
        "audience": [{"Ref": "UserPoolClient"}],
    }
    assert resources["PostConfirmationPermission"]["Properties"]["SourceArn"] == {
        "Fn::GetAtt": ["UserPool", "Arn"]
    }
    assert template["Outputs"]["UserPoolId"]["Value"] == {"Ref": "UserPool"}
    assert template["Outputs"]["UserPoolClientId"]["Value"] == {"Ref": "UserPoolClient"}

    for text in _strings(template):
        assert not POOL_ID_LITERAL.search(text), text
        assert not CLIENT_ID_LITERAL.search(text), text


POOL_ARN = {"Fn::GetAtt": ["UserPool", "Arn"]}
SETTINGS_ARN = {"Fn::GetAtt": ["SettingsTable", "Arn"]}


def _statements(function: dict[str, Any]) -> list[dict[str, Any]]:
    policies = function["Properties"]["Policies"]
    assert all("Statement" in policy for policy in policies), "explicit statements only"
    return [statement for policy in policies for statement in policy["Statement"]]


@pytest.mark.parametrize(
    ("name", "method", "path", "expected"),
    [
        (
            "GetSettingsFunction",
            "GET",
            "/settings",
            {("dynamodb:GetItem", "SettingsTable"), ("cognito-idp:ListUsersInGroup", "UserPool")},
        ),
        (
            "UpdateSettingsFunction",
            "PUT",
            "/settings",
            {
                ("dynamodb:UpdateItem", "SettingsTable"),
                ("cognito-idp:ListUsersInGroup", "UserPool"),
            },
        ),
        (
            "ListExaminersFunction",
            "GET",
            "/examiners",
            {("cognito-idp:ListUsersInGroup", "UserPool")},
        ),
    ],
)
def test_settings_routes_with_least_privilege(
    template: dict[str, Any], name: str, method: str, path: str, expected: set[tuple[str, str]]
) -> None:
    function = template["Resources"][name]
    granted: set[tuple[str, str]] = set()
    for statement in _statements(function):
        assert statement["Effect"] == "Allow"
        assert statement["Resource"] in (POOL_ARN, SETTINGS_ARN), statement
        actions = statement["Action"]
        for action in [actions] if isinstance(actions, str) else actions:
            granted.add((action, statement["Resource"]["Fn::GetAtt"][0]))

    assert _route(function) == (method, path)
    assert granted == expected


@pytest.mark.parametrize(
    "name", ["GetSettingsFunction", "UpdateSettingsFunction", "ListExaminersFunction"]
)
def test_settings_functions_get_the_pool_id_from_the_resource(
    template: dict[str, Any], name: str
) -> None:
    variables = template["Resources"][name]["Properties"]["Environment"]["Variables"]

    assert variables == {"USER_POOL_ID": {"Ref": "UserPool"}}


def test_pool_id_is_never_global_nor_given_to_the_trigger(template: dict[str, Any]) -> None:
    # The pool references PostConfirmationFunction; a reference back (Globals
    # reach every function) would be a circular dependency.
    assert "USER_POOL_ID" not in template["Globals"]["Function"]["Environment"]["Variables"]
    trigger = template["Resources"]["PostConfirmationFunction"]["Properties"]
    assert "Environment" not in trigger
    assert template["Resources"]["UserPool"]["Properties"]["LambdaConfig"] == {
        "PostConfirmation": {"Fn::GetAtt": ["PostConfirmationFunction", "Arn"]}
    }


def test_master_group_exists_next_to_the_examiners(template: dict[str, Any]) -> None:
    resources = template["Resources"]
    groups = {
        resource["Properties"]["GroupName"]: name
        for name, resource in resources.items()
        if resource["Type"] == "AWS::Cognito::UserPoolGroup"
    }

    assert groups == {
        "admin": "AdminGroup",
        "responsavel": "GuardianGroup",
        "master": "MasterGroup",
    }
    assert resources["MasterGroup"]["Properties"]["UserPoolId"] == {"Ref": "UserPool"}


def test_first_examiner_is_in_admin_and_master(template: dict[str, Any]) -> None:
    # The first examiner (AdminEmail) is the first admin master; anyone else
    # becomes master only through the Console/CLI.
    attachments = [
        resource["Properties"]
        for resource in template["Resources"].values()
        if resource["Type"] == "AWS::Cognito::UserPoolUserToGroupAttachment"
    ]

    assert all(item["Username"] == {"Ref": "FirstAdminUser"} for item in attachments)
    assert all(item["UserPoolId"] == {"Ref": "UserPool"} for item in attachments)
    assert sorted(item["GroupName"]["Ref"] for item in attachments) == ["AdminGroup", "MasterGroup"]


def test_no_function_can_change_group_membership_but_the_trigger(template: dict[str, Any]) -> None:
    # Promoting someone to master has no API route.
    for name, resource in template["Resources"].items():
        if resource["Type"] != "AWS::Serverless::Function" or name == "PostConfirmationFunction":
            continue
        for policy in resource["Properties"].get("Policies", []):
            for statement in policy.get("Statement", []) if isinstance(policy, dict) else []:
                actions = statement["Action"]
                for action in [actions] if isinstance(actions, str) else actions:
                    assert "Group" not in action or action == "cognito-idp:ListUsersInGroup", (
                        name,
                        action,
                    )


def test_rn008_decision_route_with_least_privilege(template: dict[str, Any]) -> None:
    function = template["Resources"]["DecideExamFunction"]
    granted: set[tuple[str, str]] = set()
    for statement in _statements(function):
        assert statement["Effect"] == "Allow"
        resources = statement["Resource"]
        for resource in resources if isinstance(resources, list) else [resources]:
            # Whole tables by reference only: no wildcard, no index.
            table_name = resource["Fn::GetAtt"][0]
            actions = statement["Action"]
            for action in [actions] if isinstance(actions, str) else actions:
                granted.add((action, table_name))

    assert function["Properties"]["Handler"] == "handlers.exams.decide_exam"
    assert _route(function) == ("POST", "/events/{id}/exams/{student_id}/decision")
    assert granted == {
        ("dynamodb:GetItem", "EventsTable"),
        ("dynamodb:GetItem", "SettingsTable"),
        ("dynamodb:ConditionCheckItem", "SettingsTable"),
        ("dynamodb:GetItem", "ExamsTable"),
        ("dynamodb:UpdateItem", "ExamsTable"),
        ("dynamodb:GetItem", "StudentsTable"),
        ("dynamodb:UpdateItem", "StudentsTable"),
        ("dynamodb:ConditionCheckItem", "StudentsTable"),
        ("dynamodb:Scan", "BeltsTable"),
    }
    # No Cognito call: the sensei's group membership comes from the token.
    variables = function["Properties"].get("Environment", {}).get("Variables", {})
    assert "USER_POOL_ID" not in variables
