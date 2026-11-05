"""Safety net of ``api_handler``: DynamoDB throttling that escaped a handler answers 503 (#43).

Every DynamoDB call reachable by a route turns throttling that outlasted
botocore's retries into ``ServiceUnavailableError`` (the ``repository.tables``
helpers and ``raise_if_throttled``). A new call that forgets them used to let
the raw ``ClientError`` reach ``api_handler`` and answer 500 "Erro interno.
Tente de novo.". The net answers 503 with only "Sistema ocupado no momento.
Tente de novo em instantes." for the codes of ``THROTTLING_ERRORS`` and logs,
at ERROR and with the stack trace, the operation and the code, so the call
that escaped can be found in CloudWatch.

Everything else is unchanged: domain errors keep their status, message and
INFO log (the 503 of the helpers included, which the net never logs); other
``ClientError`` codes (``TransactionCanceledException`` included, whatever
its cancellation reasons: transactions handle them where they run) and any
other exception answer 500.
"""

import logging
from datetime import date
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    DYNAMODB_WRITES,
    EXAMINER,
    api_event,
    assert_service_busy,
    dynamodb_snapshot,
    response_json,
    throttle_dynamodb,
)

from domain.errors import (
    MSG_SERVICE_BUSY,
    ConflictError,
    DomainError,
    ForbiddenError,
    NotFoundError,
    PayloadTooLargeError,
    ServiceUnavailableError,
    UnauthorizedError,
    ValidationError,
)
from domain.events import EventStatus, ExamEvent
from handlers import events as event_handlers
from handlers.http import Event, Handler, Response, api_handler, json_response
from repository import events as event_repo
from repository.tables import EVENTS_TABLE_ENV, THROTTLING_ERRORS, raise_if_throttled, table

MSG_INTERNAL = "Erro interno. Tente de novo."
NET_LOGGER = "handlers.http"

# The documented codes (conftest, README) and any code added to the list later.
THROTTLING_CODES = sorted(set(DYNAMODB_THROTTLING_CODES) | THROTTLING_ERRORS)
OTHER_CLIENT_ERROR_CODES = [
    "ConditionalCheckFailedException",
    "TransactionCanceledException",
    "InternalServerError",
    "ValidationException",
    "ResourceNotFoundException",
    "AccessDeniedException",
]


def _client_error(code: str, operation: str = "GetItem", **extra: Any) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "falhou"}, **extra}, operation)


def _raising(exc: BaseException) -> Handler:
    """Return a handler wrapped by ``api_handler`` that raises ``exc``."""

    @api_handler
    def handler(event: Event, context: Any) -> Response:
        raise exc

    return handler


def _call(exc: BaseException) -> Response:
    return _raising(exc)(api_event(EXAMINER), None)


def _net_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Records of the net: ``handlers.http`` at ERROR, other than the 500 log."""
    return [
        record
        for record in caplog.records
        if record.name == NET_LOGGER
        and record.levelno >= logging.ERROR
        and record.getMessage() != "Unhandled error"
    ]


def _unhandled_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == NET_LOGGER and record.getMessage() == "Unhandled error"
    ]


def _assert_internal_error(response: Response) -> None:
    assert response["statusCode"] == 500, response.get("body")
    assert response_json(response) == {"message": MSG_INTERNAL}


# --- Throttling that escaped: 503 with only the busy message ---


@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_throttling_that_escaped_a_handler_is_503(code: str) -> None:
    response = _call(_client_error(code))

    assert response["statusCode"] == 503, response.get("body")
    assert response_json(response) == {"message": MSG_SERVICE_BUSY}
    assert response["headers"]["Content-Type"] == "application/json; charset=utf-8"


@pytest.mark.parametrize("code", sorted(DYNAMODB_THROTTLING_CODES))
def test_modeled_throttling_exception_is_503(code: str) -> None:
    """Botocore raises a modeled subclass of ``ClientError`` for DynamoDB's own codes."""
    modeled = getattr(boto3.client("dynamodb").exceptions, code)
    exc = modeled({"Error": {"Code": code, "Message": "throttled"}}, "Query")

    response = _call(exc)

    assert response["statusCode"] == 503, response.get("body")
    assert response_json(response) == {"message": MSG_SERVICE_BUSY}


