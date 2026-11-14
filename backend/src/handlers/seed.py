"""CloudFormation custom resource that loads the initial data on deploy.

The load is idempotent: running it again neither duplicates items nor
overwrites edits made on screen. After the seed it moves the requirements
written before profiles existed to the main profile, once, with its own
marker (``repository.requirements.migrate_to_main_profile``), and then checks
every requirement's profile attributes once more, with another marker
(``repository.requirements.migrate_profile_belts``, v2): only after that
marker the main profile is read through the ``by_profile_belt`` index.

With low provisioned capacity (dev, free tier) the writes are throttled and
retried, so the load can take minutes. It stops ``SAFETY_MARGIN_SECONDS``
before the Lambda timeout and answers FAILED, so CloudFormation never waits
for a response that will not come. On an Update, the next deploy resumes the
missing items (the marker is written only at the end). When the deadline comes
while the v2 migration waits for ``by_profile_belt`` to be built, the FAILED
answer says so (``INDEX_DEADLINE_REASON``) instead of blaming the capacity.
"""

import json
import logging
import time
import urllib.request
from collections.abc import Callable
from typing import Any

from domain.belts import SEED_BELTS
from domain.requirements import seed_requirements
from repository import belts as belt_repo
from repository import requirements as requirement_repo
from repository.requirements import ProfileIndexNotActiveError
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
# The deadline came while the v2 migration waited for the new GSI: no capacity to raise.
INDEX_DEADLINE_REASON = (
    "Carga inicial interrompida pelo limite de tempo da Lambda: o índice by_profile_belt da "
    "tabela Requirements ainda está sendo criado pelo DynamoDB. Os requisitos já foram "
    "conferidos e nada se perdeu; faça o deploy de novo para concluir a migração."
)


def seed_all(deadline: float | None = None) -> dict[str, int]:
    """Insert the missing seed items, then run the two requirement profile migrations.

    The migrations run after the seed so that items of a seed interrupted
    before profiles existed are moved too; new seed items are already born in
    the main profile. v2 runs after v1 and also fixes what v1 skipped (an
    item moved to another belt between v1's scan and its write).

    Args:
        deadline: ``time.monotonic()`` value after which the load stops.

    Returns:
        Number of items inserted per entity, and of requirements written by
        the two profile migrations (``requirement_profiles``: moved to the
        main profile by v1 plus fixed by v2; each migration logs its own count).
    """
    belts = belt_repo.seed_belts(SEED_BELTS, deadline=deadline)
    requirements = requirement_repo.seed_requirements(seed_requirements(), deadline=deadline)
    moved = requirement_repo.migrate_to_main_profile(deadline=deadline)
    fixed = requirement_repo.migrate_profile_belts(deadline=deadline)
    return {"belts": belts, "requirements": requirements, "requirement_profiles": moved + fixed}


def _deadline(context: Any, clock: Callable[[], float] = time.monotonic) -> float | None:
    """Return the ``clock()`` time at which the load must stop, from the Lambda context.

    ``clock`` is injected for tests; the retries compare the deadline with
    ``time.monotonic()``.
    """
    remaining_ms = getattr(context, "get_remaining_time_in_millis", None)
    if remaining_ms is None:
        return None
    return clock() + remaining_ms() / 1000 - SAFETY_MARGIN_SECONDS


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
    except ProfileIndexNotActiveError:
        logger.exception("Seed stopped at the deadline, waiting for the index")
        _send_response(event, context, "FAILED", INDEX_DEADLINE_REASON)
    except DeadlineExceededError:
        logger.exception("Seed stopped at the deadline")
        _send_response(event, context, "FAILED", DEADLINE_REASON)
    except Exception as exc:
        logger.exception("Seed failed")
        _send_response(event, context, "FAILED", f"Falha na carga inicial: {exc}")
