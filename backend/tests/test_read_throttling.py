"""Throttled reads: paginated scans/queries and ``event_has_exams`` answer 503.

Throttling that outlasted botocore's retries becomes ``ServiceUnavailableError``
(503 "Sistema ocupado no momento. Tente de novo em instantes."); any other
DynamoDB error leaves the repository unchanged, as a ``ClientError``.
"""

import logging
from collections.abc import Callable
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, response_json

from domain.errors import MSG_SERVICE_BUSY, ServiceUnavailableError
from handlers import events as event_handlers
from repository import answers as answer_repo
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import EVENTS_TABLE_ENV, EXAMS_TABLE_ENV, paginate, table

THROTTLING_CODES = [
    "ProvisionedThroughputExceededException",
    "ThrottlingException",
    "RequestLimitExceeded",
]


def _error(code: str, operation: str = "Scan") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "x"}}, operation)


class _FakeTable:
    """A table whose ``scan`` returns ``pages`` in order, raising any exception in it."""

    name = "Fake"

    def __init__(self, pages: list[dict[str, Any] | Exception]) -> None:
        self._pages = pages
        self.calls: list[dict[str, Any]] = []

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(dict(kwargs))
        page = self._pages[len(self.calls) - 1]
        if isinstance(page, Exception):
            raise page
        return page


@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_paginate_throttled_first_page_is_busy(code: str) -> None:
    fake = _FakeTable([_error(code)])
    with pytest.raises(ServiceUnavailableError) as raised:
        list(paginate(fake.scan))
    assert str(raised.value) == MSG_SERVICE_BUSY


@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_paginate_throttled_later_page_is_busy(code: str) -> None:
    fake = _FakeTable([{"Items": [{"id": "a"}], "LastEvaluatedKey": {"id": "a"}}, _error(code)])
    with pytest.raises(ServiceUnavailableError):
        list(paginate(fake.scan))
    assert fake.calls[1]["ExclusiveStartKey"] == {"id": "a"}


def test_paginate_other_error_stays_client_error() -> None:
    fake = _FakeTable([_error("ResourceNotFoundException")])
    with pytest.raises(ClientError) as raised:
        list(paginate(fake.scan))
    assert raised.value.response["Error"]["Code"] == "ResourceNotFoundException"


def test_paginate_logs_operation_table_and_index(caplog: pytest.LogCaptureFixture) -> None:
    fake = _FakeTable([_error("ThrottlingException")])
    with caplog.at_level(logging.WARNING), pytest.raises(ServiceUnavailableError):
        list(paginate(fake.scan, IndexName="by_x"))
    assert "Scan on Fake (index by_x) throttled" in caplog.text


def test_paginate_follows_pages() -> None:
    fake = _FakeTable(
        [
            {"Items": [{"id": "a"}], "LastEvaluatedKey": {"id": "a"}},
            {"Items": [{"id": "b"}]},
        ]
    )
    assert [item["id"] for item in paginate(fake.scan)] == ["a", "b"]


class _ThrottledTable:
    """The real table, with ``operation`` always throttled with ``code``."""

    def __init__(self, real: Any, operation: str, code: str) -> None:
        self._real = real
        self._operation = operation
        self._code = code

    def __getattr__(self, name: str) -> Any:
        if name != self._operation:
            return getattr(self._real, name)

        def throttled(**kwargs: Any) -> Any:
            raise _error(self._code, name)

        return throttled


def _throttle(
    monkeypatch: pytest.MonkeyPatch, module: Any, operation: str, code: str, env: str | None = None
) -> None:
    real_table = module.table
    monkeypatch.setattr(
        module,
        "table",
        lambda name: (
            _ThrottledTable(real_table(name), operation, code)
            if env is None or name == env
            else real_table(name)
        ),
    )


PAGINATED_READS: list[tuple[Any, str, Callable[[], Any]]] = [
    (belt_repo, "scan", belt_repo.list_belts),
    (student_repo, "scan", student_repo.list_all),
    (student_repo, "query", lambda: student_repo.list_by_owner("owner-1")),
    (exam_repo, "query", lambda: exam_repo.list_by_event("event-1")),
    (event_repo, "scan", event_repo.list_all),
    (requirement_repo, "scan", requirement_repo.list_all),
    (requirement_repo, "query", lambda: requirement_repo.list_by_belt("belt-1")),
    (answer_repo, "query", lambda: answer_repo.list_by_exam("exam-1")),
]


@pytest.mark.parametrize(
    ("module", "operation", "read"),
    PAGINATED_READS,
    ids=[
        "list_belts",
        "students.list_all",
        "students.list_by_owner",
        "exams.list_by_event",
        "events.list_all",
        "requirements.list_all",
        "requirements.list_by_belt",
        "answers.list_by_exam",
    ],
)
@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_paginated_reads_throttled_are_busy(
    aws: None,
    monkeypatch: pytest.MonkeyPatch,
    module: Any,
    operation: str,
    read: Callable[[], Any],
    code: str,
) -> None:
    _throttle(monkeypatch, module, operation, code)
    with pytest.raises(ServiceUnavailableError):
        read()


@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_event_has_exams_throttled_is_busy(
    aws: None, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    _throttle(monkeypatch, exam_repo, "query", code, EXAMS_TABLE_ENV)
    with pytest.raises(ServiceUnavailableError):
        exam_repo.event_has_exams("event-1")


def test_event_has_exams_other_error_stays_client_error(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _throttle(monkeypatch, exam_repo, "query", "ValidationException", EXAMS_TABLE_ENV)
    with pytest.raises(ClientError):
        exam_repo.event_has_exams("event-1")


@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_rn016_delete_event_throttled_exams_query_is_503_and_keeps_event(
    aws: None, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    created = event_handlers.create_event(
        api_event(EXAMINER, body={"name": "Exame março/2027", "exam_date": "2027-03-20"}), None
    )
    event_id = response_json(created)["id"]
    _throttle(monkeypatch, exam_repo, "query", code, EXAMS_TABLE_ENV)

    response = event_handlers.delete_event(api_event(EXAMINER, path={"id": event_id}), None)

    assert response["statusCode"] == 503
    assert response_json(response)["message"] == MSG_SERVICE_BUSY
    assert table(EVENTS_TABLE_ENV).get_item(Key={"id": event_id}).get("Item") is not None
