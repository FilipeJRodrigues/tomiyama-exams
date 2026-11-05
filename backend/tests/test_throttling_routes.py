"""Throttling that outlasted botocore's retries answers 503 on every route (#43).

Each case throttles, at the botocore level (``throttle_dynamodb``), one
DynamoDB call that a route of ``SCENARIO_ROUTES`` makes, as when the
provisioned capacity stays exhausted after botocore's own retries. The route
must answer 503 with only "Sistema ocupado no momento. Tente de novo em
instantes." and, on the routes that write, nothing may change in any table.

These are the calls that already answer 503 (lists through ``paginate``, the
``Limit=1`` queries of #18, the reads through ``get_item_or_busy`` and the
attendance, decision and marking transactions). The calls that still answered
500 are in ``regression/test_43_*.py``. Other routes with their own coverage:
``PUT``/``DELETE /students/{id}`` (``regression/test_18_*``,
``test_student_update_throttling.py``), ``GET /students/{id}/exams``
(``test_student_history.py``), settings, logos and signatures
(``test_settings.py``, ``test_logos.py``, ``test_signatures*.py``).

Reads made after a successful write (the score summary of the marking) are
left out: the mark is already stored when they run.
"""

import pytest
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    SCENARIO_ROUTES,
    assert_service_busy,
    dynamodb_snapshot,
    leave_batch_unprocessed,
    throttle_dynamodb,
)

from repository.tables import (
    ANSWERS_TABLE_ENV,
    BELTS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
)

READ_ONLY_ROUTES = frozenset(
    {
        "GET /belts",
        "GET /students",
        "GET /students (responsável)",
        "GET /students/{id}",
        "GET /requirements",
        "GET /requirements?belt_id",
        "GET /events",
        "GET /events/{id}",
        "GET /events/{id}/exams",
        "GET /events/{id}/exams/{student_id}",
    }
)


@pytest.mark.parametrize("route", sorted(SCENARIO_ROUTES))
def test_scenario_route_succeeds_without_throttling(exam_scenario: None, route: str) -> None:
    """The scenario is sound: without throttling, every route succeeds (2xx)."""
    response = SCENARIO_ROUTES[route]()

    assert response["statusCode"] in {200, 201, 204}, response.get("body")


# (route, DynamoDB operation, table) of every call that already answers 503.
ALREADY_BUSY = [
    ("GET /belts", "Scan", BELTS_TABLE_ENV),
    ("GET /students", "Scan", STUDENTS_TABLE_ENV),
    ("GET /students", "Scan", BELTS_TABLE_ENV),
    ("GET /students (responsável)", "Query", STUDENTS_TABLE_ENV),
    ("GET /students (responsável)", "Scan", BELTS_TABLE_ENV),
    ("POST /students", "Scan", BELTS_TABLE_ENV),
    ("GET /students/{id}", "GetItem", STUDENTS_TABLE_ENV),
    ("GET /students/{id}", "Scan", BELTS_TABLE_ENV),
    ("GET /requirements", "Scan", BELTS_TABLE_ENV),
    ("GET /requirements", "Scan", REQUIREMENTS_TABLE_ENV),
    ("GET /requirements?belt_id", "Query", REQUIREMENTS_TABLE_ENV),
    ("POST /requirements", "Scan", BELTS_TABLE_ENV),
    ("POST /requirements", "Query", REQUIREMENTS_TABLE_ENV),
    ("PUT /requirements/{id}", "Scan", BELTS_TABLE_ENV),
    ("GET /events", "Scan", EVENTS_TABLE_ENV),
    ("DELETE /events/{id}", "Query", EXAMS_TABLE_ENV),
    ("POST /events/{id}/exams", "GetItem", STUDENTS_TABLE_ENV),
    ("POST /events/{id}/exams", "GetItem", EXAMS_TABLE_ENV),
    ("POST /events/{id}/exams", "Scan", BELTS_TABLE_ENV),
    ("POST /events/{id}/exams", "TransactWriteItems", EXAMS_TABLE_ENV),
    ("GET /events/{id}/exams", "Query", EXAMS_TABLE_ENV),
    ("GET /events/{id}/exams/{student_id}", "GetItem", EXAMS_TABLE_ENV),
    ("GET /events/{id}/exams/{student_id}", "GetItem", STUDENTS_TABLE_ENV),
    ("GET /events/{id}/exams/{student_id}", "Query", REQUIREMENTS_TABLE_ENV),
    ("GET /events/{id}/exams/{student_id}", "Query", ANSWERS_TABLE_ENV),
    ("PUT .../answers/{requirement_id}", "GetItem", EXAMS_TABLE_ENV),
    ("PUT .../answers/{requirement_id}", "TransactWriteItems", ANSWERS_TABLE_ENV),
    ("DELETE .../answers/{requirement_id}", "GetItem", EXAMS_TABLE_ENV),
    ("DELETE .../answers/{requirement_id}", "TransactWriteItems", ANSWERS_TABLE_ENV),
    ("POST .../decision", "GetItem", SETTINGS_TABLE_ENV),
    ("POST .../decision", "GetItem", EXAMS_TABLE_ENV),
    ("POST .../decision", "GetItem", STUDENTS_TABLE_ENV),
    ("POST .../decision", "TransactWriteItems", EXAMS_TABLE_ENV),
]


