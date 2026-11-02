"""CloudFormation custom resource that loads the initial data on deploy.

The load is idempotent: running it again neither duplicates items nor
overwrites edits made on screen.

With low provisioned capacity (dev, free tier) the writes are throttled and
retried, so the load can take minutes. It stops ``SAFETY_MARGIN_SECONDS``
before the Lambda timeout and answers FAILED, so CloudFormation never waits
for a response that will not come. On an Update, the next deploy resumes the
missing items (the marker is written only at the end).
"""

import json
import logging
import time
import urllib.request
from typing import Any

from domain.belts import SEED_BELTS
from domain.requirements import seed_requirements
from repository import belts as belt_repo
from repository import requirements as requirement_repo
from repository.tables import DeadlineExceededError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

PHYSICAL_RESOURCE_ID = "initial-data"
# Time kept after the deadline for botocore's internal retries (~25 s) and the
# response to CloudFormation (10 s timeout).
SAFETY_MARGIN_SECONDS = 60
DEADLINE_REASON = (
    "Carga inicial interrompida pelo limite de tempo da Lambda (capacidade do DynamoDB "
    "baixa). Aumente a WCU de Requirements ou o Timeout da SeedFunction e faça o deploy de novo."
)


def seed_all(deadline: float | None = None) -> dict[str, int]:
    """Insert the missing seed items.

    Args:
        deadline: ``time.monotonic()`` value after which the load stops.

    Returns:
        Number of items inserted per entity.
    """
    return {
        "belts": belt_repo.seed_belts(SEED_BELTS, deadline=deadline),
        "requirements": requirement_repo.seed_requirements(seed_requirements(), deadline=deadline),
    }


def _deadline(context: Any) -> float | None:
    """Return the monotonic time at which the load must stop, from the Lambda context."""
    remaining_ms = getattr(context, "get_remaining_time_in_millis", None)
    if remaining_ms is None:
        return None
    return time.monotonic() + remaining_ms() / 1000 - SAFETY_MARGIN_SECONDS


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
            result = seed_all(_deadline(context))
            logger.info("Seed result: %s", result)
        _send_response(event, context, "SUCCESS", "OK")
    except DeadlineExceededError:
        logger.exception("Seed stopped at the deadline")
        _send_response(event, context, "FAILED", DEADLINE_REASON)
    except Exception as exc:
        logger.exception("Seed failed")
        _send_response(event, context, "FAILED", f"Falha na carga inicial: {exc}")
