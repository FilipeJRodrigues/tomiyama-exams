"""Cognito triggers."""

import logging
from typing import Any

import boto3

from domain.users import GUARDIAN_GROUP

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def post_confirmation(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Put every self-registered account in the ``responsavel`` group.

    Examiners are promoted later by another examiner; this trigger only runs
    for sign-up confirmations, not for accounts created by an administrator.
    """
    if event.get("triggerSource") == "PostConfirmation_ConfirmSignUp":
        boto3.client("cognito-idp").admin_add_user_to_group(
            UserPoolId=event["userPoolId"],
            Username=event["userName"],
            GroupName=GUARDIAN_GROUP,
        )
        logger.info("User %s added to group %s", event["userName"], GUARDIAN_GROUP)
    return event
