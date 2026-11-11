"""Exam notices to the guardian (RN019): ``GET /students/{id}/exam-notices``.

For an active student, each open event carries a notice while the student is
eligible on the **event's date** (RN001–RN004) and has no exam in progress in
another event. The notice goes away when the event is closed or when the
student's exam in that event is decided. The route only reads: the guardian
sees the own students (RN013, a student of someone else is a 404 as in
``GET /students/{id}``), an examiner gets 403 before any read, and the answer
has only the least the notice needs (RN016: no list of events). Persistent
throttling on any read is a 503.

Today is 2026-11-01 in every test.
"""

import os
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    DYNAMODB_WRITES,
    EXAMINER,
    EXAMINER_SUB,
    GUARDIAN,
    MASTER,
    OTHER_GUARDIAN,
    OTHER_GUARDIAN_SUB,
    api_event,
    assert_service_busy,
    belt_id,
    dynamodb_snapshot,
    lag_eventual_reads,
    make_student,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain import notices as notice_rules
from domain.belts import SEED_BELTS
from domain.eligibility import ExamKind, evaluate
from domain.errors import ForbiddenError
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, ExamStatus, Graduation
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import (
    BELTS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
)

STUDENT_ID = "student-1"
TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
GUARDIANS_ONLY = "Esta área é dos responsáveis"
NOT_FOUND = "Aluno não encontrado"
LOGIN = "Faça login para continuar"

NOTICE_FIELDS = {
    "event_id",
    "event_name",
    "event_date",
    "target_belt_id",
    "target_belt_name",
    "kind",
}

