"""Template of the event's requirement profile, step 3b-1 of #144 (RN016): least privilege.

The functions that create and edit an event read the profiles item of
``Settings`` and, when the event starts using a stored profile, check it in
the event's transaction: ``GetItem`` and ``ConditionCheckItem`` on that item
only (``dynamodb:LeadingKeys``), never the settings record nor the
signatures. The edit also queries ``Exams`` for the early answer of the lock.
No other event function reaches ``Settings``; no route, table or GSI is new
and the dev capacity (free tier) is unchanged.
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

from repository.requirement_profiles import REQUIREMENT_PROFILES_ID

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
SETTINGS_ARN = {"Fn::GetAtt": ["SettingsTable", "Arn"]}
EXAMS_ARN = {"Fn::GetAtt": ["ExamsTable", "Arn"]}
EVENTS_CRUD = {"DynamoDBCrudPolicy": {"TableName": {"Ref": "EventsTable"}}}
EVENTS_READ = {"DynamoDBReadPolicy": {"TableName": {"Ref": "EventsTable"}}}
PROFILES_ITEM = {
    "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:ConditionCheckItem"],
    "Resource": SETTINGS_ARN,
    "Condition": {"ForAllValues:StringEquals": {"dynamodb:LeadingKeys": [REQUIREMENT_PROFILES_ID]}},
}
EXAMS_QUERY = {"Effect": "Allow", "Action": "dynamodb:Query", "Resource": EXAMS_ARN}

EVENT_ROUTES = {
    "ListEventsFunction": ("GET", "/events", "list_events"),
    "CreateEventFunction": ("POST", "/events", "create_event"),
    "GetEventFunction": ("GET", "/events/{id}", "get_event"),
    "UpdateEventFunction": ("PUT", "/events/{id}", "update_event"),
    "DeleteEventFunction": ("DELETE", "/events/{id}", "delete_event"),
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
    return [
        statement for policy in properties["Policies"] for statement in policy.get("Statement", [])
    ]


def _managed(properties: dict[str, Any]) -> list[dict[str, Any]]:
    return [policy for policy in properties["Policies"] if "Statement" not in policy]


def test_rn016_create_event_reaches_only_the_profiles_item_of_settings(
    template: dict[str, Any],
) -> None:
    properties = _functions(template)["CreateEventFunction"]

    assert _managed(properties) == [EVENTS_CRUD]
    assert _statements(properties) == [PROFILES_ITEM]


def test_rn016_update_event_reaches_only_the_profiles_item_and_queries_exams(
    template: dict[str, Any],
) -> None:
    properties = _functions(template)["UpdateEventFunction"]

    assert _managed(properties) == [EVENTS_CRUD]
    assert _statements(properties) == [EXAMS_QUERY, PROFILES_ITEM]


@pytest.mark.parametrize(
    ("name", "policies"),
    [
        ("ListEventsFunction", [EVENTS_READ]),
        ("GetEventFunction", [EVENTS_READ]),
        (
            "DeleteEventFunction",
            [EVENTS_CRUD, {"DynamoDBReadPolicy": {"TableName": {"Ref": "ExamsTable"}}}],
        ),
    ],
)
def test_rn016_other_event_functions_keep_their_policies(
    template: dict[str, Any], name: str, policies: list[dict[str, Any]]
) -> None:
    # They return the event's profile_id but never read the profiles.
    assert _functions(template)[name]["Policies"] == policies


@pytest.mark.parametrize("name", ["CreateEventFunction", "UpdateEventFunction"])
def test_rn016_event_functions_never_write_nor_scan_settings(
    template: dict[str, Any], name: str
) -> None:
    for statement in _statements(_functions(template)[name]):
        if statement["Resource"] != SETTINGS_ARN:
            continue
        actions = statement["Action"]
        assert set([actions] if isinstance(actions, str) else actions) == {
            "dynamodb:GetItem",
            "dynamodb:ConditionCheckItem",
        }
        # Without the key condition they would reach the settings record and
        # the certificate signatures too.
        assert statement["Condition"] == PROFILES_ITEM["Condition"]


@pytest.mark.parametrize("name", list(EVENT_ROUTES))
def test_rn016_event_routes_are_unchanged(template: dict[str, Any], name: str) -> None:
    method, path, handler = EVENT_ROUTES[name]
    properties = _functions(template)[name]
    api = properties["Events"]["Api"]

    assert list(properties["Events"]) == ["Api"]
    assert (api["Properties"]["Method"], api["Properties"]["Path"]) == (method, path)
    assert "Auth" not in api["Properties"]
    assert properties["Handler"] == f"handlers.events.{handler}"
    # No environment of its own (e.g. the copy function's name).
    assert "Environment" not in properties


def test_rn016_no_new_event_route(template: dict[str, Any]) -> None:
    routes = {
        (event["Properties"]["Method"], event["Properties"]["Path"])
        for properties in _functions(template).values()
        for event in properties.get("Events", {}).values()
        if event["Type"] == "HttpApi" and event["Properties"]["Path"].startswith("/events")
    }

    assert routes == {
        ("GET", "/events"),
        ("POST", "/events"),
        ("GET", "/events/{id}"),
        ("PUT", "/events/{id}"),
        ("DELETE", "/events/{id}"),
        ("GET", "/events/{id}/exams"),
        ("POST", "/events/{id}/exams"),
        ("GET", "/events/{id}/exams/{student_id}"),
        ("PUT", "/events/{id}/exams/{student_id}/answers/{requirement_id}"),
        ("DELETE", "/events/{id}/exams/{student_id}/answers/{requirement_id}"),
        ("POST", "/events/{id}/exams/{student_id}/decision"),
    }


@pytest.mark.parametrize(
    "name", ["GetExamSheetFunction", "MarkAnswerFunction", "UnmarkAnswerFunction"]
)
def test_rn006_sheet_functions_query_the_profile_index(template: dict[str, Any], name: str) -> None:
    # The sheet of an event of any profile is one query on by_profile_belt,
    # already granted in step 3a; the profiles item is not read for it.
    statements = _statements(_functions(template)[name])
    queried = [
        resource
        for statement in statements
        if "dynamodb:Query" in statement["Action"]
        for resource in (
            statement["Resource"]
            if isinstance(statement["Resource"], list)
            else [statement["Resource"]]
        )
    ]

    assert {"Fn::Sub": "${RequirementsTable.Arn}/index/by_profile_belt"} in queried
    for statement in statements:
        if statement["Resource"] == SETTINGS_ARN:
            keys = statement["Condition"]["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"]
            assert REQUIREMENT_PROFILES_ID not in keys