@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_net_logs_the_operation_the_code_and_the_stack_trace(
    caplog: pytest.LogCaptureFixture, code: str
) -> None:
    exc = _client_error(code, "UpdateItem")

    def forgotten_dynamodb_call() -> None:
        raise exc

    @api_handler
    def handler(event: Event, context: Any) -> Response:
        forgotten_dynamodb_call()
        return json_response(200, {})

    with caplog.at_level(logging.INFO):
        response = handler(api_event(EXAMINER), None)

    assert response["statusCode"] == 503
    [record] = _net_records(caplog)
    assert record.levelno == logging.ERROR
    assert "UpdateItem" in record.getMessage()
    assert code in record.getMessage()
    assert record.exc_info is not None and record.exc_info[1] is exc
    # The traceback in the log points to the call that escaped.
    assert "forgotten_dynamodb_call" in caplog.text
    assert not _unhandled_records(caplog)


# --- Other ClientError codes: 500, as before ---


@pytest.mark.parametrize("code", OTHER_CLIENT_ERROR_CODES)
def test_other_client_errors_are_500(caplog: pytest.LogCaptureFixture, code: str) -> None:
    with caplog.at_level(logging.INFO):
        response = _call(_client_error(code, "PutItem"))

    _assert_internal_error(response)
    assert len(_unhandled_records(caplog)) == 1
    assert not _net_records(caplog)


@pytest.mark.parametrize("reason", ["ThrottlingError", "ProvisionedThroughputExceeded"])
def test_transaction_cancelled_by_throttling_is_not_handled_by_the_net(
    caplog: pytest.LogCaptureFixture, reason: str
) -> None:
    """Transactions read their cancellation reasons where they run; the net ignores them."""
    exc = _client_error(
        "TransactionCanceledException",
        "TransactWriteItems",
        CancellationReasons=[{"Code": reason}, {"Code": "None"}],
    )

    with caplog.at_level(logging.INFO):
        response = _call(exc)

    _assert_internal_error(response)
    assert not _net_records(caplog)


def test_modeled_transaction_cancelled_is_500() -> None:
    modeled = boto3.client("dynamodb").exceptions.TransactionCanceledException
    exc = modeled(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
            "CancellationReasons": [{"Code": "ThrottlingError"}],
        },
        "TransactWriteItems",
    )

    _assert_internal_error(_call(exc))


def test_client_error_without_code_is_500() -> None:
    """A malformed error answer never breaks the net itself."""
    _assert_internal_error(_call(ClientError({}, "GetItem")))


# --- Any other exception: 500, as before ---


def _wrapped_throttling() -> RuntimeError:
    """A throttling ``ClientError`` wrapped in another exception (only the cause is one)."""
    try:
        raise _client_error("ProvisionedThroughputExceededException")
    except ClientError as cause:
        try:
            raise RuntimeError("falhou") from cause
        except RuntimeError as exc:
            return exc


@pytest.mark.parametrize(
    "exc",
    [
        RuntimeError("falhou"),
        KeyError("id"),
        ValueError("ProvisionedThroughputExceededException"),
        TypeError("falhou"),
        _wrapped_throttling(),
    ],
    ids=["RuntimeError", "KeyError", "ValueError", "TypeError", "wrapped-throttling"],
)
def test_other_exceptions_are_500(caplog: pytest.LogCaptureFixture, exc: Exception) -> None:
    with caplog.at_level(logging.INFO):
        response = _call(exc)

    _assert_internal_error(response)
    assert len(_unhandled_records(caplog)) == 1
    assert not _net_records(caplog)


# --- Domain errors: unchanged ---


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (DomainError("Regra violada"), 400),
        (ValidationError("Campo inválido"), 400),
        (UnauthorizedError("Faça login para continuar"), 401),
        (ForbiddenError("Esta área é dos examinadores"), 403),
        (NotFoundError("Evento não encontrado"), 404),
        (ConflictError("Exame já decidido"), 409),
        (PayloadTooLargeError("Corpo da requisição grande demais"), 413),
        (ServiceUnavailableError(MSG_SERVICE_BUSY), 503),
    ],
    ids=lambda value: type(value).__name__ if isinstance(value, Exception) else str(value),
)
def test_domain_errors_are_unchanged(
    caplog: pytest.LogCaptureFixture, error: DomainError, status: int
) -> None:
    with caplog.at_level(logging.INFO):
        response = _call(error)

    assert response["statusCode"] == status
    assert response_json(response) == {"message": error.message}
    [record] = [record for record in caplog.records if record.name == NET_LOGGER]
    assert record.levelno == logging.INFO
    assert record.getMessage() == f"Request rejected ({status}): {error.message}"


