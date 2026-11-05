"""Edges of the exam history (RN018, ``GET /students/{id}/exams``) found by the qa (#21).

More than 100 events, partially unprocessed ``BatchGetItem`` keys, repeated
event ids, ``Decimal`` stripes in the JSON, two students in the same events, a
student removed by hand with exams still in the index, odd but valid ids, a
``master`` token without ``admin`` and the route's real AWS calls against the
permissions of ``ListStudentExamsFunction``.
"""

import json
import os
from dataclasses import replace
from datetime import date, timedelta
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import EXAMINER, EXAMINER_SUB, api_event, belt_id, make_student, response_json

from domain.eligibility import ExamKind
from domain.errors import MSG_SERVICE_BUSY
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, ExamStatus, Graduation
from domain.users import MASTER_GROUP, User
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo
from repository import tables
from repository.tables import (
    BELTS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    table,
)

CREATED = "2026-11-01T12:00:00+00:00"
NOT_FOUND = {"message": "Aluno não encontrado"}


def _history(user: User = EXAMINER, student_id: str = "student-1") -> dict[str, Any]:
    return student_handlers.list_student_exams(api_event(user, path={"id": student_id}), None)


def _entries(response: dict[str, Any]) -> list[dict[str, Any]]:
    assert response["statusCode"] == 200, response["body"]
    return response_json(response)


def _create_event(event_id: str, day: date) -> None:
    event_repo.create_event(
        ExamEvent(event_id, f"Exame {event_id}", day, EventStatus.CLOSED, CREATED, CREATED)
    )


def _store_exam(event_id: str, student_id: str = "student-1", *, stripes: int = 0) -> None:
    """Store a decided exam as the attendance and the decision leave it.

    Written straight to the table: the attendance route allows one exam in
    progress per student (RN005), and these tests need many.
    """
    exam = Exam(
        id=f"exam-{event_id}-{student_id}",
        event_id=event_id,
        student_id=student_id,
        target_belt_id=belt_id("Cinza/Azul"),
        kind=ExamKind.BELT,
        status=ExamStatus.FAILED,
        decided_by_id="sensei-1",
        decided_at="2027-01-01T00:00:00+00:00",
        notes=None,
        created_by=EXAMINER_SUB,
        created_at=CREATED,
        source=Graduation(belt_id("Cinza"), date(2026, 3, 14), stripes),
    )
    table(EXAMS_TABLE_ENV).put_item(Item=exam_repo._to_item(exam))


def _student_with_exams(count: int) -> list[str]:
    """Ana with one exam in each of ``count`` events, one week apart; ids oldest first."""
    student_repo.create_student(make_student())
    event_ids = []
    for index in range(count):
        event_id = f"ev-{index:03d}"
        _create_event(event_id, date(2020, 1, 31) + timedelta(weeks=index))
        _store_exam(event_id)
        event_ids.append(event_id)
    return event_ids


