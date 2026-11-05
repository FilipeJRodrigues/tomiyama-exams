"""Exam history of a student (RN018): ``GET /students/{id}/exams``, examiners only.

Every exam stays in the history, newest first by the event date (ties: newest
attendance first), with the event's name and date, the target belt's name, the
kind, the status and the decision. The target belt and the source graduation
are the ones stored at the attendance, so a later belt change never alters an
old exam. Only examiners see it: a guardian, even the owner, gets 403 before
any read. Persistent throttling on any read is a 503; other DynamoDB errors
stay a generic 500.
"""

import os
from dataclasses import replace
from datetime import date
from typing import Any

import boto3
import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    EXAMINER_SUB,
    GUARDIAN,
    MASTER,
    OTHER_GUARDIAN,
    api_event,
    belt,
    belt_id,
    lag_eventual_reads,
    make_student,
    response_json,
)

from domain import dates
from domain import exams as exam_rules
from domain import history as history_rules
from domain.belts import SEED_BELTS
from domain.eligibility import ExamKind
from domain.errors import MSG_SERVICE_BUSY
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, ExamStatus, Graduation
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository import tables
from repository.tables import (
    BELTS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    table,
)

STUDENT_ID = "student-1"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
NOT_EXAMINER = "Esta área é dos examinadores"
NOT_FOUND = "Aluno não encontrado"
INTERNAL = "Erro interno. Tente de novo."
CREATED = "2026-11-01T12:00:00+00:00"
BELTS_BY_ID = {item.id: item for item in SEED_BELTS}

# Fields of each history entry: no score, no answers.
ENTRY_FIELDS = {
    "event_id",
    "event_name",
    "exam_date",
    "target_belt_id",
    "target_belt_name",
    "kind",
    "status",
    "decided_by_id",
    "decided_at",
    "notes",
    "created_at",
    "source",
}

# Events created out of date order (and with ids out of date order), so neither
# the creation nor the by_student index order (event_id) matches the history's.
MARCH = ExamEvent(
    "event-a", "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, CREATED, CREATED
)
SEPTEMBER = ExamEvent(
    "event-z", "Exame setembro/2027", date(2027, 9, 25), EventStatus.OPEN, CREATED, CREATED
)
DECEMBER = ExamEvent(
    "event-m", "Exame dezembro/2027", date(2027, 12, 11), EventStatus.OPEN, CREATED, CREATED
)