# Ids out of date order, so the answer's order is not the ids' nor the creation's.
DECEMBER = ExamEvent(
    "event-z", "Exame dezembro/2026", date(2026, 12, 5), EventStatus.OPEN, NOW, NOW
)
MARCH = ExamEvent("event-a", "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
# Still open after its date: the reference stays the event's date, not today.
PAST_AUGUST = ExamEvent(
    "event-p", "Exame agosto/2026", date(2026, 8, 1), EventStatus.OPEN, NOW, NOW
)

DECEMBER_NOTICE = {
    "event_id": "event-z",
    "event_name": "Exame dezembro/2026",
    "event_date": "2026-12-05",
    "target_belt_id": belt_id("Cinza/Azul"),
    "target_belt_name": "Cinza/Azul",
    "kind": "BELT",
}
MARCH_NOTICE = {
    "event_id": "event-a",
    "event_name": "Exame março/2027",
    "event_date": "2027-03-20",
    "target_belt_id": belt_id("Cinza/Azul"),
    "target_belt_name": "Cinza/Azul",
    "kind": "BELT",
}

# Cinza since 2026-03-14 (make_student): Cinza/Azul asks for 6 months, complete
# on 2026-09-14, so Ana is eligible today, in December and in March.
ANA = make_student()
# Cinza since 2026-09-01: 2 months today and 3 in December (blocked), 6 in March.
LATE = make_student(since=date(2026, 9, 1))


# --- domain ---------------------------------------------------------------


def _exam(
    event_id: str, status: ExamStatus = ExamStatus.IN_PROGRESS, *, student_id: str = STUDENT_ID
) -> Exam:
    decided = status != ExamStatus.IN_PROGRESS
    return Exam(
        id=f"exam-{event_id}-{student_id}",
        event_id=event_id,
        student_id=student_id,
        target_belt_id=belt_id("Cinza/Azul"),
        kind=ExamKind.BELT,
        status=status,
        decided_by_id=SENSEI.sub if decided else None,
        decided_at=NOW if decided else None,
        notes=None,
        created_by=EXAMINER_SUB,
        created_at=NOW,
        source=Graduation(belt_id("Cinza"), date(2026, 3, 14), 0),
    )


def _notices(
    student: Student = ANA,
    events: tuple[ExamEvent, ...] = (MARCH, DECEMBER),
    exams: tuple[Exam, ...] = (),
) -> list[dict[str, Any]]:
    return notice_rules.exam_notices(student, SEED_BELTS, events, exams)


def test_rn019_active_eligible_student_has_a_notice_per_open_event() -> None:
    notices = _notices()

    # Earliest event first, whatever the order the events came in.
    assert notices == [DECEMBER_NOTICE, MARCH_NOTICE]
    assert all(set(notice) == NOTICE_FIELDS for notice in notices)
    assert _notices(events=(DECEMBER, MARCH)) == notices


def test_rn019_inactive_student_has_no_notice() -> None:
    assert _notices(replace(ANA, active=False)) == []
    # Not even of the event where an exam is still in progress.
    assert _notices(replace(ANA, active=False), exams=(_exam("event-a"),)) == []


def test_rn019_eligible_on_the_event_date_but_not_today_has_the_notice() -> None:
    assert not evaluate(LATE, SEED_BELTS, TODAY).eligible
    assert not evaluate(LATE, SEED_BELTS, DECEMBER.exam_date).eligible
    assert evaluate(LATE, SEED_BELTS, MARCH.exam_date).eligible

    # Blocked today and in December; the waiting period is complete in March.
    assert _notices(LATE) == [MARCH_NOTICE]


def test_rn019_eligible_today_but_not_on_the_event_date_has_no_notice() -> None:
    # An event still open after its date: Ana had 4 of the 6 months then.
    assert evaluate(ANA, SEED_BELTS, TODAY).eligible
    assert not evaluate(ANA, SEED_BELTS, PAST_AUGUST.exam_date).eligible

    assert _notices(events=(PAST_AUGUST,)) == []
    assert _notices(events=(PAST_AUGUST, DECEMBER)) == [DECEMBER_NOTICE]


def test_rn019_not_eligible_by_age_on_the_event_date_has_no_notice() -> None:
    # Cinza/Azul asks for 6 years: six on 2026-12-06, the day after the event.
    child = make_student(birth=date(2020, 12, 6))

    assert _notices(child) == [MARCH_NOTICE]


def test_rn019_student_without_a_next_belt_has_no_notice() -> None:
    # Marrom: the next exam is the federation's (RN003).
    marrom = make_student(belt_name="Marrom", birth=date(2005, 1, 1), since=date(2020, 1, 1))

    assert _notices(marrom) == []


def test_rn019_stripe_exam_notice_names_the_next_belt_and_the_kind() -> None:
    # Verde with no stripes: a stripe exam with the Roxa items (RN004).
    verde = make_student(belt_name="Verde", birth=date(2010, 1, 1), since=date(2026, 1, 10))

    (notice,) = _notices(verde, events=(MARCH,))

    assert (notice["kind"], notice["target_belt_name"]) == ("STRIPE", "Roxa")
    assert notice["target_belt_id"] == belt_id("Roxa")


def test_rn019_closed_event_has_no_notice() -> None:
    closed = replace(MARCH, status=EventStatus.CLOSED)

    assert _notices(events=(closed, DECEMBER)) == [DECEMBER_NOTICE]
    assert _notices(events=(closed,)) == []


def test_rn019_no_open_event_means_no_notice() -> None:
    assert _notices(events=()) == []


@pytest.mark.parametrize("status", [ExamStatus.APPROVED, ExamStatus.FAILED])
def test_rn019_decided_exam_removes_the_notice_of_that_event(status: ExamStatus) -> None:
    # The student is kept as before the decision, so only the decided exam
    # (not a new graduation) can be what removes the March notice.
    assert _notices(exams=(_exam("event-a", status),)) == [DECEMBER_NOTICE]


def test_rn019_exam_in_progress_keeps_only_the_notice_of_its_own_event() -> None:
    # In progress in March: the December notice goes (another event), the
    # March one stays until the decision.
    assert _notices(exams=(_exam("event-a"),)) == [MARCH_NOTICE]


def test_rn019_exam_in_progress_in_a_closed_event_removes_every_notice() -> None:
    # RN008a: a closed event still waits for the decision of its exams.
    closed = replace(MARCH, status=EventStatus.CLOSED)

    assert _notices(events=(closed, DECEMBER), exams=(_exam("event-a"),)) == []


def test_rn019_notice_of_the_exam_in_progress_uses_the_exam_as_stored() -> None:
    # The target and the kind are the ones stored at the attendance, even if a
    # belt rule edited later would block the student on the event's date.
    stricter = [
        replace(item, min_months_previous=24) if item.name == "Cinza/Azul" else item
        for item in SEED_BELTS
    ]

    assert notice_rules.exam_notices(ANA, stricter, (MARCH,), ()) == []
    assert notice_rules.exam_notices(ANA, stricter, (MARCH,), (_exam("event-a"),)) == [MARCH_NOTICE]


def test_rn019_exams_of_other_students_are_ignored() -> None:
    other = _exam("event-a", student_id="student-2")

    assert _notices(exams=(other,)) == [DECEMBER_NOTICE, MARCH_NOTICE]


def test_rn019_same_date_events_are_ordered_by_id() -> None:
    first = replace(MARCH, id="event-b", name="Turma B")
    second = replace(MARCH, id="event-c", name="Turma C")

    for events in ((second, first, DECEMBER), (DECEMBER, first, second)):
        assert [notice["event_id"] for notice in _notices(events=events)] == [
            "event-z",
            "event-b",
            "event-c",
        ]


def test_rn019_only_guardians_use_the_notices() -> None:
    notice_rules.ensure_guardian(GUARDIAN)
    for examiner in (EXAMINER, MASTER):
        with pytest.raises(ForbiddenError) as refused:
            notice_rules.ensure_guardian(examiner)
        assert refused.value.message == GUARDIANS_ONLY


# --- route ----------------------------------------------------------------


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


@pytest.fixture
def academy(seeded: None, clock: None) -> None:
    """Ana (of ``GUARDIAN``), the open events of December and March, and a sensei."""
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    student_repo.create_student(ANA)
    for exam_event in (MARCH, DECEMBER):
        event_repo.create_event(exam_event)


def _get(user: User | None = GUARDIAN, student_id: str = STUDENT_ID) -> dict[str, Any]:
    return student_handlers.list_student_exam_notices(
        api_event(user, path={"id": student_id}), None
    )


def _body(response: dict[str, Any]) -> list[dict[str, Any]]:
    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert isinstance(body, list)
    return body


def _assert_error(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response) == {"message": message}


def _confirm(exam_event: ExamEvent, student_id: str = STUDENT_ID) -> None:
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student_id}), None
    )
    assert response["statusCode"] == 201, response["body"]