def _record_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """Record every AWS call (operation and parameters) from now on."""
    original = BaseClient._make_api_call
    calls: list[tuple[str, dict[str, Any]]] = []

    def recording(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        calls.append((operation_name, dict(api_params)))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", recording)
    return calls


def _event_keys(params: dict[str, Any]) -> list[str]:
    return [key["id"] for key in params["RequestItems"][os.environ[EVENTS_TABLE_ENV]]["Keys"]]


# --- many events and unprocessed keys -------------------------------------


def test_rn018_history_with_more_than_100_events_lists_all_in_order(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    event_ids = _student_with_exams(105)
    calls = _record_calls(monkeypatch)

    entries = _entries(_history())

    assert [entry["event_id"] for entry in entries] == list(reversed(event_ids))
    assert all(entry["event_name"] == f"Exame {entry['event_id']}" for entry in entries)
    batches = [params for operation, params in calls if operation == "BatchGetItem"]
    assert [len(_event_keys(params)) for params in batches] == [100, 5]


def _answer_half(monkeypatch: pytest.MonkeyPatch, partial_calls: set[int]) -> list[dict[str, Any]]:
    """Answer the listed events' ``BatchGetItem`` calls (1-based) with half the keys.

    The first half is read from the table; the second comes back in
    ``UnprocessedKeys``, as DynamoDB does when part of a batch runs out of
    capacity. Other calls go to the table unchanged.
    """
    monkeypatch.setattr(tables.time, "sleep", lambda _seconds: None)
    table_name = os.environ[EVENTS_TABLE_ENV]
    original = BaseClient._make_api_call
    calls: list[dict[str, Any]] = []

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name == "BatchGetItem" and table_name in api_params.get("RequestItems", {}):
            calls.append(dict(api_params))
            request = api_params["RequestItems"][table_name]
            keys = request["Keys"]
            if len(calls) in partial_calls and len(keys) > 1:
                half = len(keys) // 2
                read = {table_name: {**request, "Keys": keys[:half]}}
                response = original(self, operation_name, {"RequestItems": read})
                response["UnprocessedKeys"] = {table_name: {**request, "Keys": keys[half:]}}
                return response
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return calls


def test_rn018_partially_unprocessed_events_are_neither_lost_nor_duplicated(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    event_ids = _student_with_exams(120)
    # First block (100): 50 read, then 25, then the last 25. Second block (20):
    # 10 read, then the other 10.
    calls = _answer_half(monkeypatch, {1, 2, 4})

    entries = _entries(_history())

    assert [entry["event_id"] for entry in entries] == list(reversed(event_ids))
    assert all(entry["event_name"] == f"Exame {entry['event_id']}" for entry in entries)
    assert [len(_event_keys(params)) for params in calls] == [100, 50, 25, 20, 10]
    # Each retry asks exactly the keys left unprocessed by the call before.
    assert _event_keys(calls[1]) == _event_keys(calls[0])[50:]
    assert _event_keys(calls[4]) == _event_keys(calls[3])[10:]


def test_rn018_events_still_partly_unprocessed_after_every_call_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 16 keys: 8, 4, 2 and 1 read; one key is still unprocessed after the 4 calls.
    _student_with_exams(16)
    calls = _answer_half(monkeypatch, {1, 2, 3, 4, 5})

    response = _history()

    assert response["statusCode"] == 503, response["body"]
    assert response_json(response) == {"message": MSG_SERVICE_BUSY}
    assert len(calls) == tables.BATCH_GET_ATTEMPTS


def test_rn018_get_events_with_repeated_ids_asks_each_once(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # BatchGetItem refuses a repeated key (ValidationException, a 500).
    _create_event("e1", date(2027, 3, 20))
    _create_event("e2", date(2027, 9, 25))
    calls = _record_calls(monkeypatch)

    found = event_repo.get_events(["e1", "e2", "e1", "missing", "e2"])

    assert sorted(found) == ["e1", "e2"]
    (batch,) = [params for operation, params in calls if operation == "BatchGetItem"]
    assert sorted(_event_keys(batch)) == ["e1", "e2", "missing"]


# --- types and isolation --------------------------------------------------


def test_rn018_stripes_are_json_integers(seeded: None) -> None:
    # DynamoDB returns numbers as Decimal; 3 == 3.0 in Python, so check the text.
    student_repo.create_student(make_student())
    _create_event("e1", date(2027, 3, 20))
    _store_exam("e1", stripes=3)

    response = _history()

    assert '"stripes": 3,' in response["body"] or '"stripes": 3}' in response["body"]
    (entry,) = json.loads(response["body"])
    assert type(entry["source"]["stripes"]) is int


def test_rn018_students_in_the_same_events_see_only_their_own_exams(seeded: None) -> None:
    student_repo.create_student(make_student())
    student_repo.create_student(
        replace(make_student(owner_id="guardian-2"), id="student-2", full_name="Bia")
    )
    _create_event("e1", date(2027, 3, 20))
    _create_event("e2", date(2027, 9, 25))
    _store_exam("e1", "student-1")
    _store_exam("e1", "student-2", stripes=1)
    _store_exam("e2", "student-2")

    ana = _entries(_history())
    bia = _entries(_history(student_id="student-2"))

    assert [(entry["event_id"], entry["source"]["stripes"]) for entry in ana] == [("e1", 0)]
    assert [(entry["event_id"], entry["source"]["stripes"]) for entry in bia] == [
        ("e2", 0),
        ("e1", 1),
    ]


def test_rn018_student_removed_by_hand_is_404_without_reading_exams(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A student with exams cannot be deleted (RN018); only data removed by
    # hand leaves exams in the index without their student.
    student_repo.create_student(make_student())
    _create_event("e1", date(2027, 3, 20))
    _store_exam("e1")
    table(STUDENTS_TABLE_ENV).delete_item(Key={"id": "student-1"})
    calls = _record_calls(monkeypatch)

    response = _history()

    assert response["statusCode"] == 404, response["body"]
    assert response_json(response) == NOT_FOUND
    assert [operation for operation, _ in calls] == ["GetItem"]


@pytest.mark.parametrize(
    "student_id",
    [
        "student-1/exams",
        "student-1%2Fexams",
        "../student-1",
        "student-1 ",
        "STUDENT-1",
        "Ação",
        "x" * 2048,  # the longest partition key DynamoDB accepts
    ],
    ids=["slash", "encoded-slash", "dot-dot", "trailing-space", "upper", "accents", "2048"],
)
def test_rn018_odd_ids_of_no_student_are_404(seeded: None, student_id: str) -> None:
    student_repo.create_student(make_student())
    _create_event("e1", date(2027, 3, 20))
    _store_exam("e1")

    response = _history(student_id=student_id)

    assert response["statusCode"] == 404, response["body"]
    assert response_json(response) == NOT_FOUND


def test_rn018_master_group_without_admin_is_403(seeded: None) -> None:
    # The master is always in ``admin`` too; ``master`` alone is a
    # misconfigured account and is not an examiner.
    user = User(sub="master-2", email="master@example.com", groups=frozenset({MASTER_GROUP}))

    response = _history(user)

    assert response["statusCode"] == 403, response["body"]
    assert response_json(response) == {"message": "Esta área é dos examinadores"}


# --- calls against the function's permissions -----------------------------


def test_rn018_route_makes_only_the_calls_its_function_may_make(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # ListStudentExamsFunction may only: GetItem on Students, Query on the
    # by_student index of Exams, BatchGetItem on Events and Scan on Belts
    # (test_template.py checks the template). Nothing else, no writes.
    student_repo.create_student(make_student())
    _create_event("e1", date(2027, 3, 20))
    _store_exam("e1")
    calls = _record_calls(monkeypatch)

    assert _entries(_history())

    made = set()
    for operation, params in calls:
        names = set(params.get("RequestItems", {})) | {params.get("TableName")}
        made |= {(operation, name, params.get("IndexName")) for name in names - {None}}
    assert made == {
        ("GetItem", os.environ[STUDENTS_TABLE_ENV], None),
        ("Query", os.environ[EXAMS_TABLE_ENV], "by_student"),
        ("BatchGetItem", os.environ[EVENTS_TABLE_ENV], None),
        ("Scan", os.environ[BELTS_TABLE_ENV], None),
    }
