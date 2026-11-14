"""Template of the requirement profiles, step 2 of #144 (RN017): least privilege.

Five routes (list, get, create, rename, resume the copy) and a copy function
with no route, invoked asynchronously. The profiles live in one item of
``Settings`` (``requirement_profiles``): every function reaches only that item
(``dynamodb:LeadingKeys``), only the create and resume functions may invoke
the copy function, and the dev capacity (free tier) is unchanged: no table,
no GSI, the same ``DevCapacity``.
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

from handlers import requirement_profile_copy as copy_worker
from repository.requirement_profiles import COPY_FUNCTION_ENV, REQUIREMENT_PROFILES_ID
from repository.requirements import PROFILE_BELT_MIGRATION_MARKER_ID

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
SETTINGS_ARN = {"Fn::GetAtt": ["SettingsTable", "Arn"]}
COPY_ARN = {"Fn::GetAtt": ["CopyRequirementProfileFunction", "Arn"]}
PROFILES_ONLY = {"ForAllValues:StringEquals": {"dynamodb:LeadingKeys": [REQUIREMENT_PROFILES_ID]}}
# Step 3a of #144: the v2 migration marker, read to know when the main profile
# may be read through by_profile_belt.
MARKER_ONLY = {
    "ForAllValues:StringEquals": {"dynamodb:LeadingKeys": [PROFILE_BELT_MIGRATION_MARKER_ID]}
}
PROFILES_AND_MARKER = {
    "ForAllValues:StringEquals": {
        "dynamodb:LeadingKeys": [REQUIREMENT_PROFILES_ID, PROFILE_BELT_MIGRATION_MARKER_ID]
    }
}

ROUTES = {
    "ListRequirementProfilesFunction": ("GET", "/requirement-profiles", "list_profiles"),
    "GetRequirementProfileFunction": ("GET", "/requirement-profiles/{id}", "get_profile"),
    "CreateRequirementProfileFunction": ("POST", "/requirement-profiles", "create_profile"),
    "UpdateRequirementProfileFunction": ("PUT", "/requirement-profiles/{id}", "rename_profile"),
    "ResumeRequirementProfileCopyFunction": (
        "POST",
        "/requirement-profiles/{id}/copy",
        "resume_copy",
    ),
}
GRANTED = {
    "ListRequirementProfilesFunction": {("dynamodb:GetItem", "Settings[profiles]")},
    "GetRequirementProfileFunction": {("dynamodb:GetItem", "Settings[profiles]")},
    "CreateRequirementProfileFunction": {
        ("dynamodb:GetItem", "Settings[profiles]"),
        ("dynamodb:PutItem", "Settings[profiles]"),
        ("dynamodb:UpdateItem", "Settings[profiles]"),
        ("lambda:InvokeFunction", "CopyRequirementProfileFunction"),
    },
    "UpdateRequirementProfileFunction": {
        ("dynamodb:GetItem", "Settings[profiles]"),
        ("dynamodb:UpdateItem", "Settings[profiles]"),
    },
    "ResumeRequirementProfileCopyFunction": {
        ("dynamodb:GetItem", "Settings[profiles]"),
        ("dynamodb:UpdateItem", "Settings[profiles]"),
        ("lambda:InvokeFunction", "CopyRequirementProfileFunction"),
    },
    "CopyRequirementProfileFunction": {
        ("dynamodb:GetItem", "Settings[profiles]"),
        ("dynamodb:UpdateItem", "Settings[profiles]"),
        # Step 3a: reads (never writes) the v2 marker to read a main source.
        ("dynamodb:GetItem", "Settings[v2 marker]"),
        ("dynamodb:Scan", "BeltsTable"),
        ("dynamodb:Query", "RequirementsTable/index/by_belt"),
        ("dynamodb:Query", "RequirementsTable/index/by_profile_belt"),
        ("dynamodb:PutItem", "RequirementsTable"),
    },
}
# DevCapacity: the copy must fit in what step 1 left (25/25). Step 3a moved
# the read capacity of by_belt to by_profile_belt (5 <-> 1), where every read
# of a profile's items goes, the exam sheet included.
DEV_CAPACITY = {
    "Belts": {"Read": 2, "Write": 1},
    "Students": {"Read": 3, "Write": 1},
    "StudentsByOwner": {"Read": 2, "Write": 1},
    "Exams": {"Read": 2, "Write": 3},
    "ExamsByStudent": {"Read": 1, "Write": 1},
    "Requirements": {"Read": 3, "Write": 4},
    "RequirementsByBelt": {"Read": 1, "Write": 4},
    "RequirementsByProfileBelt": {"Read": 5, "Write": 4},
    "Settings": {"Read": 1, "Write": 1},
    "Events": {"Read": 2, "Write": 3},
    "Answers": {"Read": 3, "Write": 2},
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


def _target(statement: dict[str, Any], resource: Any) -> str:
    """Name what a statement reaches: a table, an index, a function or a Settings item."""
    if resource == SETTINGS_ARN:
        if statement.get("Condition") == MARKER_ONLY:
            return "Settings[v2 marker]"
        assert statement.get("Condition") == PROFILES_ONLY, statement
        return "Settings[profiles]"
    assert "Condition" not in statement, statement
    if "Fn::GetAtt" in resource:
        name, attribute = resource["Fn::GetAtt"]
        assert attribute == "Arn"
        return name
    return resource["Fn::Sub"].replace("${", "").replace(".Arn}", "")


def _granted(properties: dict[str, Any]) -> set[tuple[str, str]]:
    granted: set[tuple[str, str]] = set()
    for policy in properties["Policies"]:
        assert set(policy) == {"Statement"}, "explicit statements only"
        for statement in policy["Statement"]:
            assert statement["Effect"] == "Allow"
            resources = statement["Resource"]
            actions = statement["Action"]
            for resource in resources if isinstance(resources, list) else [resources]:
                for action in [actions] if isinstance(actions, str) else actions:
                    granted.add((action, _target(statement, resource)))
    return granted


@pytest.mark.parametrize("name", list(ROUTES))
def test_rn017_profile_routes(template: dict[str, Any], name: str) -> None:
    method, path, handler = ROUTES[name]
    properties = _functions(template)[name]
    api = properties["Events"]["Api"]

    assert api["Type"] == "HttpApi"
    assert (api["Properties"]["Method"], api["Properties"]["Path"]) == (method, path)
    assert api["Properties"]["ApiId"] == {"Ref": "HttpApi"}
    # Behind the API's default Cognito authorizer, like every other route.
    assert "Auth" not in api["Properties"]
    assert properties["Handler"] == f"handlers.requirement_profiles.{handler}"


@pytest.mark.parametrize("name", list(GRANTED))
def test_rn017_profile_functions_with_least_privilege(template: dict[str, Any], name: str) -> None:
    assert _granted(_functions(template)[name]) == GRANTED[name]


def test_rn017_copy_function_runs_in_the_background(template: dict[str, Any]) -> None:
    properties = _functions(template)["CopyRequirementProfileFunction"]

    assert properties["Handler"] == "handlers.requirement_profile_copy.handler"
    assert "Events" not in properties  # no route: only the two functions invoke it
    assert properties["Timeout"] == 900
    # A failed run (deadline or error) is retried by Lambda, going on from
    # what was written; the event is dropped after an hour.
    assert properties["EventInvokeConfig"] == {
        "MaximumRetryAttempts": 2,
        "MaximumEventAgeInSeconds": 3600,
    }
    assert properties["Environment"]["Variables"] == {
        copy_worker.ITEMS_PER_SECOND_ENV: {
            "Fn::FindInMap": ["EnvConfig", {"Ref": "Environment"}, "CopyItemsPerSecond"]
        }
    }


def test_rn017_a_dev_copy_fits_in_one_run(template: dict[str, Any]) -> None:
    properties = _functions(template)["CopyRequirementProfileFunction"]
    pace = float(template["Mappings"]["EnvConfig"]["dev"]["CopyItemsPerSecond"])
    # At the dev pace, the 692 items of the main profile take ~6 min; a run
    # copies until 60 s before its timeout, with room for throttling.
    seconds_per_run = properties["Timeout"] - copy_worker.SAFETY_MARGIN_SECONDS

    assert pace <= 2  # half of the 4 WCU of Requirements and its GSIs
    assert seconds_per_run >= 2 * 692 / pace


@pytest.mark.parametrize(
    "name", ["CreateRequirementProfileFunction", "ResumeRequirementProfileCopyFunction"]
)
def test_rn017_only_create_and_resume_start_the_copy(template: dict[str, Any], name: str) -> None:
    variables = _functions(template)[name]["Environment"]["Variables"]

    assert variables == {COPY_FUNCTION_ENV: {"Ref": "CopyRequirementProfileFunction"}}


def test_rn017_no_other_function_invokes_lambda(template: dict[str, Any]) -> None:
    # Step 3b-2: the route that deletes a profile invokes the background
    # deletion, and only it; the copy is still started by create and resume only.
    invokers: dict[str, Any] = {}
    for name, properties in _functions(template).items():
        for policy in properties.get("Policies", []):
            for statement in policy.get("Statement", []) if isinstance(policy, dict) else []:
                actions = statement["Action"]
                actions = [actions] if isinstance(actions, str) else actions
                if any(action.startswith("lambda:") for action in actions):
                    assert actions == ["lambda:InvokeFunction"], (name, actions)
                    assert name not in invokers, name
                    invokers[name] = statement["Resource"]
        variables = properties.get("Environment", {}).get("Variables", {})
        if invokers.get(name) != COPY_ARN:
            assert COPY_FUNCTION_ENV not in variables, name

    assert invokers == {
        "CreateRequirementProfileFunction": COPY_ARN,
        "ResumeRequirementProfileCopyFunction": COPY_ARN,
        "DeleteRequirementProfileFunction": {
            "Fn::GetAtt": ["DeleteRequirementProfileItemsFunction", "Arn"]
        },
    }
    assert COPY_FUNCTION_ENV not in template["Globals"]["Function"]["Environment"]["Variables"]


@pytest.mark.parametrize(
    ("name", "condition"),
    [
        # Step 3a: the list and the default order of a new item read a belt of
        # the main profile, so they also read the v2 marker.
        ("ListRequirementsFunction", PROFILES_AND_MARKER),
        ("CreateRequirementFunction", PROFILES_AND_MARKER),
        ("UpdateRequirementFunction", PROFILES_ONLY),
        ("DeleteRequirementFunction", PROFILES_ONLY),
    ],
)
def test_rn017_requirement_functions_read_only_the_profiles_item(
    template: dict[str, Any], name: str, condition: dict[str, Any]
) -> None:
    statements = [
        statement
        for policy in _functions(template)[name]["Policies"]
        for statement in policy.get("Statement", [])
    ]

    assert statements == [
        {
            "Effect": "Allow",
            "Action": "dynamodb:GetItem",
            "Resource": SETTINGS_ARN,
            "Condition": condition,
        }
    ]


def test_rn017_profiles_use_no_new_table_nor_index(template: dict[str, Any]) -> None:
    resources = template["Resources"]
    tables = {
        name: resource["Properties"]
        for name, resource in resources.items()
        if resource["Type"] == "AWS::DynamoDB::Table"
    }
    indexes = {
        f"{name}.{index['IndexName']}"
        for name, properties in tables.items()
        for index in properties.get("GlobalSecondaryIndexes", [])
    }

    assert sorted(tables) == [
        "AnswersTable",
        "BeltsTable",
        "EventsTable",
        "ExamsTable",
        "RequirementsTable",
        "SettingsTable",
        "StudentsTable",
    ]
    assert indexes == {
        "StudentsTable.by_owner",
        "ExamsTable.by_student",
        "RequirementsTable.by_belt",
        "RequirementsTable.by_profile_belt",
    }
    # No other DynamoDB resource either (a global table, a stream, scaling).
    assert {name for name, item in resources.items() if "DynamoDB" in item["Type"]} == set(tables)
    assert not [
        name for name, item in resources.items() if "ApplicationAutoScaling" in item["Type"]
    ]


def test_rn017_dev_capacity_moves_reads_to_the_profile_index(template: dict[str, Any]) -> None:
    capacity = template["Mappings"]["DevCapacity"]

    assert capacity == DEV_CAPACITY
    assert sum(units["Read"] for units in capacity.values()) == 25
    assert sum(units["Write"] for units in capacity.values()) == 25


def test_rn017_settings_is_never_scanned_by_the_profile_functions(
    template: dict[str, Any],
) -> None:
    # A Scan cannot be limited by dynamodb:LeadingKeys: it would read the
    # settings record and the certificate signatures too.
    for name in GRANTED:
        assert ("dynamodb:Scan", "Settings[profiles]") not in _granted(_functions(template)[name])
