"""Cognito retention in ``infra/template.yaml`` (card #32).

Students keep the guardian's ``sub`` in ``owner_id`` (RN013), so in prod the
pool must survive a stack deletion or replacement, like the tables. The
resources that hold data inside the pool (groups, first examiner and their
memberships) follow the same policy; the app client holds no data and goes
with the stack. Dev stays deletable with the stack.
"""

from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
RETAINED_IN_PROD = {
    "UserPool": "AWS::Cognito::UserPool",
    "AdminGroup": "AWS::Cognito::UserPoolGroup",
    "GuardianGroup": "AWS::Cognito::UserPoolGroup",
    "MasterGroup": "AWS::Cognito::UserPoolGroup",
    "FirstAdminUser": "AWS::Cognito::UserPoolUser",
    "FirstAdminInGroup": "AWS::Cognito::UserPoolUserToGroupAttachment",
    "FirstAdminInMasterGroup": "AWS::Cognito::UserPoolUserToGroupAttachment",
}
DATA_TYPES = {
    "AWS::Cognito::UserPool",
    "AWS::Cognito::UserPoolGroup",
    "AWS::Cognito::UserPoolUser",
    "AWS::Cognito::UserPoolUserToGroupAttachment",
}


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


def _resolve_if(value: Any, *, is_prod: bool) -> Any:
    """Resolve ``!If [IsProd, prod, dev]`` the way LanguageExtensions does."""
    condition, prod, dev = value["Fn::If"]
    assert condition == "IsProd"
    return prod if is_prod else dev


def test_every_cognito_resource_with_data_is_covered(template: dict[str, Any]) -> None:
    # A new group, user or membership must be added to RETAINED_IN_PROD too.
    with_data = {
        name: resource["Type"]
        for name, resource in template["Resources"].items()
        if resource["Type"] in DATA_TYPES
    }

    assert with_data == RETAINED_IN_PROD


@pytest.mark.parametrize(("environment", "expected"), [("dev", "Delete"), ("prod", "Retain")])
@pytest.mark.parametrize("name", sorted(RETAINED_IN_PROD))
def test_cognito_data_is_deleted_in_dev_and_retained_in_prod(
    template: dict[str, Any], name: str, environment: str, expected: str
) -> None:
    resource = template["Resources"][name]

    for policy in ("DeletionPolicy", "UpdateReplacePolicy"):
        resolved = _resolve_if(resource[policy], is_prod=environment == "prod")
        assert resolved == expected, (name, policy)


@pytest.mark.parametrize(("environment", "expected"), [("dev", "INACTIVE"), ("prod", "ACTIVE")])
def test_user_pool_deletion_protection_only_in_prod(
    template: dict[str, Any], environment: str, expected: str
) -> None:
    properties = template["Resources"]["UserPool"]["Properties"]

    resolved = _resolve_if(properties["DeletionProtection"], is_prod=environment == "prod")
    assert resolved == expected


def test_user_pool_keeps_the_case_insensitive_username(template: dict[str, Any]) -> None:
    # Decided on 2026-11-02 for dev and prod; it can only be set when the pool is created.
    properties = template["Resources"]["UserPool"]["Properties"]

    assert properties["UsernameConfiguration"] == {"CaseSensitive": False}


def test_user_pool_client_goes_with_the_stack(template: dict[str, Any]) -> None:
    # The client holds no data: a new one only changes UserPoolClientId and asks
    # for a new login, so it is not kept as an unused client in either environment.
    client = template["Resources"]["UserPoolClient"]

    assert "DeletionPolicy" not in client
    assert "UpdateReplacePolicy" not in client