MARCH_APPROVED = {
    "event_id": "event-a",
    "event_name": "Exame março/2027",
    "exam_date": "2027-03-20",
    "target_belt_id": belt_id("Cinza/Azul"),
    "target_belt_name": "Cinza/Azul",
    "kind": "BELT",
    "status": "APPROVED",
    "decided_by_id": "sensei-1",
    "decided_at": "2027-03-20T15:00:00+00:00",
    "notes": "Ótimo ukemi",
    "created_at": "2027-03-20T12:00:00+00:00",
    "source": {
        "belt_id": belt_id("Cinza"),
        "belt_name": "Cinza",
        "belt_since": "2026-03-14",
        "stripes": 0,
    },
}
SEPTEMBER_FAILED = {
    "event_id": "event-z",
    "event_name": "Exame setembro/2027",
    "exam_date": "2027-09-25",
    "target_belt_id": belt_id("Azul"),
    "target_belt_name": "Azul",
    "kind": "BELT",
    "status": "FAILED",
    "decided_by_id": "sensei-1",
    "decided_at": "2027-09-25T15:00:00+00:00",
    "notes": "Treinar as quedas",
    "created_at": "2027-09-25T12:00:00+00:00",
    "source": {
        "belt_id": belt_id("Cinza/Azul"),
        "belt_name": "Cinza/Azul",
        "belt_since": "2027-03-20",
        "stripes": 0,
    },
}


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Fixed today (after every event used here) and a settable UTC now."""
    now = {"iso": CREATED}
    monkeypatch.setattr(dates, "today", lambda: date(2027, 10, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: now["iso"])
    return now


def _history(user: User | None = EXAMINER, student_id: str = STUDENT_ID) -> dict[str, Any]:
    return student_handlers.list_student_exams(api_event(user, path={"id": student_id}), None)


def _entries(response: dict[str, Any]) -> list[dict[str, Any]]:
    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert isinstance(body, list)
    return body


def _assert_error(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response) == {"message": message}


def _confirm(clock: dict[str, str], exam_event: ExamEvent, at: str) -> None:
    clock["iso"] = at
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": STUDENT_ID}), None
    )
    assert response["statusCode"] == 201, response["body"]


def _decide(clock: dict[str, str], exam_event: ExamEvent, at: str, body: dict[str, Any]) -> None:
    clock["iso"] = at
    path = {"id": exam_event.id, "student_id": STUDENT_ID}
    response = exam_handlers.decide_exam(api_event(SENSEI, path=path, body=body), None)
    assert response["statusCode"] == 200, response["body"]


def _student_body(student: Student, **changes: Any) -> dict[str, Any]:
    body = {
        "full_name": student.full_name,
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "federation_id": student.federation_id,
        "active": student.active,
    }
    return {**body, **changes}


def _edit_student(**changes: Any) -> None:
    stored = student_repo.get_student(STUDENT_ID)
    assert stored is not None
    response = student_handlers.update_student(
        api_event(EXAMINER, path={"id": STUDENT_ID}, body=_student_body(stored, **changes)), None
    )
    assert response["statusCode"] == 200, response["body"]


@pytest.fixture
def two_decided(seeded: None, clock: dict[str, str]) -> None:
    """Ana: approved to Cinza/Azul in March, failed towards Azul in September.

    Both through the real attendance and decision routes; the approval moves
    her from Cinza to Cinza/Azul (RN009).
    """
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=CREATED,
        )
    )
    student_repo.create_student(make_student())
    for exam_event in (SEPTEMBER, MARCH):
        event_repo.create_event(exam_event)
    _confirm(clock, MARCH, "2027-03-20T12:00:00+00:00")
    _decide(
        clock, MARCH, "2027-03-20T15:00:00+00:00", {"result": "APPROVED", "notes": "Ótimo ukemi"}
    )
    _confirm(clock, SEPTEMBER, "2027-09-25T12:00:00+00:00")
    _decide(
        clock,
        SEPTEMBER,
        "2027-09-25T15:00:00+00:00",
        {"result": "FAILED", "notes": "Treinar as quedas"},
    )


def _confirm_in_december(clock: dict[str, str]) -> None:
    event_repo.create_event(DECEMBER)
    _confirm(clock, DECEMBER, "2027-10-01T09:00:00+00:00")


# --- domain ---------------------------------------------------------------

CINZA_SOURCE = Graduation(belt_id("Cinza"), date(2026, 3, 14), 0)


def _exam(
    event_id: str,
    created_at: str,
    *,
    target: str = "Cinza/Azul",
    source: Graduation | None = CINZA_SOURCE,
) -> Exam:
    return Exam(
        id=f"exam-{event_id}",
        event_id=event_id,
        student_id=STUDENT_ID,
        target_belt_id=belt_id(target),
        kind=ExamKind.BELT,
        status=ExamStatus.IN_PROGRESS,
        decided_by_id=None,
        decided_at=None,
        notes=None,
        created_by=EXAMINER_SUB,
        created_at=created_at,
        source=source,
    )


def _event(event_id: str, day: date) -> ExamEvent:
    return ExamEvent(event_id, f"Exame {event_id}", day, EventStatus.CLOSED, CREATED, CREATED)


def _order(exams: list[Exam], events: list[ExamEvent]) -> list[str]:
    events_by_id = {item.id: item for item in events}
    entries = history_rules.student_history(exams, events_by_id, BELTS_BY_ID)
    return [entry["event_id"] for entry in entries]


def test_rn018_history_lists_newest_exam_date_first() -> None:
    exams = [_exam("e1", "2027-01-01T00:00:00+00:00"), _exam("e2", "2026-01-01T00:00:00+00:00")]
    events = [_event("e1", date(2026, 3, 1)), _event("e2", date(2027, 3, 1))]

    # The later exam date wins even over a later attendance.
    assert _order(exams, events) == ["e2", "e1"]


def test_rn018_history_same_date_lists_newest_attendance_first() -> None:
    exams = [_exam("e1", "2027-03-20T09:00:00+00:00"), _exam("e2", "2027-03-20T08:00:00+00:00")]
    events = [_event("e1", date(2027, 3, 20)), _event("e2", date(2027, 3, 20))]

    assert _order(exams, events) == ["e1", "e2"]
    assert _order(list(reversed(exams)), events) == ["e1", "e2"]


def test_rn018_history_exam_without_event_goes_last_with_null_name_and_date() -> None:
    exams = [
        _exam("gone-old", "2026-01-01T00:00:00+00:00"),
        _exam("kept", "2026-06-01T00:00:00+00:00"),
        _exam("gone-new", "2027-01-01T00:00:00+00:00"),
    ]
    events_by_id = {"kept": _event("kept", date(2026, 6, 1))}

    entries = history_rules.student_history(exams, events_by_id, BELTS_BY_ID)

    assert [entry["event_id"] for entry in entries] == ["kept", "gone-new", "gone-old"]
    assert entries[1]["event_name"] is None
    assert entries[1]["exam_date"] is None


def test_rn018_history_missing_belt_has_null_name() -> None:
    belts_by_id = {key: value for key, value in BELTS_BY_ID.items() if key != belt_id("Cinza")}
    exam = _exam("e1", CREATED)

    entry = history_rules.history_entry(exam, _event("e1", date(2027, 3, 20)), belts_by_id)

    assert entry["target_belt_name"] == "Cinza/Azul"
    assert entry["source"] == {
        "belt_id": belt_id("Cinza"),
        "belt_name": None,
        "belt_since": "2026-03-14",
        "stripes": 0,
    }


def test_rn018_history_source_is_null_for_exams_confirmed_before_it_was_stored() -> None:
    entry = history_rules.history_entry(
        _exam("e1", CREATED, source=None), _event("e1", date(2027, 3, 20)), BELTS_BY_ID
    )

    assert entry["source"] is None
    assert set(entry) == ENTRY_FIELDS


# --- route: content and order ---------------------------------------------


def test_rn018_examiner_sees_history_newest_first_with_names(two_decided: None) -> None:
    entries = _entries(_history())

    assert entries == [SEPTEMBER_FAILED, MARCH_APPROVED]
    assert all(set(entry) == ENTRY_FIELDS for entry in entries)


def test_rn018_master_sees_history_as_any_examiner(two_decided: None) -> None:
    assert _entries(_history(MASTER)) == [SEPTEMBER_FAILED, MARCH_APPROVED]


def test_rn018_approved_and_failed_exams_show_the_decision(two_decided: None) -> None:
    september, march = _entries(_history())

    assert (march["status"], march["decided_by_id"]) == ("APPROVED", "sensei-1")
    assert (march["decided_at"], march["notes"]) == ("2027-03-20T15:00:00+00:00", "Ótimo ukemi")
    assert (september["status"], september["decided_by_id"]) == ("FAILED", "sensei-1")
    assert september["decided_at"] == "2027-09-25T15:00:00+00:00"
    assert september["notes"] == "Treinar as quedas"


def test_rn018_history_kept_after_the_student_changes_belt(
    two_decided: None, clock: dict[str, str]
) -> None:
    # The March approval already moved Ana from Cinza to Cinza/Azul (RN009);
    # an examiner now moves her again, to Azul.
    before = _entries(_history())
    _edit_student(current_belt_id=belt_id("Azul"), current_belt_since="2027-09-30", stripes=0)

    after = _entries(_history())

    assert after == before == [SEPTEMBER_FAILED, MARCH_APPROVED]
    assert after[1]["target_belt_id"] == belt_id("Cinza/Azul")
    assert after[1]["source"]["belt_id"] == belt_id("Cinza")


def test_rn018_exam_in_progress_is_listed_first(two_decided: None, clock: dict[str, str]) -> None:
    _confirm_in_december(clock)

    entries = _entries(_history())

    assert [entry["event_id"] for entry in entries] == ["event-m", "event-z", "event-a"]
    assert entries[0] == {
        "event_id": "event-m",
        "event_name": "Exame dezembro/2027",
        "exam_date": "2027-12-11",
        "target_belt_id": belt_id("Azul"),
        "target_belt_name": "Azul",
        "kind": "BELT",
        "status": "IN_PROGRESS",
        "decided_by_id": None,
        "decided_at": None,
        "notes": None,
        "created_at": "2027-10-01T09:00:00+00:00",
        "source": SEPTEMBER_FAILED["source"],
    }


def test_rn018_stripe_exam_keeps_its_target_and_source(seeded: None, clock: dict[str, str]) -> None:
    # Verde with no stripes → stripe exam with the Roxa items (RN004); approved,
    # the student stays Verde with one stripe.
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city=None,
            updated_at=CREATED,
        )
    )
    student_repo.create_student(
        make_student(belt_name="Verde", birth=date(2010, 1, 1), since=date(2026, 6, 1))
    )
    event_repo.create_event(MARCH)
    _confirm(clock, MARCH, "2027-03-20T12:00:00+00:00")
    _decide(clock, MARCH, "2027-03-20T15:00:00+00:00", {"result": "APPROVED"})

    (entry,) = _entries(_history())

    assert (entry["kind"], entry["status"], entry["notes"]) == ("STRIPE", "APPROVED", None)
    assert (entry["target_belt_id"], entry["target_belt_name"]) == (belt_id("Roxa"), "Roxa")
    assert entry["source"] == {
        "belt_id": belt_id("Verde"),
        "belt_name": "Verde",
        "belt_since": "2026-06-01",
        "stripes": 0,
    }


def test_rn018_student_without_exams_has_empty_history(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student_repo.create_student(make_student())
    calls = _record_calls(monkeypatch)

    assert _entries(_history()) == []
    # Nothing to name: neither the events nor the belts are read.
    assert [operation for operation, _ in calls] == ["GetItem", "Query"]


def test_rn018_inactive_student_keeps_history(two_decided: None, clock: dict[str, str]) -> None:
    _edit_student(active=False)

    assert _entries(_history()) == [SEPTEMBER_FAILED, MARCH_APPROVED]


def test_rn018_history_is_only_of_the_requested_student(
    two_decided: None, clock: dict[str, str]
) -> None:
    other = replace(make_student(), id="student-2", full_name="Bia")
    student_repo.create_student(other)

    assert _entries(_history(student_id="student-2")) == []
    assert len(_entries(_history())) == 2


def test_rn018_event_or_belt_gone_gives_null_names(two_decided: None) -> None:
    # Neither can be deleted through the API (RN016, no belt deletion); only
    # data removed by hand reaches this.
    table(EVENTS_TABLE_ENV).delete_item(Key={"id": SEPTEMBER.id})
    table(BELTS_TABLE_ENV).delete_item(Key={"id": belt_id("Cinza/Azul")})

    march, september = _entries(_history())

    # Without its event, the September exam has no date and goes last.
    assert (september["event_id"], september["event_name"]) == ("event-z", None)
    assert september["exam_date"] is None
    assert september["source"]["belt_name"] is None
    assert september["target_belt_name"] == "Azul"
    assert (march["event_name"], march["exam_date"]) == ("Exame março/2027", "2027-03-20")
    assert (march["target_belt_id"], march["target_belt_name"]) == (belt_id("Cinza/Azul"), None)
    assert march["source"]["belt_name"] == "Cinza"


# --- route: authorization and 404 -----------------------------------------


def _record_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """Record every AWS call (operation and parameters) from now on."""
    original = BaseClient._make_api_call
    calls: list[tuple[str, dict[str, Any]]] = []

    def recording(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        calls.append((operation_name, dict(api_params)))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", recording)
    return calls


@pytest.mark.parametrize("user", [GUARDIAN, OTHER_GUARDIAN], ids=["owner", "other-guardian"])
def test_rn018_guardian_gets_403_before_any_read(
    two_decided: None, monkeypatch: pytest.MonkeyPatch, user: User
) -> None:
    calls = _record_calls(monkeypatch)

    _assert_error(_history(user), 403, NOT_EXAMINER)
    assert calls == []


def test_rn018_guardian_gets_403_even_for_unknown_student(aws: None) -> None:
    _assert_error(_history(GUARDIAN, student_id="missing"), 403, NOT_EXAMINER)


def test_rn018_history_requires_login(aws: None) -> None:
    _assert_error(_history(None), 401, "Faça login para continuar")


def test_rn018_unknown_student_is_404(seeded: None) -> None:
    _assert_error(_history(student_id="missing"), 404, NOT_FOUND)


def test_rn018_student_read_is_strongly_consistent(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A student created a moment ago is seen: an eventually consistent read
    # could still miss it and answer a false 404 (#78).
    gets = lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    student_repo.create_student(make_student())

    assert _entries(_history()) == []
    assert gets and all(call.get("ConsistentRead") is True for call in gets)


def test_rn018_student_detail_does_not_read_the_history(
    two_decided: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # GET /students/{id} (the edit form) stays as it was: no exam is read.
    calls = _record_calls(monkeypatch)

    response = student_handlers.get_student(api_event(EXAMINER, path={"id": STUDENT_ID}), None)

    assert response["statusCode"] == 200, response["body"]
    assert "exams" not in response_json(response)
    exams_table = os.environ[EXAMS_TABLE_ENV]
    assert all(params.get("TableName") != exams_table for _, params in calls)


# --- route: reads ---------------------------------------------------------


class _OneExamPerPage:
    """The real exams table, with every ``query`` limited to one item per page."""

    def __init__(self, real: Any) -> None:
        self._real = real
        self.calls: list[dict[str, Any]] = []

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def query(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        return self._real.query(**kwargs, Limit=1)


def test_rn018_history_follows_every_page_of_the_index(
    two_decided: None, clock: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _confirm_in_december(clock)
    real_table = exam_repo.table
    wrapped: list[_OneExamPerPage] = []

    def one_per_page(env: str) -> Any:
        if env != EXAMS_TABLE_ENV:
            return real_table(env)
        wrapped.append(_OneExamPerPage(real_table(env)))
        return wrapped[-1]

    monkeypatch.setattr(exam_repo, "table", one_per_page)

    entries = _entries(_history())

    assert [entry["event_id"] for entry in entries] == ["event-m", "event-z", "event-a"]
    calls = [call for item in wrapped for call in item.calls]
    assert len(calls) >= 3
    assert all(call["IndexName"] == "by_student" for call in calls)
    # The route itself never cuts the history, and a GSI has no strong reads.
    assert "Limit" not in calls[0]
    assert "ConsistentRead" not in calls[0]
    assert "ExclusiveStartKey" not in calls[0]
    assert all("ExclusiveStartKey" in call for call in calls[1:])


def test_rn018_events_are_read_in_one_batch(
    two_decided: None, clock: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _confirm_in_december(clock)
    calls = _record_calls(monkeypatch)

    _entries(_history())

    operations = [operation for operation, _ in calls]
    assert operations.count("BatchGetItem") == 1
    assert "GetItem" in operations  # the student, once
    assert operations.count("GetItem") == 1
    (batch,) = [params for operation, params in calls if operation == "BatchGetItem"]
    keys = batch["RequestItems"][os.environ[EVENTS_TABLE_ENV]]["Keys"]
    assert sorted(key["id"] for key in keys) == ["event-a", "event-m", "event-z"]


def test_batch_get_splits_in_blocks_of_100_and_skips_missing_keys(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    for event_id in ("e-000", "e-050", "e-100"):
        event_repo.create_event(replace(MARCH, id=event_id))
    calls = _record_calls(monkeypatch)

    found = event_repo.get_events(f"e-{index:03d}" for index in range(101))

    assert sorted(found) == ["e-000", "e-050", "e-100"]
    assert found["e-100"].name == "Exame março/2027"
    batches = [params for operation, params in calls if operation == "BatchGetItem"]
    sizes = [
        len(params["RequestItems"][os.environ[EVENTS_TABLE_ENV]]["Keys"]) for params in batches
    ]
    assert sizes == [100, 1]


# --- route: throttling and other errors -----------------------------------

THROTTLING_CODES = [
    "ProvisionedThroughputExceededException",
    "ThrottlingException",
    "RequestLimitExceeded",
]
# Every read of the route: (operation, table); the Query is the by_student index.
READS = [
    ("GetItem", STUDENTS_TABLE_ENV),
    ("Query", EXAMS_TABLE_ENV),
    ("BatchGetItem", EVENTS_TABLE_ENV),
    ("Scan", BELTS_TABLE_ENV),
]
READ_IDS = ["student", "exams-by-student", "events", "belts"]


@pytest.fixture
def one_exam(seeded: None, clock: dict[str, str]) -> None:
    """Ana with one exam in progress, written by the attendance transaction."""
    student = make_student()
    student_repo.create_student(student)
    event_repo.create_event(MARCH)
    exam = exam_rules.confirm_attendance(
        MARCH, student, belt_repo.list_belts(), confirmed_by=EXAMINER_SUB, now_iso=CREATED
    )
    exam_repo.create_exam(exam, student)


def _refuse(
    monkeypatch: pytest.MonkeyPatch, operation: str, table_env: str, code: str
) -> list[dict[str, Any]]:
    """Make every ``operation`` on the table fail with ``code``, as after botocore's retries."""
    table_name = os.environ[table_env]
    original = BaseClient._make_api_call
    refused: list[dict[str, Any]] = []

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        targets = set(api_params.get("RequestItems", {})) | {api_params.get("TableName")}
        if operation_name == operation and table_name in targets:
            refused.append(dict(api_params))
            raise ClientError({"Error": {"Code": code, "Message": "x"}}, operation_name)
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return refused


