"""Starting the background copy never outlasts the function (RN017, #144, step 3a).

``POST /requirement-profiles`` and the resume route start the copy with an
asynchronous ``Invoke``. Without timeouts of its own, botocore waits up to
60 s per attempt for a call that hangs, past the 10 s timeout of the
function: the request died with a generic 5xx and the profile stayed
``COPYING`` with a fresh sign of life, so it showed as copying (not stalled)
for 15 minutes. The Lambda client now gives up in about 7 s at most, and the
route answers 202 with the profile already stalled (``copy_stalled``), ready to
be resumed.
"""

from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ConnectTimeoutError, ReadTimeoutError
from cfnlint.decode import decode
from conftest import EXAMINER, api_event, response_json

from handlers import requirement_profiles as profile_handlers
from repository import requirement_profiles as profile_repo

TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
# Time the function still needs besides the Invoke: the consistent read and
# the conditional write of the profiles item, and the "not started" mark.
OTHER_CALLS_SECONDS = 3
# Standard retry mode: before the second attempt botocore waits at most 1 s
# (random() * 2 ** 0).
MAX_BACKOFF_SECONDS = 1


@pytest.fixture(scope="module")
def function_timeout() -> int:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    resources = parsed["Resources"]
    for name in ("CreateRequirementProfileFunction", "ResumeRequirementProfileCopyFunction"):
        assert "Timeout" not in resources[name]["Properties"], name  # the global one
    return int(parsed["Globals"]["Function"]["Timeout"])


def test_rn017_copy_start_client_has_short_timeouts_and_one_retry(aws: None) -> None:
    config = profile_repo._lambda_client().meta.config

    assert config.connect_timeout == profile_repo.LAMBDA_CONNECT_TIMEOUT_SECONDS == 1
    assert config.read_timeout == profile_repo.LAMBDA_READ_TIMEOUT_SECONDS == 2
    assert config.retries == {"mode": "standard", "total_max_attempts": 2}


def test_rn017_copy_start_worst_case_fits_in_the_function_timeout(
    function_timeout: int,
) -> None:
    attempts = profile_repo.LAMBDA_MAX_ATTEMPTS
    per_attempt = (
        profile_repo.LAMBDA_CONNECT_TIMEOUT_SECONDS + profile_repo.LAMBDA_READ_TIMEOUT_SECONDS
    )
    worst = attempts * per_attempt + (attempts - 1) * MAX_BACKOFF_SECONDS

    assert worst == 7
    assert worst + OTHER_CALLS_SECONDS <= function_timeout


class _HungInvoke:
    """Every ``Invoke`` of the copy fails like a call that timed out on the network."""

    def __init__(self, error: Exception) -> None:
        self.error = error
        self.attempts = 0

    def __call__(self, **kwargs: Any) -> None:
        self.attempts += 1
        raise self.error


@pytest.fixture
def hung_invoke(aws: None, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Register the failure on the client and skip botocore's real backoff."""
    sleeps: list[float] = []
    monkeypatch.setattr("botocore.endpoint.time.sleep", sleeps.append)

    def install(error: Exception) -> tuple[_HungInvoke, list[float]]:
        hung = _HungInvoke(error)
        profile_repo._lambda_client().meta.events.register("before-send.lambda.Invoke", hung)
        return hung, sleeps

    return install


@pytest.mark.parametrize(
    "error",
    [
        ReadTimeoutError(endpoint_url="https://lambda.us-east-1.amazonaws.com"),
        ConnectTimeoutError(endpoint_url="https://lambda.us-east-1.amazonaws.com"),
    ],
    ids=["read", "connect"],
)
def test_rn017_hung_copy_start_gives_up_and_the_profile_shows_stalled(
    hung_invoke: Any, error: Exception
) -> None:
    hung, sleeps = hung_invoke(error)

    response = profile_handlers.create_profile(
        api_event(EXAMINER, body={"name": "Perfil do Sensei"}), None
    )

    assert response["statusCode"] == 202, response["body"]
    body = response_json(response)
    assert body["status"] == "COPYING"
    assert body["copy_updated_at"] is None
    assert body["copy_stalled"] is True  # the screen offers "Retomar cópia" at once
    assert hung.attempts == profile_repo.LAMBDA_MAX_ATTEMPTS
    assert len(sleeps) == 1 and sleeps[0] <= MAX_BACKOFF_SECONDS
    stored = profile_repo.get_profile(body["id"])
    assert stored is not None and stored.copy_updated_at is None


def test_rn017_hung_resume_answers_503_and_the_profile_stays_stalled(hung_invoke: Any) -> None:
    hung, _sleeps = hung_invoke(
        ReadTimeoutError(endpoint_url="https://lambda.us-east-1.amazonaws.com")
    )
    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": "Perfil"}), None)
    profile_id = response_json(created)["id"]
    hung.attempts = 0

    response = profile_handlers.resume_copy(api_event(EXAMINER, path={"id": profile_id}), None)

    assert response["statusCode"] == 503, response["body"]
    assert response_json(response) == {
        "message": "Sistema ocupado no momento. Tente de novo em instantes."
    }
    assert hung.attempts == profile_repo.LAMBDA_MAX_ATTEMPTS
    stored = profile_repo.get_profile(profile_id)
    assert stored is not None and stored.copy_updated_at is None