@pytest.mark.parametrize(
    ("route", "operation", "table_env"),
    ALREADY_BUSY,
    ids=[f"{route} {operation} {env}" for route, operation, env in ALREADY_BUSY],
)
def test_throttled_call_answers_503_and_writes_nothing(
    exam_scenario: None,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    operation: str,
    table_env: str,
) -> None:
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, operation, table_env)

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    if route not in READ_ONLY_ROUTES:
        assert dynamodb_snapshot() == before


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
@pytest.mark.parametrize(
    ("route", "operation", "table_env"),
    [
        ("POST /events/{id}/exams", "TransactWriteItems", EXAMS_TABLE_ENV),
        ("PUT .../answers/{requirement_id}", "TransactWriteItems", ANSWERS_TABLE_ENV),
        ("POST .../decision", "TransactWriteItems", EXAMS_TABLE_ENV),
    ],
    ids=["attendance", "marking", "decision"],
)
def test_every_throttling_code_of_a_transaction_answers_503(
    exam_scenario: None,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    operation: str,
    table_env: str,
    code: str,
) -> None:
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, operation, table_env, code=code)

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before


@pytest.mark.parametrize("reason", ["ThrottlingError", "ProvisionedThroughputExceeded"])
@pytest.mark.parametrize(
    ("route", "table_env"),
    [
        ("POST /events/{id}/exams", EXAMS_TABLE_ENV),
        ("PUT .../answers/{requirement_id}", ANSWERS_TABLE_ENV),
        ("DELETE .../answers/{requirement_id}", ANSWERS_TABLE_ENV),
        ("POST .../decision", EXAMS_TABLE_ENV),
    ],
    ids=["attendance", "marking", "unmarking", "decision"],
)
def test_transaction_throttled_inside_on_every_attempt_answers_503(
    exam_scenario: None,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    table_env: str,
    reason: str,
) -> None:
    """Throttling inside the transaction is retried a limited number of times, then 503."""
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(
        monkeypatch, "TransactWriteItems", table_env, cancellation_reason=reason
    )

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    assert len(stub.calls) > 1, "throttling inside the transaction is retried"
    assert dynamodb_snapshot() == before


def test_student_names_unprocessed_once_are_read_on_the_next_call(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keys left in ``UnprocessedKeys`` are asked again: the name is not lost."""
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    stub = leave_batch_unprocessed(monkeypatch, STUDENTS_TABLE_ENV, times=1)

    response = SCENARIO_ROUTES["GET /events/{id}/exams"]()

    assert len(stub.calls) == 1
    assert response["statusCode"] == 200, response["body"]
    assert '"student_name": "Ana"' in response["body"]