@pytest.mark.parametrize(("operation", "table_env"), READS, ids=READ_IDS)
@pytest.mark.parametrize("code", THROTTLING_CODES)
def test_rn018_throttled_read_is_503(
    one_exam: None, monkeypatch: pytest.MonkeyPatch, operation: str, table_env: str, code: str
) -> None:
    refused = _refuse(monkeypatch, operation, table_env, code)

    _assert_error(_history(), 503, MSG_SERVICE_BUSY)
    assert refused
    if operation == "Query":
        assert refused[0]["IndexName"] == "by_student"


@pytest.mark.parametrize(("operation", "table_env"), READS, ids=READ_IDS)
def test_rn018_other_dynamodb_error_stays_a_500(
    one_exam: None, monkeypatch: pytest.MonkeyPatch, operation: str, table_env: str
) -> None:
    refused = _refuse(monkeypatch, operation, table_env, "ValidationException")

    _assert_error(_history(), 500, INTERNAL)
    assert refused


def _unprocessed_events(
    monkeypatch: pytest.MonkeyPatch, *, times: int | None
) -> list[dict[str, Any]]:
    """Answer the events' ``BatchGetItem`` with every key unprocessed.

    Args:
        times: How many calls get that answer before the real table answers;
            None for every call (capacity that never comes back).
    """
    table_name = os.environ[EVENTS_TABLE_ENV]
    original = BaseClient._make_api_call
    calls: list[dict[str, Any]] = []

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name == "BatchGetItem" and table_name in api_params.get("RequestItems", {}):
            calls.append(dict(api_params))
            if times is None or len(calls) <= times:
                return {
                    "Responses": {table_name: []},
                    "UnprocessedKeys": api_params["RequestItems"],
                }
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return calls


