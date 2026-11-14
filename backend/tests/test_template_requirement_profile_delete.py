"""Template of the deletion of a requirement profile, step 3b-2 of #144 (RN017).

One route (``DELETE /requirement-profiles/{id}``) and a background function
with no route, invoked asynchronously. Least privilege: both reach only the
profiles item of ``Settings`` (``dynamodb:LeadingKeys``); only the route
scans ``Events`` and invokes the background function; only the background
function queries ``by_profile_belt`` and deletes items of ``Requirements``.
No table, no GSI, the same ``DevCapacity``.
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

from handlers import requirement_profile_delete as delete_worker
from repository.requirement_profiles import (
    COPY_FUNCTION_ENV,
    DELETE_FUNCTION_ENV,
    REQUIREMENT_PROFILES_ID,
)

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
ROUTE = "DeleteRequirementProfileFunction"
WORKER = "DeleteRequirementProfileItemsFunction"
SETTINGS_ARN = {"Fn::GetAtt": ["SettingsTable", "Arn"]}
PROFILES_ONLY = {"ForAllValues:StringEquals": {"dynamodb:LeadingKeys": [REQUIREMENT_PROFILES_ID]}}
PROFILES_ITEM = {
    "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem"],
    "Resource": SETTINGS_ARN,
    "Condition": PROFILES_ONLY,
}


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


def _functions(template: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        name: resource["Properties"]
        for name, resource in template["Resources"].items()
        if resource["Type"] == "AWS::Serverless::Function"
    }


def _statements(properties: dict[str, Any]) -> list[dict[str, Any]]:
    statements = []
    for policy in properties.get("Policies", []):
        assert isinstance(policy, dict), policy
        statements.extend(policy.get("Statement", []))
    return statements


def _actions(statement: dict[str, Any]) -> list[str]:
    actions = statement["Action"]
    return [actions] if isinstance(actions, str) else list(actions)


def _resources(statement: dict[str, Any]) -> list[Any]:
    resources = statement["Resource"]
    return resources if isinstance(resources, list) else [resources]


def test_rn017_delete_profile_route(template: dict[str, Any]) -> None:
    properties = _functions(template)[ROUTE]
    api = properties["Events"]["Api"]

    assert api["Type"] == "HttpApi"
    assert (api["Properties"]["Method"], api["Properties"]["Path"]) == (
        "DELETE",
        "/requirement-profiles/{id}",
    )
    assert api["Properties"]["ApiId"] == {"Ref": "HttpApi"}
    # Behind the API's default Cognito authorizer, like every other route.
    assert "Auth" not in api["Properties"]
    assert properties["Handler"] == "handlers.requirement_profiles.delete_profile"
    assert set(properties["Events"]) == {"Api"}
    # Answers 202 at once: the default timeout of the API functions.
    assert "Timeout" not in properties


def test_rn017_delete_profile_route_with_least_privilege(template: dict[str, Any]) -> None:
    properties = _functions(template)[ROUTE]

    assert properties["Policies"] == [
        {
            "Statement": [
                PROFILES_ITEM,
                {
                    "Effect": "Allow",
                    "Action": "dynamodb:Scan",
                    "Resource": {"Fn::GetAtt": ["EventsTable", "Arn"]},
                },
                {
                    "Effect": "Allow",
                    "Action": "lambda:InvokeFunction",
                    "Resource": {"Fn::GetAtt": [WORKER, "Arn"]},
                },
            ]
        }
    ]
    assert properties["Environment"]["Variables"] == {DELETE_FUNCTION_ENV: {"Ref": WORKER}}


def test_rn017_deletion_function_runs_in_the_background(template: dict[str, Any]) -> None:
    properties = _functions(template)[WORKER]

    assert properties["Handler"] == "handlers.requirement_profile_delete.handler"
    assert "Events" not in properties  # no route: only the DELETE route invokes it
    assert properties["Timeout"] == 900
    # A failed run (deadline or error) is retried by Lambda, going on from
    # what is left, as the copy; the event is dropped after an hour.
    assert properties["EventInvokeConfig"] == {
        "MaximumRetryAttempts": 2,
        "MaximumEventAgeInSeconds": 3600,
    }
    assert (
        properties["EventInvokeConfig"]
        == _functions(template)["CopyRequirementProfileFunction"]["EventInvokeConfig"]
    )
    assert properties["Environment"]["Variables"] == {
        delete_worker.ITEMS_PER_SECOND_ENV: {
            "Fn::FindInMap": ["EnvConfig", {"Ref": "Environment"}, "DeleteItemsPerSecond"]
        }
    }


def test_rn017_deletion_function_with_least_privilege(template: dict[str, Any]) -> None:
    properties = _functions(template)[WORKER]

    assert properties["Policies"] == [
        {
            "Statement": [
                PROFILES_ITEM,
                {
                    "Effect": "Allow",
                    "Action": "dynamodb:Scan",
                    "Resource": {"Fn::GetAtt": ["BeltsTable", "Arn"]},
                },
                {
                    "Effect": "Allow",
                    "Action": "dynamodb:Query",
                    # Never by_belt nor the table: the fallback of the main
                    # profile is out of its reach.
                    "Resource": {"Fn::Sub": "${RequirementsTable.Arn}/index/by_profile_belt"},
                },
                {
                    "Effect": "Allow",
                    "Action": "dynamodb:DeleteItem",
                    "Resource": {"Fn::GetAtt": ["RequirementsTable", "Arn"]},
                },
            ]
        }
    ]


def test_rn017_a_dev_deletion_fits_in_one_run(template: dict[str, Any]) -> None:
    properties = _functions(template)[WORKER]
    config = template["Mappings"]["EnvConfig"]
    pace = float(config["dev"]["DeleteItemsPerSecond"])
    # At the dev pace, the 692 items of a copy of the main profile take
    # ~6 min, plus the wait before the last pass; a run deletes until 60 s
    # before its timeout, with room for throttling.
    seconds_per_run = properties["Timeout"] - delete_worker.SAFETY_MARGIN_SECONDS

    # A delete costs what a copy costs (the table and its 2 GSIs): the same pace.
    assert pace == float(config["dev"]["CopyItemsPerSecond"])
    assert pace <= 2  # half of the 4 WCU of Requirements and its GSIs
    assert seconds_per_run >= 2 * (692 / pace + delete_worker.SETTLE_SECONDS)
    assert float(config["prod"]["DeleteItemsPerSecond"]) > 0


def test_rn017_only_the_delete_route_starts_the_deletion(template: dict[str, Any]) -> None:
    functions = _functions(template)
    worker_arn = {"Fn::GetAtt": [WORKER, "Arn"]}

    for name, properties in functions.items():
        variables = properties.get("Environment", {}).get("Variables", {})
        invoked = [
            resource
            for statement in _statements(properties)
            if "lambda:InvokeFunction" in _actions(statement)
            for resource in _resources(statement)
        ]
        if name == ROUTE:
            assert invoked == [worker_arn]
            # It deletes; it never starts a copy.
            assert COPY_FUNCTION_ENV not in variables
        else:
            assert worker_arn not in invoked, name
            assert DELETE_FUNCTION_ENV not in variables, name
    assert DELETE_FUNCTION_ENV not in template["Globals"]["Function"]["Environment"]["Variables"]


def test_rn017_only_the_deletion_function_deletes_items_in_bulk(template: dict[str, Any]) -> None:
    # Explicit dynamodb:DeleteItem on Requirements: the background deletion
    # only (the route of DELETE /requirements/{id} uses its SAM policy).
    requirements_arn = {"Fn::GetAtt": ["RequirementsTable", "Arn"]}
    deleters = {
        name
        for name, properties in _functions(template).items()
        for statement in _statements(properties)
        if "dynamodb:DeleteItem" in _actions(statement)
        and requirements_arn in _resources(statement)
    }

    assert deleters == {WORKER}
    # And the route never reaches Requirements, nor the worker Events.
    for name, forbidden in ((ROUTE, "RequirementsTable"), (WORKER, "EventsTable")):
        for statement in _statements(_functions(template)[name]):
            assert forbidden not in str(statement["Resource"]), name


def test_rn017_only_the_delete_route_of_the_profiles_scans_events(
    template: dict[str, Any],
) -> None:
    events_arn = {"Fn::GetAtt": ["EventsTable", "Arn"]}
    scanners = {
        name
        for name, properties in _functions(template).items()
        if "RequirementProfile" in name
        for statement in _statements(properties)
        if events_arn in _resources(statement)
    }

    assert scanners == {ROUTE}


@pytest.mark.parametrize("name", [ROUTE, WORKER])
def test_rn017_deletion_never_scans_settings_nor_reads_other_items(
    template: dict[str, Any], name: str
) -> None:
    for statement in _statements(_functions(template)[name]):
        if SETTINGS_ARN in _resources(statement):
            assert statement["Condition"] == PROFILES_ONLY
            assert set(_actions(statement)) == {"dynamodb:GetItem", "dynamodb:UpdateItem"}


def test_rn017_deletion_keeps_the_dev_capacity_and_adds_no_table(template: dict[str, Any]) -> None:
    capacity = template["Mappings"]["DevCapacity"]
    resources = template["Resources"]

    assert sum(units["Read"] for units in capacity.values()) == 25
    assert sum(units["Write"] for units in capacity.values()) == 25
    assert capacity["Requirements"] == {"Read": 3, "Write": 4}
    assert capacity["RequirementsByBelt"] == {"Read": 1, "Write": 4}
    assert capacity["RequirementsByProfileBelt"] == {"Read": 5, "Write": 4}
    assert capacity["Events"] == {"Read": 2, "Write": 3}
    assert capacity["Settings"] == {"Read": 1, "Write": 1}
    assert len([1 for item in resources.values() if item["Type"] == "AWS::DynamoDB::Table"]) == 7
