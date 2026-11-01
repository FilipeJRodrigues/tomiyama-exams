"""Authentication helpers and the Cognito post-confirmation trigger."""

from typing import Any

import boto3
import pytest
from moto import mock_aws

from domain.errors import UnauthorizedError
from handlers.cognito_triggers import post_confirmation
from handlers.http import _parse_groups, current_user


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("[admin responsavel]", {"admin", "responsavel"}),
        ("[admin]", {"admin"}),
        ("admin", {"admin"}),
        (["admin", "responsavel"], {"admin", "responsavel"}),
        ('["admin","responsavel"]', {"admin", "responsavel"}),
        (None, set()),
    ],
)
def test_parse_groups(raw: Any, expected: set[str]) -> None:
    assert _parse_groups(raw) == expected


def test_current_user_from_claims() -> None:
    event = {
        "requestContext": {
            "authorizer": {"jwt": {"claims": {"sub": "abc", "cognito:groups": "[admin]"}}}
        }
    }
    user = current_user(event)
    assert user.sub == "abc"
    assert user.is_examiner


def test_current_user_without_claims() -> None:
    with pytest.raises(UnauthorizedError):
        current_user({"requestContext": {}})


def test_post_confirmation_adds_guardian_group() -> None:
    with mock_aws():
        client = boto3.client("cognito-idp")
        pool_id = client.create_user_pool(PoolName="test")["UserPool"]["Id"]
        client.create_group(UserPoolId=pool_id, GroupName="responsavel")
        client.admin_create_user(UserPoolId=pool_id, Username="pai@example.com")

        event = {
            "triggerSource": "PostConfirmation_ConfirmSignUp",
            "userPoolId": pool_id,
            "userName": "pai@example.com",
        }
        assert post_confirmation(event, None) is event

        groups = client.admin_list_groups_for_user(UserPoolId=pool_id, Username="pai@example.com")
        assert [g["GroupName"] for g in groups["Groups"]] == ["responsavel"]


def test_post_confirmation_ignores_other_sources() -> None:
    event = {"triggerSource": "PostConfirmation_ConfirmForgotPassword"}
    assert post_confirmation(event, None) is event
