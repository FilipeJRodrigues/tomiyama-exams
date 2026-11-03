"""Certificate signature routes in ``infra/template.yaml`` (RN012): least privilege.

Each signature function reaches only the two items it needs in ``Settings``
(the settings record for the sensei, the signatures item for the list) and,
when it touches S3, only ``signatures/*`` with the actions it uses. The logo
and settings functions are limited to the settings record, so none of them
can read the signatures.
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

from domain.settings import SETTINGS_ID
from domain.signatures import SIGNATURE_KEY_PREFIX, SIGNATURES_ID

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
SETTINGS_ARN = {"Fn::GetAtt": ["SettingsTable", "Arn"]}
SIGNATURES_ARN = {"Fn::Sub": f"${{ImagesBucket.Arn}}/{SIGNATURE_KEY_PREFIX}*"}
LOGOS_ARN = {"Fn::Sub": "${ImagesBucket.Arn}/logos/*"}

BOTH = (SETTINGS_ID, SIGNATURES_ID)
WRITE = {
    ("dynamodb:GetItem", BOTH),
    ("dynamodb:ConditionCheckItem", (SETTINGS_ID,)),
    ("dynamodb:PutItem", (SIGNATURES_ID,)),
}
READ = {("dynamodb:GetItem", BOTH)}

SIGNATURE_FUNCTIONS = {
    "ListSignaturesFunction": ("GET", "/settings/signatures", "list_signatures", READ),
    "CreateSignatureFunction": ("POST", "/settings/signatures", "create_signature", WRITE),
    "ReorderSignaturesFunction": (
        "PUT",
        "/settings/signatures/order",
        "reorder_signatures",
        WRITE,
    ),
    "UpdateSignatureFunction": ("PUT", "/settings/signatures/{id}", "update_signature", WRITE),
    "DeleteSignatureFunction": (
        "DELETE",
        "/settings/signatures/{id}",
        "delete_signature",
        WRITE | {("s3:DeleteObject", "signatures/*")},
    ),
    "PutSignatureImageFunction": (
        "PUT",
        "/settings/signatures/{id}/image",
        "put_signature_image",
        WRITE | {("s3:PutObject", "signatures/*"), ("s3:DeleteObject", "signatures/*")},
    ),
    "DeleteSignatureImageFunction": (
        "DELETE",
        "/settings/signatures/{id}/image",
        "delete_signature_image",
        WRITE | {("s3:DeleteObject", "signatures/*")},
    ),
    "GetSignatureImageFunction": (
        "GET",
        "/settings/signatures/{id}/image",
        "get_signature_image",
        READ | {("s3:GetObject", "signatures/*")},
    ),
}


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


def _statements(function: dict[str, Any]) -> list[dict[str, Any]]:
    policies = function["Properties"]["Policies"]
    assert all("Statement" in policy for policy in policies), "explicit statements only"
    return [statement for policy in policies for statement in policy["Statement"]]


def _granted(function: dict[str, Any]) -> set[tuple[str, Any]]:
    granted: set[tuple[str, Any]] = set()
    for statement in _statements(function):
        assert statement["Effect"] == "Allow"
        actions = statement["Action"]
        actions = [actions] if isinstance(actions, str) else actions
        if statement["Resource"] == SETTINGS_ARN:
            condition = statement["Condition"]["ForAllValues:StringEquals"]
            assert set(condition) == {"dynamodb:LeadingKeys"}
            target: Any = tuple(condition["dynamodb:LeadingKeys"])
        else:
            assert statement["Resource"] == SIGNATURES_ARN, statement
            assert "Condition" not in statement
            target = "signatures/*"
        granted.update((action, target) for action in actions)
    return granted


@pytest.mark.parametrize("name", list(SIGNATURE_FUNCTIONS))
def test_rn012_signature_routes_with_least_privilege(template: dict[str, Any], name: str) -> None:
    method, path, handler, expected = SIGNATURE_FUNCTIONS[name]
    function = template["Resources"][name]
    api = function["Properties"]["Events"]["Api"]["Properties"]

    assert (api["Method"], api["Path"]) == (method, path)
    assert api["ApiId"] == {"Ref": "HttpApi"}
    assert function["Properties"]["Handler"] == f"handlers.signatures.{handler}"
    assert _granted(function) == expected
    uses_s3 = any(action.startswith("s3:") for action, _ in expected)
    variables = function["Properties"].get("Environment", {}).get("Variables", {})
    assert variables == ({"IMAGES_BUCKET": {"Ref": "ImagesBucket"}} if uses_s3 else {})


def test_rn012_every_signature_handler_has_a_route(template: dict[str, Any]) -> None:
    routed = {
        resource["Properties"]["Handler"]
        for resource in template["Resources"].values()
        if resource["Type"] == "AWS::Serverless::Function"
        and resource["Properties"]["Handler"].startswith("handlers.signatures.")
    }

    assert routed == {f"handlers.signatures.{spec[2]}" for spec in SIGNATURE_FUNCTIONS.values()}


def _resources_of(function: dict[str, Any]) -> list[Any]:
    return [statement["Resource"] for statement in _statements(function)]


def test_rn012_logo_and_signature_functions_never_cross_prefixes(
    template: dict[str, Any],
) -> None:
    for name, resource in template["Resources"].items():
        if resource["Type"] != "AWS::Serverless::Function":
            continue
        handler = resource["Properties"]["Handler"]
        policies = resource["Properties"].get("Policies", [])
        if not all(isinstance(policy, dict) and "Statement" in policy for policy in policies):
            continue
        resources = _resources_of(resource)
        if handler.startswith("handlers.logos."):
            assert SIGNATURES_ARN not in resources, name
        else:
            assert LOGOS_ARN not in resources, name
        if not handler.startswith("handlers.signatures."):
            assert SIGNATURES_ARN not in resources, name


@pytest.mark.parametrize(
    "name",
    [
        "GetSettingsFunction",
        "UpdateSettingsFunction",
        "PutLogoFunction",
        "DeleteLogoFunction",
        "GetLogoFunction",
        "DecideExamFunction",
    ],
)
def test_rn012_settings_and_logo_functions_cannot_read_the_signatures(
    template: dict[str, Any], name: str
) -> None:
    for statement in _statements(template["Resources"][name]):
        if statement["Resource"] != SETTINGS_ARN:
            continue
        assert statement["Condition"] == {
            "ForAllValues:StringEquals": {"dynamodb:LeadingKeys": [SETTINGS_ID]}
        }, (name, statement)


def test_rn012_only_the_seed_reaches_the_whole_settings_table(template: dict[str, Any]) -> None:
    # Every function statement on Settings is limited to named items, except
    # the seed's CRUD (it writes markers such as the initial-data load).
    for name, resource in template["Resources"].items():
        if resource["Type"] != "AWS::Serverless::Function" or name == "SeedFunction":
            continue
        for policy in resource["Properties"].get("Policies", []):
            for statement in policy.get("Statement", []):
                if statement["Resource"] == SETTINGS_ARN:
                    assert "dynamodb:LeadingKeys" in str(statement.get("Condition")), name


def test_rn012_only_signature_functions_name_the_signatures_item(
    template: dict[str, Any],
) -> None:
    for name, resource in template["Resources"].items():
        if resource["Type"] != "AWS::Serverless::Function":
            continue
        if resource["Properties"]["Handler"].startswith("handlers.signatures."):
            continue
        assert SIGNATURES_ID not in str(resource), name
