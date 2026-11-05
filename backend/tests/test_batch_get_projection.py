"""Projection of ``tables.batch_get`` (#43).

``students.get_names`` now reads through ``tables.batch_get`` (limited retries
of the unprocessed keys). The names still read only ``id`` and ``full_name``,
also on the retries; the history's events (RN018), the helper's other caller,
still read whole items.
"""

import os
from datetime import date
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import make_student

from domain.events import EventStatus, ExamEvent
from repository import events as event_repo
from repository import students as student_repo
from repository import tables
from repository.tables import EVENTS_TABLE_ENV, STUDENTS_TABLE_ENV, table

CREATED = "2026-11-01T12:00:00+00:00"


def _record_batches(
    monkeypatch: pytest.MonkeyPatch, table_env: str, *, unprocessed_times: int = 0
) -> list[dict[str, Any]]:
    """Record the table's ``BatchGetItem`` requests.

    The first ``unprocessed_times`` calls come back with every key in
    ``UnprocessedKeys``, as DynamoDB answers when the batch ran out of capacity.
    """
    monkeypatch.setattr(tables.time, "sleep", lambda _seconds: None)
    table_name = os.environ[table_env]
    original = BaseClient._make_api_call
    requests: list[dict[str, Any]] = []

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name == "BatchGetItem" and table_name in api_params.get("RequestItems", {}):
            requests.append(dict(api_params["RequestItems"][table_name]))
            if len(requests) <= unprocessed_times:
                return {
                    "Responses": {table_name: []},
                    "UnprocessedKeys": api_params["RequestItems"],
                }
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return requests


def _projected_attributes(request: dict[str, Any]) -> set[str]:
    names = request["ExpressionAttributeNames"]
    return {names[name.strip()] for name in request["ProjectionExpression"].split(",")}


def test_student_names_read_only_id_and_full_name_also_on_retries(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student_repo.create_student(make_student())
    requests = _record_batches(monkeypatch, STUDENTS_TABLE_ENV, unprocessed_times=1)

    names = student_repo.get_names(["student-1", "missing", "student-1"])

    assert names == {"student-1": "Ana"}
    assert len(requests) == 2
    assert all(_projected_attributes(request) == {"id", "full_name"} for request in requests)


def test_batch_get_with_attributes_returns_only_them(aws: None) -> None:
    student_repo.create_student(make_student())

    items = tables.batch_get(
        table(STUDENTS_TABLE_ENV), [{"id": "student-1"}], attributes=("id", "full_name")
    )

    assert items == [{"id": "student-1", "full_name": "Ana"}]


def test_rn018_history_events_still_read_whole_items(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = ExamEvent(
        id="event-1",
        name="Exame março/2027",
        exam_date=date(2027, 3, 20),
        status=EventStatus.OPEN,
        created_at=CREATED,
        updated_at=CREATED,
    )
    event_repo.create_event(exam_event)
    requests = _record_batches(monkeypatch, EVENTS_TABLE_ENV)

    events = event_repo.get_events(["event-1"])

    assert events == {"event-1": exam_event}
    assert [set(request) for request in requests] == [{"Keys"}]