def test_rn018_unprocessed_events_are_asked_again_with_backoff(
    one_exam: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    waits: list[float] = []
    monkeypatch.setattr(tables.time, "sleep", waits.append)
    calls = _unprocessed_events(monkeypatch, times=2)

    (entry,) = _entries(_history())

    assert entry["event_name"] == "Exame março/2027"
    assert len(calls) == 3
    assert len(waits) == 2
    assert 0 < waits[0] < waits[1]


def test_rn018_events_still_unprocessed_after_every_retry_is_503(
    one_exam: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    waits: list[float] = []
    monkeypatch.setattr(tables.time, "sleep", waits.append)
    calls = _unprocessed_events(monkeypatch, times=None)

    _assert_error(_history(), 503, MSG_SERVICE_BUSY)
    assert len(calls) == tables.BATCH_GET_ATTEMPTS
    assert len(waits) == tables.BATCH_GET_ATTEMPTS - 1
    # Short enough for the function's 10 s timeout, even at the top of the jitter.
    assert sum(waits) < 1


def test_rn018_history_reads_the_exam_as_stored(one_exam: None) -> None:
    # Fields written by the attendance transaction, read back from the index.
    stored = boto3.resource("dynamodb").Table(os.environ[EXAMS_TABLE_ENV]).scan()["Items"]

    (entry,) = _entries(_history())

    assert len(stored) == 1
    assert entry["created_at"] == stored[0]["created_at"] == CREATED
    assert entry["target_belt_id"] == stored[0]["target_belt_id"] == belt("Cinza/Azul").id
