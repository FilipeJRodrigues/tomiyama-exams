"""CloudFormation custom resource that loads the initial data on deploy.

The load is idempotent: running it again neither duplicates items nor
overwrites edits made on screen.
"""

import json
import logging
import urllib.request
from typing import Any

from domain.belts import SEED_BELTS
from domain.requirements import seed_requirements
from repository import belts as belt_repo
from repository import requirements as requirement_repo

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

PHYSICAL_RESOURCE_ID = "initial-data"


def seed_all() -> dict[str, int]:
    """Insert the missing seed items.

    Returns:
        Number of items inserted per entity.
    """
    return {
        "belts": belt_repo.seed_belts(SEED_BELTS),
        "requirements": requirement_repo.seed_requirements(seed_requirements()),
    }


def _send_response(event: dict[str, Any], context: Any, status: str, reason: str) -> None:
    """Report the result to CloudFormation through the pre-signed ``ResponseURL``."""
    body = json.dumps(
        {
            "Status": status,
            "Reason": reason,
            "PhysicalResourceId": event.get("PhysicalResourceId", PHYSICAL_RESOURCE_ID),
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        event["ResponseURL"],
        data=body,
        method="PUT",
        headers={"Content-Type": "", "Content-Length": str(len(body))},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        logger.info("CloudFormation response status: %s", response.status)


def handler(event: dict[str, Any], context: Any) -> None:
    """Seed on Create/Update; do nothing on Delete (data is retained)."""
    request_type = event.get("RequestType")
    try:
        if request_type in ("Create", "Update"):
            result = seed_all()
            logger.info("Seed result: %s", result)
        _send_response(event, context, "SUCCESS", "OK")
    except Exception as exc:
        logger.exception("Seed failed")
        _send_response(event, context, "FAILED", f"Seed failed: {exc}")