@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_busy_error_of_the_helpers_is_not_logged_by_the_net(
    caplog: pytest.LogCaptureFixture, code: str
) -> None:
    """The 503 of ``raise_if_throttled`` keeps its own path: only the escaped calls are flagged."""

    @api_handler
    def handler(event: Event, context: Any) -> Response:
        raise_if_throttled(_client_error(code), "GetItem on Fake")
        return json_response(200, {})

    with caplog.at_level(logging.INFO):
        response = handler(api_event(EXAMINER), None)

    assert response["statusCode"] == 503
    assert response_json(response) == {"message": MSG_SERVICE_BUSY}
    assert not _net_records(caplog)
    assert not _unhandled_records(caplog)


def test_success_is_unchanged() -> None:
    expected = json_response(200, {"ok": True})

    @api_handler
    def handler(event: Event, context: Any) -> Response:
        return expected

    assert handler(api_event(EXAMINER), None) is expected


# --- End to end: a real route whose repository calls DynamoDB without the helpers ---

EVENT_ID = "event-net"


def _store_event() -> None:
    now = "2026-11-01T12:00:00+00:00"
    event_repo.create_event(
        ExamEvent(EVENT_ID, "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, now, now)
    )


def _raw_get_event(event_id: str) -> ExamEvent | None:
    """``event_repo.get_event`` as a new call that forgot ``get_item_or_busy``."""
    item = table(EVENTS_TABLE_ENV).get_item(Key={"id": event_id}, ConsistentRead=True)
    return event_repo._from_item(item["Item"]) if "Item" in item else None


def _raw_create_event(event: ExamEvent) -> None:
    """``event_repo.create_event`` as a new write that forgot ``raise_if_throttled``."""
    table(EVENTS_TABLE_ENV).put_item(
        Item=event.to_dict(), ConditionExpression="attribute_not_exists(id)"
    )


@pytest.mark.parametrize("code", sorted(DYNAMODB_THROTTLING_CODES))
def test_route_with_a_raw_read_answers_503(
    aws: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, code: str
) -> None:
    _store_event()
    monkeypatch.setattr(event_repo, "get_event", _raw_get_event)
    stub = throttle_dynamodb(monkeypatch, "GetItem", EVENTS_TABLE_ENV, code=code, active=False)

    def get_event() -> Response:
        return event_handlers.get_event(api_event(EXAMINER, path={"id": EVENT_ID}), None)

    # The route really goes through the raw call.
    assert get_event()["statusCode"] == 200
    stub.active = True
    with caplog.at_level(logging.INFO):
        response = get_event()

    assert_service_busy(response, stub)
    [record] = _net_records(caplog)
    assert "GetItem" in record.getMessage()
    assert code in record.getMessage()
    assert "_raw_get_event" in caplog.text


def test_route_with_a_raw_write_answers_503_and_writes_nothing(
    aws: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(event_repo, "create_event", _raw_create_event)
    stub = throttle_dynamodb(monkeypatch, DYNAMODB_WRITES, EVENTS_TABLE_ENV, active=False)

    def create_event(name: str) -> Response:
        body = {"name": name, "exam_date": "2027-09-25"}
        return event_handlers.create_event(api_event(EXAMINER, body=body), None)

    assert create_event("Exame agosto/2027")["statusCode"] == 201
    before = dynamodb_snapshot()
    stub.active = True
    with caplog.at_level(logging.INFO):
        response = create_event("Exame setembro/2027")
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before
    [record] = _net_records(caplog)
    assert "PutItem" in record.getMessage()
    assert "ProvisionedThroughputExceededException" in record.getMessage()


def test_route_with_a_raw_call_and_another_error_stays_500(
    aws: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def failing_get_event(event_id: str) -> ExamEvent | None:
        raise _client_error("ValidationException", "GetItem")

    monkeypatch.setattr(event_repo, "get_event", failing_get_event)

    with caplog.at_level(logging.INFO):
        response = event_handlers.get_event(api_event(EXAMINER, path={"id": EVENT_ID}), None)

    _assert_internal_error(response)
    assert not _net_records(caplog)