def _decide(exam_event: ExamEvent, result: str) -> None:
    path = {"id": exam_event.id, "student_id": STUDENT_ID}
    response = exam_handlers.decide_exam(
        api_event(SENSEI, path=path, body={"result": result}), None
    )
    assert response["statusCode"] == 200, response["body"]


def _set_status(exam_event: ExamEvent, status: str) -> None:
    body = {
        "name": exam_event.name,
        "exam_date": exam_event.exam_date.isoformat(),
        "status": status,
    }
    response = event_handlers.update_event(
        api_event(EXAMINER, path={"id": exam_event.id}, body=body), None
    )
    assert response["statusCode"] == 200, response["body"]


def _edit_student(student_id: str = STUDENT_ID, **changes: Any) -> None:
    stored = student_repo.get_student(student_id)
    assert stored is not None
    body = {
        "full_name": stored.full_name,
        "birth_date": stored.birth_date.isoformat(),
        "current_belt_id": stored.current_belt_id,
        "current_belt_since": stored.current_belt_since.isoformat(),
        "stripes": stored.stripes,
        "federation_id": stored.federation_id,
        "active": stored.active,
        **changes,
    }
    response = student_handlers.update_student(
        api_event(EXAMINER, path={"id": student_id}, body=body), None
    )
    assert response["statusCode"] == 200, response["body"]


def _record_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """Record every AWS call (operation and parameters) from now on."""
    original = BaseClient._make_api_call
    calls: list[tuple[str, dict[str, Any]]] = []

    def recording(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        calls.append((operation_name, dict(api_params)))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", recording)
    return calls


def _made(calls: list[tuple[str, dict[str, Any]]]) -> list[tuple[str, str, str | None]]:
    return [
        (operation, params.get("TableName"), params.get("IndexName")) for operation, params in calls
    ]


def test_rn019_guardian_sees_a_notice_per_open_event_earliest_first(academy: None) -> None:
    notices = _body(_get())

    assert notices == [DECEMBER_NOTICE, MARCH_NOTICE]
    assert all(set(notice) == NOTICE_FIELDS for notice in notices)


def test_rn019_route_inactive_student_has_no_notice(academy: None) -> None:
    _edit_student(active=False)

    assert _body(_get()) == []

    _edit_student(active=True)
    assert _body(_get()) == [DECEMBER_NOTICE, MARCH_NOTICE]


def test_rn019_route_uses_the_event_date_not_today(academy: None) -> None:
    student_repo.create_student(replace(LATE, id="student-late", full_name="Lia"))
    event_repo.create_event(PAST_AUGUST)

    # Lia: blocked today and in December, eligible in March.
    assert _body(_get(student_id="student-late")) == [MARCH_NOTICE]
    # Ana: eligible today, but not on the date of the event still open in August.
    assert _body(_get()) == [DECEMBER_NOTICE, MARCH_NOTICE]


def test_rn019_route_today_does_not_change_the_notices(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    student_repo.create_student(replace(LATE, id="student-late", full_name="Lia"))
    before = _body(_get(student_id="student-late"))

    # A day on which Lia is already eligible: December stays blocked.
    monkeypatch.setattr(dates, "today", lambda: date(2027, 6, 1))

    assert _body(_get(student_id="student-late")) == before == [MARCH_NOTICE]


def test_rn019_route_closed_event_loses_the_notice_and_reopened_gets_it_back(
    academy: None,
) -> None:
    _set_status(DECEMBER, "CLOSED")
    assert _body(_get()) == [MARCH_NOTICE]

    _set_status(MARCH, "CLOSED")
    assert _body(_get()) == []

    _set_status(DECEMBER, "OPEN")
    assert _body(_get()) == [DECEMBER_NOTICE]


def test_rn019_route_no_event_at_all_is_an_empty_list(seeded: None, clock: None) -> None:
    student_repo.create_student(ANA)

    assert _body(_get()) == []


def test_rn019_route_exam_in_progress_keeps_only_its_own_event(academy: None) -> None:
    _confirm(MARCH)

    # No notice of the other event; the one of the exam's event stays.
    assert _body(_get()) == [MARCH_NOTICE]


def test_rn019_route_exam_in_progress_in_a_closed_event_removes_every_notice(
    academy: None,
) -> None:
    _confirm(MARCH)
    _set_status(MARCH, "CLOSED")

    assert _body(_get()) == []


def test_rn019_route_failed_exam_removes_the_notice_of_that_event_only(academy: None) -> None:
    _confirm(MARCH)
    _decide(MARCH, "FAILED")

    # Failed: the graduation is the same (RN009), so December is back; March,
    # still open, no longer has a notice.
    assert _body(_get()) == [DECEMBER_NOTICE]


def test_rn019_route_approved_exam_removes_the_notice_of_that_event(academy: None) -> None:
    _confirm(DECEMBER)
    _decide(DECEMBER, "APPROVED")

    notices = _body(_get())

    # December is decided. Ana is now Cinza/Azul since 2026-12-05 (RN009): the
    # 3 full months she has in March are short of the 6 the Azul asks for.
    assert notices == []

    # With an event where the new graduation is eligible, only that one shows.
    event_repo.create_event(
        ExamEvent("event-s", "Exame setembro/2027", date(2027, 9, 25), EventStatus.OPEN, NOW, NOW)
    )
    assert _body(_get()) == [
        {
            "event_id": "event-s",
            "event_name": "Exame setembro/2027",
            "event_date": "2027-09-25",
            "target_belt_id": belt_id("Azul"),
            "target_belt_name": "Azul",
            "kind": "BELT",
        }
    ]


def test_rn019_route_answers_only_about_the_requested_student(academy: None) -> None:
    student_repo.create_student(
        replace(ANA, id="student-2", full_name="Bia", owner_id=OTHER_GUARDIAN_SUB)
    )
    _confirm(MARCH, "student-2")

    # Bia's exam in progress changes nothing for Ana, and nothing of Bia shows.
    response = _get()
    assert _body(response) == [DECEMBER_NOTICE, MARCH_NOTICE]
    assert "Bia" not in response["body"]
    assert "student-2" not in response["body"]
    assert _body(_get(OTHER_GUARDIAN, "student-2")) == [MARCH_NOTICE]


# --- route: authorization and 404 -----------------------------------------


def test_rn019_notices_require_login(aws: None) -> None:
    _assert_error(_get(None), 401, LOGIN)


@pytest.mark.parametrize("user", [EXAMINER, MASTER, SENSEI], ids=["examiner", "master", "sensei"])
def test_rn019_examiner_gets_403_before_any_read(
    academy: None, monkeypatch: pytest.MonkeyPatch, user: User
) -> None:
    calls = _record_calls(monkeypatch)

    _assert_error(_get(user), 403, GUARDIANS_ONLY)
    assert calls == []


def test_rn019_examiner_gets_403_even_for_unknown_or_invalid_student(aws: None) -> None:
    for student_id in ("missing", "", "x" * 1025):
        _assert_error(_get(EXAMINER, student_id), 403, GUARDIANS_ONLY)


def test_rn019_examiner_who_owns_the_student_gets_403_too(academy: None) -> None:
    student_repo.create_student(
        replace(ANA, id="student-ex", full_name="Edu", owner_id=EXAMINER_SUB)
    )

    _assert_error(_get(EXAMINER, "student-ex"), 403, GUARDIANS_ONLY)


def test_rn013_other_guardian_gets_the_same_404_as_the_student_detail(academy: None) -> None:
    # RN013 as GET /students/{id} applies it: a student of someone else is
    # reported as not found, so not even its existence leaks.
    detail = student_handlers.get_student(api_event(OTHER_GUARDIAN, path={"id": STUDENT_ID}), None)
    _assert_error(detail, 404, NOT_FOUND)

    _assert_error(_get(OTHER_GUARDIAN), 404, NOT_FOUND)


def test_rn013_other_guardian_reads_only_the_student(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _record_calls(monkeypatch)

    _assert_error(_get(OTHER_GUARDIAN), 404, NOT_FOUND)
    assert _made(calls) == [("GetItem", os.environ[STUDENTS_TABLE_ENV], None)]


def test_rn019_unknown_student_is_404(academy: None) -> None:
    _assert_error(_get(student_id="missing"), 404, NOT_FOUND)


@pytest.mark.parametrize("student_id", ["", "x" * 1025, "é" * 513], ids=["empty", "long", "utf8"])
def test_rn019_invalid_path_id_is_404_before_any_read(
    academy: None, monkeypatch: pytest.MonkeyPatch, student_id: str
) -> None:
    calls = _record_calls(monkeypatch)

    _assert_error(_get(student_id=student_id), 404, NOT_FOUND)
    assert calls == []


def test_rn019_missing_path_parameters_is_404(academy: None) -> None:
    response = student_handlers.list_student_exam_notices(api_event(GUARDIAN), None)

    _assert_error(response, 404, NOT_FOUND)


# --- route: reads ---------------------------------------------------------


def test_rn019_route_only_reads_and_makes_only_the_calls_its_function_may_make(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # ListStudentExamNoticesFunction may only: GetItem on Students, Scan on
    # Events, Query on the by_student index of Exams and Scan on Belts
    # (test_template.py checks the template).
    _confirm(MARCH)
    before = dynamodb_snapshot()
    calls = _record_calls(monkeypatch)

    assert _body(_get()) == [MARCH_NOTICE]

    assert _made(calls) == [
        ("GetItem", os.environ[STUDENTS_TABLE_ENV], None),
        ("Scan", os.environ[EVENTS_TABLE_ENV], None),
        ("Query", os.environ[EXAMS_TABLE_ENV], "by_student"),
        ("Scan", os.environ[BELTS_TABLE_ENV], None),
    ]
    assert not {operation for operation, _ in calls} & set(DYNAMODB_WRITES)
    monkeypatch.undo()
    assert dynamodb_snapshot() == before


def test_rn019_calls_do_not_grow_with_the_students_or_the_events(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(30):
        student_repo.create_student(
            replace(ANA, id=f"other-{index}", full_name=f"Aluno {index}", owner_id="guardian-9")
        )
        event_repo.create_event(replace(MARCH, id=f"event-x{index:02d}", name=f"Turma {index}"))
    calls = _record_calls(monkeypatch)

    assert len(_body(_get())) == 32

    assert [operation for operation, _ in calls] == ["GetItem", "Scan", "Query", "Scan"]


def test_rn019_inactive_student_reads_only_the_student(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _edit_student(active=False)
    calls = _record_calls(monkeypatch)

    assert _body(_get()) == []
    assert _made(calls) == [("GetItem", os.environ[STUDENTS_TABLE_ENV], None)]


def test_rn019_no_open_event_reads_neither_exams_nor_belts(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    for exam_event in (MARCH, DECEMBER):
        _set_status(exam_event, "CLOSED")
    calls = _record_calls(monkeypatch)

    assert _body(_get()) == []
    assert _made(calls) == [
        ("GetItem", os.environ[STUDENTS_TABLE_ENV], None),
        ("Scan", os.environ[EVENTS_TABLE_ENV], None),
    ]


def test_rn019_student_read_is_strongly_consistent(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A student created a moment ago is seen: an eventually consistent read
    # could still miss it and answer a false 404 (#78).
    gets = lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    student_repo.create_student(replace(ANA, id="student-new", full_name="Nina"))

    assert _body(_get(student_id="student-new")) == [DECEMBER_NOTICE, MARCH_NOTICE]
    assert gets and all(call.get("ConsistentRead") is True for call in gets)


# --- route: throttling ----------------------------------------------------

# Every read of the route: (operation, table); the Query is the by_student index.
READS = [
    ("GetItem", STUDENTS_TABLE_ENV),
    ("Scan", EVENTS_TABLE_ENV),
    ("Query", EXAMS_TABLE_ENV),
    ("Scan", BELTS_TABLE_ENV),
]
READ_IDS = ["student", "events", "exams-by-student", "belts"]


@pytest.mark.parametrize(("operation", "table_env"), READS, ids=READ_IDS)
@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
def test_rn019_throttled_read_is_503(
    academy: None, monkeypatch: pytest.MonkeyPatch, operation: str, table_env: str, code: str
) -> None:
    stub = throttle_dynamodb(monkeypatch, operation, table_env, code=code)

    response = _get()

    assert_service_busy(response, stub)
    # One refused call and the route stops: no retry loop of its own.
    assert len(stub.calls) == 1
    if operation == "Query":
        assert stub.calls[0]["IndexName"] == "by_student"


@pytest.mark.parametrize(("operation", "table_env"), READS, ids=READ_IDS)
def test_rn019_other_dynamodb_error_stays_a_500(
    academy: None, monkeypatch: pytest.MonkeyPatch, operation: str, table_env: str
) -> None:
    stub = throttle_dynamodb(monkeypatch, operation, table_env, code="ValidationException")

    _assert_error(_get(), 500, "Erro interno. Tente de novo.")
    assert stub.calls
