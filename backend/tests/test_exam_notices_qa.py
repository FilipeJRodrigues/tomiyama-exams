"""Exam notices to the guardian (RN019) beyond ``test_exam_notices.py`` (QA of #108).

What these tests add to the route ``GET /students/{id}/exam-notices``:

- the edges of RN001–RN004 on the **event's date** (age and waiting period on
  the very day, end of month, 29/02, the waiver at 16, the halved waiting
  period of a stripe exam);
- the notice agrees with the attendance (``POST /events/{id}/exams``): with no
  exam yet, there is a notice exactly when the attendance would be accepted,
  with the same target belt and kind;
- states that should not exist (two exams in progress, an exam whose event or
  target belt is gone, an unknown current belt) and legacy items never give 500;
- the caller: token without ``sub``, no group, unexpected groups, groups as a
  list; a student of someone else is indistinguishable from a missing one;
- the paged ``Scan``/``Query`` (``LastEvaluatedKey``) loses no event or exam;
- the query string changes nothing, and no answer (200, 403, 404) writes.

Today is 2026-11-01 in every test.
"""

import itertools
import os
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import (
    EXAMINER,
    EXAMINER_SUB,
    GUARDIAN,
    GUARDIAN_SUB,
    OTHER_GUARDIAN,
    OTHER_GUARDIAN_SUB,
    api_event,
    belt_id,
    dynamodb_snapshot,
    make_student,
    response_json,
)

from domain import dates
from domain import exams as exam_rules
from domain import notices as notice_rules
from domain.belts import SEED_BELTS
from domain.eligibility import ExamKind
from domain.errors import ValidationError
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, ExamStatus, Graduation
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, GUARDIAN_GROUP, MASTER_GROUP, User
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
    table,
)

STUDENT_ID = "student-1"
TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
NOT_FOUND = "Aluno não encontrado"
GUARDIANS_ONLY = "Esta área é dos responsáveis"
LOGIN = "Faça login para continuar"
NOTICE_FIELDS = {
    "event_id",
    "event_name",
    "event_date",
    "target_belt_id",
    "target_belt_name",
    "kind",
}

DECEMBER = ExamEvent(
    "event-z", "Exame dezembro/2026", date(2026, 12, 5), EventStatus.OPEN, NOW, NOW
)
MARCH = ExamEvent("event-a", "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
ANA = make_student()


def _event(
    day: date, event_id: str = "event-q", status: EventStatus = EventStatus.OPEN
) -> ExamEvent:
    return ExamEvent(event_id, f"Exame {day.isoformat()}", day, status, NOW, NOW)


def _exam(
    event_id: str,
    status: ExamStatus = ExamStatus.IN_PROGRESS,
    *,
    target: str = "Cinza/Azul",
    kind: ExamKind = ExamKind.BELT,
) -> Exam:
    decided = status != ExamStatus.IN_PROGRESS
    return Exam(
        id=f"exam-{event_id}",
        event_id=event_id,
        student_id=STUDENT_ID,
        target_belt_id=belt_id(target),
        kind=kind,
        status=status,
        decided_by_id=SENSEI.sub if decided else None,
        decided_at=NOW if decided else None,
        notes=None,
        created_by=EXAMINER_SUB,
        created_at=NOW,
        source=Graduation(belt_id("Cinza"), date(2026, 3, 14), 0),
    )


def _domain(
    student: Student, events: tuple[ExamEvent, ...], exams: tuple[Exam, ...] = ()
) -> list[dict[str, Any]]:
    return notice_rules.exam_notices(student, SEED_BELTS, events, exams)


# --- domain: RN001–RN004 edges on the event's date ---------------------------


@pytest.mark.parametrize(
    ("birth", "has_notice"),
    [(date(2020, 12, 5), True), (date(2020, 12, 6), False)],
    ids=["birthday-on-the-event-day", "birthday-the-day-after"],
)
def test_rn019_rn001_minimum_age_is_counted_on_the_event_day(birth: date, has_notice: bool) -> None:
    # Cinza/Azul asks for 6 years; the waiting period is long complete.
    child = make_student(birth=birth, since=date(2025, 1, 10))

    assert bool(_domain(child, (DECEMBER,))) is has_notice


@pytest.mark.parametrize(
    ("since", "has_notice"),
    [(date(2026, 6, 5), True), (date(2026, 6, 6), False)],
    ids=["six-months-on-the-event-day", "one-day-short"],
)
def test_rn019_rn002_waiting_period_is_counted_on_the_event_day(
    since: date, has_notice: bool
) -> None:
    assert bool(_domain(make_student(since=since), (DECEMBER,))) is has_notice


@pytest.mark.parametrize(
    ("since", "event_day", "has_notice"),
    [
        # 31/08 -> 28/02: the month counts as complete on the last day of February.
        (date(2026, 8, 31), date(2027, 2, 28), True),
        (date(2026, 8, 31), date(2027, 2, 27), False),
        # Leap year: the event on 29/02 is the last day of the month.
        (date(2027, 8, 31), date(2028, 2, 29), True),
        (date(2027, 8, 31), date(2028, 2, 28), False),
    ],
    ids=["feb-28", "feb-27", "leap-feb-29", "leap-feb-28"],
)
def test_rn019_rn002_waiting_period_at_the_end_of_the_month(
    since: date, event_day: date, has_notice: bool
) -> None:
    student = make_student(birth=date(2015, 1, 1), since=since)

    assert bool(_domain(student, (_event(event_day),))) is has_notice


@pytest.mark.parametrize(
    ("event_day", "has_notice"),
    [(date(2026, 2, 28), False), (date(2026, 3, 1), True), (date(2028, 2, 29), True)],
    ids=["feb-28-still-five", "mar-1-six", "leap-birthday"],
)
def test_rn019_rn001_born_on_february_29(event_day: date, has_notice: bool) -> None:
    child = make_student(birth=date(2020, 2, 29), since=date(2025, 1, 10))

    assert bool(_domain(child, (_event(event_day),))) is has_notice


@pytest.mark.parametrize(
    ("birth", "has_notice"),
    [(date(2011, 3, 20), True), (date(2011, 3, 21), False)],
    ids=["sixteen-on-the-event-day", "sixteen-the-day-after"],
)
def test_rn019_rn002_waiver_at_sixteen_is_counted_on_the_event_day(
    birth: date, has_notice: bool
) -> None:
    # Verde with one stripe: belt exam for the Roxa, 12 months; none served.
    verde = make_student(belt_name="Verde", birth=birth, since=date(2027, 3, 1), stripes=1)

    notices = _domain(verde, (MARCH,))

    assert bool(notices) is has_notice
    if has_notice:
        assert (notices[0]["kind"], notices[0]["target_belt_name"]) == ("BELT", "Roxa")


@pytest.mark.parametrize(
    ("since", "has_notice"),
    [(date(2026, 9, 20), True), (date(2026, 9, 21), False)],
    ids=["half-the-period-on-the-event-day", "one-day-short"],
)
def test_rn019_rn004_stripe_exam_asks_for_half_the_waiting_period(
    since: date, has_notice: bool
) -> None:
    # Verde with no stripes: stripe exam, 6 of the Roxa's 12 months.
    verde = make_student(belt_name="Verde", birth=date(2014, 1, 1), since=since)

    notices = _domain(verde, (MARCH,))

    assert bool(notices) is has_notice
    if has_notice:
        assert notices[0]["kind"] == "STRIPE"


def _grid_students() -> list[Student]:
    students = []
    for belt_name, stripes in (
        ("Branca", 0),
        ("Cinza", 0),
        ("Verde", 0),
        ("Verde", 1),
        ("Marrom", 0),
    ):
        for birth in (date(2011, 3, 20), date(2011, 3, 21), date(2018, 5, 10), date(2020, 12, 6)):
            for since in (date(2026, 3, 20), date(2026, 6, 5), date(2026, 9, 21), date(2027, 3, 1)):
                for active in (True, False):
                    students.append(
                        make_student(
                            belt_name=belt_name,
                            birth=birth,
                            since=since,
                            stripes=stripes,
                            active=active,
                        )
                    )
    return students


def test_rn019_rn005_notice_holds_exactly_when_the_attendance_would_be_accepted() -> None:
    # The exam-day screen and the notice must agree: same rule, same date.
    events = [
        _event(day, status=status)
        for day in (date(2026, 8, 1), date(2026, 12, 5), date(2027, 3, 20), date(2027, 9, 21))
        for status in EventStatus
    ]
    accepted = 0
    for student, exam_event in itertools.product(_grid_students(), events):
        try:
            exam = exam_rules.confirm_attendance(exam_event, student, SEED_BELTS, EXAMINER_SUB, NOW)
        except ValidationError:
            expected: list[tuple[str, str]] = []
        else:
            accepted += 1
            expected = [(exam.target_belt_id, exam.kind.value)]

        notices = _domain(student, (exam_event,))

        assert [(notice["target_belt_id"], notice["kind"]) for notice in notices] == expected, (
            student,
            exam_event,
        )
    assert accepted > 50, "the grid must have accepted and refused cases"


# --- domain: states that should not exist ------------------------------------


def test_rn019_two_exams_in_progress_give_no_notice_and_no_error() -> None:
    # RN005 forbids it, but the notice must not break on it: each event sees
    # an exam in progress in another one.
    exams = (_exam(DECEMBER.id), _exam(MARCH.id))

    assert _domain(ANA, (DECEMBER, MARCH), exams) == []


def test_rn019_exam_in_progress_in_an_event_that_is_not_listed_removes_every_notice() -> None:
    assert _domain(ANA, (DECEMBER, MARCH), (_exam("event-gone"),)) == []


def test_rn019_decided_exam_in_an_event_that_is_not_listed_changes_nothing() -> None:
    for status in (ExamStatus.APPROVED, ExamStatus.FAILED):
        assert len(_domain(ANA, (DECEMBER, MARCH), (_exam("event-gone", status),))) == 2


def test_rn019_exam_in_progress_keeps_the_kind_and_target_stored_in_the_exam() -> None:
    stored = _exam(MARCH.id, target="Roxa", kind=ExamKind.STRIPE)

    (notice,) = _domain(ANA, (MARCH,), (stored,))

    assert (notice["target_belt_id"], notice["target_belt_name"], notice["kind"]) == (
        belt_id("Roxa"),
        "Roxa",
        "STRIPE",
    )


def test_rn019_exam_in_progress_with_an_unknown_target_belt_has_a_null_name() -> None:
    stored = replace(_exam(MARCH.id), target_belt_id="belt-gone")

    (notice,) = _domain(ANA, (MARCH,), (stored,))

    assert notice["target_belt_id"] == "belt-gone"
    assert notice["target_belt_name"] is None
    assert set(notice) == NOTICE_FIELDS


def test_rn019_student_with_an_unknown_current_belt_has_no_notice() -> None:
    assert _domain(replace(ANA, current_belt_id="belt-gone"), (DECEMBER, MARCH)) == []


def test_rn019_closed_event_with_a_decided_exam_does_not_hide_the_other_events() -> None:
    closed = replace(DECEMBER, status=EventStatus.CLOSED)

    notices = _domain(ANA, (closed, MARCH), (_exam(DECEMBER.id, ExamStatus.FAILED),))

    assert [notice["event_id"] for notice in notices] == [MARCH.id]


def test_rn019_the_events_and_the_student_are_not_changed() -> None:
    events = [MARCH, DECEMBER]

    _domain(ANA, tuple(events))
    notice_rules.open_events(events)

    assert events == [MARCH, DECEMBER]


# --- route -------------------------------------------------------------------


@pytest.fixture
def academy(seeded: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ana (of ``GUARDIAN``), the open events of December and March, and a sensei."""
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)
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


def _get(
    user: User | None = GUARDIAN,
    student_id: str = STUDENT_ID,
    query: dict[str, str] | None = None,
) -> dict[str, Any]:
    return student_handlers.list_student_exam_notices(
        api_event(user, path={"id": student_id}, query=query), None
    )


def _with_claims(claims: dict[str, Any], student_id: str = STUDENT_ID) -> dict[str, Any]:
    event = api_event(GUARDIAN, path={"id": student_id})
    event["requestContext"]["authorizer"]["jwt"]["claims"] = claims
    return student_handlers.list_student_exam_notices(event, None)


def _body(response: dict[str, Any]) -> list[dict[str, Any]]:
    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert isinstance(body, list)
    return body


def _ids(response: dict[str, Any]) -> list[str]:
    return [notice["event_id"] for notice in _body(response)]


def _assert_error(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response) == {"message": message}


def _confirm(exam_event: ExamEvent, student_id: str = STUDENT_ID) -> dict[str, Any]:
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student_id}), None
    )


def _put_exam(exam: Exam) -> None:
    """Store an exam as it is, without the attendance's checks."""
    item = {key: value for key, value in exam.to_dict().items() if value is not None}
    table(EXAMS_TABLE_ENV).put_item(Item=item)


def _record_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    original = BaseClient._make_api_call
    calls: list[tuple[str, dict[str, Any]]] = []

    def recording(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        calls.append((operation_name, dict(api_params)))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", recording)
    return calls


# --- route: the caller ---------------------------------------------------------


@pytest.mark.parametrize(
    "claims",
    [{}, {"email": "pai@example.com"}, {"sub": ""}, {"sub": None, "cognito:groups": "[admin]"}],
    ids=["no-claims", "no-sub", "empty-sub", "null-sub-admin"],
)
def test_rn019_token_without_sub_is_401_before_any_read(
    academy: None, monkeypatch: pytest.MonkeyPatch, claims: dict[str, Any]
) -> None:
    calls = _record_calls(monkeypatch)

    _assert_error(_with_claims(claims), 401, LOGIN)
    assert calls == []


def test_rn019_request_without_authorizer_context_is_401(academy: None) -> None:
    response = student_handlers.list_student_exam_notices(
        {"pathParameters": {"id": STUDENT_ID}}, None
    )

    _assert_error(response, 401, LOGIN)


@pytest.mark.parametrize(
    "groups",
    [None, "", "[]", "[responsavel]", "[master]", "[outro-grupo]", ["responsavel"]],
    ids=["absent", "empty", "empty-list", "guardian", "master-alone", "unknown", "real-list"],
)
def test_rn019_owner_who_is_not_an_examiner_sees_the_notices_whatever_the_groups(
    academy: None, groups: Any
) -> None:
    # Self sign-up users may carry no group at all; ``master`` without
    # ``admin`` is not an examiner (domain.users).
    claims = {"sub": GUARDIAN_SUB, "cognito:groups": groups}
    if groups is None:
        del claims["cognito:groups"]

    assert _ids(_with_claims(claims)) == [DECEMBER.id, MARCH.id]


@pytest.mark.parametrize(
    "groups",
    ["[admin]", "[admin responsavel]", "[responsavel admin master]", "admin", ["admin"]],
    ids=["admin", "admin-guardian", "three-groups", "bare", "real-list"],
)
def test_rn019_any_examiner_claim_is_403_even_for_the_owner(academy: None, groups: Any) -> None:
    # The owner of the student, but with the examiner's group: the route is
    # not the examiner's, whatever else the token carries.
    _assert_error(
        _with_claims({"sub": GUARDIAN_SUB, "cognito:groups": groups}), 403, GUARDIANS_ONLY
    )


def test_rn013_not_owner_without_group_gets_the_404(academy: None) -> None:
    for groups in (None, "[master]", "[outro-grupo]"):
        claims = {"sub": "someone-else", "cognito:groups": groups}
        _assert_error(_with_claims(claims), 404, NOT_FOUND)


# --- route: RN013, a student of someone else looks like a missing one ---------


def test_rn013_student_of_someone_else_is_indistinguishable_from_a_missing_one(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Whatever the state of the other guardian's student: active with two
    # notices, with an exam in progress, or inactive.
    student_repo.create_student(replace(ANA, id="student-off", full_name="Caio", active=False))
    assert _confirm(MARCH)["statusCode"] == 201
    calls = _record_calls(monkeypatch)

    missing = _get(OTHER_GUARDIAN, "student-missing")
    made_for_missing = [(operation, params.get("TableName")) for operation, params in calls]
    assert missing["statusCode"] == 404

    for student_id in (STUDENT_ID, "student-off"):
        calls.clear()
        response = _get(OTHER_GUARDIAN, student_id)

        assert response == missing
        assert [(operation, params.get("TableName")) for operation, params in calls] == (
            made_for_missing
        )
    assert made_for_missing == [("GetItem", os.environ[STUDENTS_TABLE_ENV])]


def test_rn013_each_guardian_sees_only_the_own_student(academy: None) -> None:
    student_repo.create_student(
        replace(
            ANA,
            id="student-2",
            full_name="Bia",
            owner_id=OTHER_GUARDIAN_SUB,
            current_belt_id=belt_id("Verde"),
            birth_date=date(2014, 1, 1),
            current_belt_since=date(2026, 1, 10),
        )
    )

    mine = _get(GUARDIAN)
    theirs = _get(OTHER_GUARDIAN, "student-2")

    assert {notice["target_belt_name"] for notice in _body(mine)} == {"Cinza/Azul"}
    assert {(notice["kind"], notice["target_belt_name"]) for notice in _body(theirs)} == {
        ("STRIPE", "Roxa")
    }
    for response, foreign in ((mine, ("Bia", "student-2", "Roxa")), (theirs, ("Ana", STUDENT_ID))):
        assert not any(text in response["body"] for text in foreign)
    _assert_error(_get(GUARDIAN, "student-2"), 404, NOT_FOUND)
    _assert_error(_get(OTHER_GUARDIAN, STUDENT_ID), 404, NOT_FOUND)


# --- route: RN016, only the least the notice needs ----------------------------


def test_rn016_answer_has_only_the_notice_fields_and_nothing_of_the_exam(academy: None) -> None:
    assert _confirm(MARCH)["statusCode"] == 201

    response = _get()

    (notice,) = _body(response)
    assert set(notice) == NOTICE_FIELDS
    assert response["headers"] == {"Content-Type": "application/json; charset=utf-8"}
    for hidden in (
        "IN_PROGRESS",
        "OPEN",
        "status",
        "exam_count",
        "created_by",
        EXAMINER_SUB,
        SENSEI.sub,
        GUARDIAN_SUB,
        "source_belt",
        "Ana",
    ):
        assert hidden not in response["body"], hidden


def test_rn019_query_string_does_not_change_the_notices(academy: None) -> None:
    # ``reference_date`` moves the eligibility of GET /students; here the
    # reference is always the event's date, and no filter exists.
    student_repo.create_student(
        replace(make_student(since=date(2026, 9, 1)), id="student-late", full_name="Lia")
    )
    plain = _get(student_id="student-late")
    assert _ids(plain) == [MARCH.id]

    for query in (
        {"reference_date": "2030-01-01"},
        {"reference_date": "isto não é data"},
        {"active": "false", "belt_id": "x", "event_id": DECEMBER.id, "status": "CLOSED"},
    ):
        assert _get(student_id="student-late", query=query) == plain


# --- route: agreement with the attendance --------------------------------------


def test_rn019_rn005_every_notice_without_exam_is_an_attendance_that_is_accepted(
    academy: None,
) -> None:
    # Lia has only the March notice: the attendance in December is refused for
    # the waiting period, and the one in March is accepted with the same
    # target belt and kind the notice showed.
    student_repo.create_student(
        replace(make_student(since=date(2026, 9, 1)), id="student-late", full_name="Lia")
    )
    (notice,) = _body(_get(student_id="student-late"))
    assert notice["event_id"] == MARCH.id

    refused = _confirm(DECEMBER, "student-late")
    assert refused["statusCode"] == 400, refused["body"]
    assert "Carência mínima" in response_json(refused)["message"]

    accepted = _confirm(MARCH, "student-late")
    assert accepted["statusCode"] == 201, accepted["body"]
    exam = response_json(accepted)
    assert (exam["target_belt_id"], exam["kind"]) == (notice["target_belt_id"], notice["kind"])
    # In progress: the same notice stays, now from the stored exam.
    assert _body(_get(student_id="student-late")) == [notice]


def test_rn019_rn005_no_notice_where_the_attendance_is_refused_for_another_exam(
    academy: None,
) -> None:
    assert _confirm(MARCH)["statusCode"] == 201

    assert _ids(_get()) == [MARCH.id]
    refused = _confirm(DECEMBER)
    assert refused["statusCode"] == 409, refused["body"]


# --- route: states that should not exist and legacy items ----------------------


def test_rn019_route_two_exams_in_progress_is_an_empty_list_not_a_500(academy: None) -> None:
    for exam_event in (DECEMBER, MARCH):
        _put_exam(_exam(exam_event.id))

    assert _body(_get()) == []


def test_rn019_route_exam_in_progress_of_a_deleted_event_is_not_a_500(academy: None) -> None:
    _put_exam(_exam("event-gone"))

    assert _body(_get()) == []


def test_rn019_route_decided_exam_of_a_deleted_event_changes_nothing(academy: None) -> None:
    _put_exam(_exam("event-gone", ExamStatus.FAILED))

    assert _ids(_get()) == [DECEMBER.id, MARCH.id]


def test_rn019_route_target_belt_missing_from_the_belts_gives_a_null_name(academy: None) -> None:
    _put_exam(replace(_exam(MARCH.id), target_belt_id="belt-gone"))

    assert _body(_get()) == [
        {
            "event_id": MARCH.id,
            "event_name": MARCH.name,
            "event_date": "2027-03-20",
            "target_belt_id": "belt-gone",
            "target_belt_name": None,
            "kind": "BELT",
        }
    ]


def test_rn019_route_student_whose_belt_is_missing_has_no_notice(academy: None) -> None:
    table(STUDENTS_TABLE_ENV).update_item(
        Key={"id": STUDENT_ID},
        UpdateExpression="SET current_belt_id = :belt",
        ExpressionAttributeValues={":belt": "belt-gone"},
    )

    assert _body(_get()) == []


def test_rn019_route_reads_legacy_items_without_the_optional_attributes(academy: None) -> None:
    # A student stored before ``stripes``/``active``/``federation_id``, and an
    # exam stored before the source graduation: read as the other routes do.
    table(STUDENTS_TABLE_ENV).update_item(
        Key={"id": STUDENT_ID}, UpdateExpression="REMOVE stripes, active, federation_id"
    )
    assert _ids(_get()) == [DECEMBER.id, MARCH.id]

    item = {key: value for key, value in _exam(MARCH.id).to_dict().items() if value is not None}
    for attribute in ("source_belt_id", "source_belt_since", "source_stripes"):
        del item[attribute]
    table(EXAMS_TABLE_ENV).put_item(Item=item)

    assert _ids(_get()) == [MARCH.id]


def test_rn019_route_event_with_the_exam_counter_and_many_exams_is_read(academy: None) -> None:
    # ``exam_count`` is kept in the event item by the attendance; the notice
    # reads the events by scan and must ignore it.
    for index in range(5):
        student_repo.create_student(replace(ANA, id=f"other-{index}", full_name=f"Aluno {index}"))
        assert _confirm(MARCH, f"other-{index}")["statusCode"] == 201
    stored = table(EVENTS_TABLE_ENV).get_item(Key={"id": MARCH.id})["Item"]
    assert int(stored["exam_count"]) == 5

    response = _get()

    assert _ids(response) == [DECEMBER.id, MARCH.id]
    assert "exam_count" not in response["body"]


def test_rn019_route_event_names_with_accents_and_quotes_come_back_as_stored(
    academy: None,
) -> None:
    name = 'Exame "Shiai" — março/2027 <b>ção</b>'
    event_repo.create_event(replace(MARCH, id="event-n", name=name))

    notices = {notice["event_id"]: notice for notice in _body(_get())}

    assert notices["event-n"]["event_name"] == name
    assert "ção" in _get()["body"], "the body is not ASCII-escaped"


# --- route: pages ---------------------------------------------------------------


def _one_item_per_page(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Make every Scan and Query answer one item per page, as past 1 MB."""
    original = BaseClient._make_api_call
    pages: list[tuple[str, str]] = []

    def paged(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name in {"Scan", "Query"}:
            api_params = {**api_params, "Limit": 1}
            pages.append((operation_name, api_params["TableName"]))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", paged)
    return pages


def test_rn019_route_follows_every_page_of_the_events_the_exams_and_the_belts(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 12 more open events, and decided exams in three of them: an exam or an
    # event lost at a page break would show as a wrong notice.
    extra = [replace(MARCH, id=f"event-x{index:02d}", name=f"Turma {index}") for index in range(12)]
    for exam_event in extra:
        event_repo.create_event(exam_event)
    for exam_event in extra[:3]:
        _put_exam(_exam(exam_event.id, ExamStatus.FAILED))
    expected = [DECEMBER.id, MARCH.id, *(exam_event.id for exam_event in extra[3:])]
    assert _ids(_get()) == expected

    pages = _one_item_per_page(monkeypatch)

    assert _ids(_get()) == expected
    assert pages.count(("Scan", os.environ[EVENTS_TABLE_ENV])) >= 14
    assert pages.count(("Query", os.environ[EXAMS_TABLE_ENV])) >= 3
    assert pages.count(("Scan", os.environ[BELTS_TABLE_ENV])) >= len(SEED_BELTS)


def test_rn019_route_exam_in_progress_on_the_last_page_still_hides_the_other_events(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(4):
        _put_exam(_exam(f"event-old{index}", ExamStatus.APPROVED))
    _put_exam(_exam("event-zz-last"))
    _one_item_per_page(monkeypatch)

    assert _body(_get()) == []


# --- route: nothing is written, whatever the answer ------------------------------


def test_rn019_no_answer_of_the_route_writes_anything(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _confirm(MARCH)["statusCode"] == 201
    before = dynamodb_snapshot()
    calls = _record_calls(monkeypatch)

    statuses = [
        _get()["statusCode"],
        _get(OTHER_GUARDIAN)["statusCode"],
        _get(EXAMINER)["statusCode"],
        _get(None)["statusCode"],
        _get(student_id="missing")["statusCode"],
        _get(student_id="")["statusCode"],
    ]

    assert statuses == [200, 404, 403, 401, 404, 404]
    assert {operation for operation, _ in calls} <= {"GetItem", "Scan", "Query"}
    monkeypatch.undo()
    assert dynamodb_snapshot() == before


def test_rn019_the_answer_does_not_depend_on_the_guardian_group_constant() -> None:
    # The route refuses examiners; it does not ask for the ``responsavel``
    # group, which self sign-up users may lack.
    for groups in (frozenset(), frozenset({GUARDIAN_GROUP}), frozenset({MASTER_GROUP})):
        notice_rules.ensure_guardian(User(sub="u", email=None, groups=groups))


# --- route: path ids the shared lists of #92 do not send to this route ---------


def test_rn019_path_id_at_the_limit_is_read_and_answers_like_a_missing_id(
    academy: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 1024 bytes is the longest id accepted: it reaches the GetItem and is a
    # plain 404; one byte more never reaches the DynamoDB.
    calls = _record_calls(monkeypatch)

    for student_id in ("x" * 1024, "é" * 512):
        _assert_error(_get(student_id=student_id), 404, NOT_FOUND)
    assert [operation for operation, _ in calls] == ["GetItem", "GetItem"]

    calls.clear()
    _assert_error(_get(student_id="x" * 1025), 404, NOT_FOUND)
    assert calls == []


@pytest.mark.parametrize(
    "student_id",
    [" ", "student 1", " student-1", "student-1 ", "student-1\n", "\x00", "../student-1", "%20"],
)
def test_rn019_odd_path_id_answers_like_a_missing_id(academy: None, student_id: str) -> None:
    # No trimming and no decoding: an odd id is another id, never Ana's.
    _assert_error(_get(student_id=student_id), 404, NOT_FOUND)


def test_rn019_refusals_log_no_error_and_no_student_data(
    academy: None, caplog: pytest.LogCaptureFixture
) -> None:
    # Only the application's own records: botocore's DEBUG shows the wire.
    with caplog.at_level("INFO"):
        _get(OTHER_GUARDIAN)
        _get(EXAMINER)
        _get(student_id="x" * 1025)
        _get(student_id="missing")

    assert [record for record in caplog.records if record.levelname in {"ERROR", "CRITICAL"}] == []
    logged = " | ".join(record.getMessage() for record in caplog.records)
    assert "Request rejected" in logged
    assert "Ana" not in logged
    assert "x" * 1025 not in logged


# --- route: agreement with the eligibility of the exam-day screen ---------------


def test_rn019_notice_agrees_with_the_eligibility_on_the_event_date_of_the_student_list(
    academy: None,
) -> None:
    # The exam-day screen reads GET /students?reference_date=<event date>;
    # with no exam yet, the notice of each open event must say the same.
    extra = (_event(date(2026, 8, 1), "event-past"), _event(date(2028, 2, 29), "event-leap"))
    for exam_event in extra:
        event_repo.create_event(exam_event)
    cases = {
        "student-late": make_student(since=date(2026, 9, 1)),
        "student-small": make_student(birth=date(2021, 3, 20), since=date(2025, 1, 10)),
        "student-verde": make_student(
            belt_name="Verde", birth=date(2011, 3, 21), since=date(2026, 9, 20)
        ),
        "student-last": make_student(belt_name=SEED_BELTS[-1].name, birth=date(1990, 1, 1)),
    }
    for student_id, student in cases.items():
        student_repo.create_student(replace(student, id=student_id, full_name=student_id))
    events = [DECEMBER, MARCH, *extra]
    seen = set()

    for student_id in (STUDENT_ID, *cases):
        notices = {notice["event_id"]: notice for notice in _body(_get(student_id=student_id))}
        for exam_event in events:
            event_id = exam_event.id
            listed = response_json(
                student_handlers.get_student(
                    api_event(
                        GUARDIAN,
                        path={"id": student_id},
                        query={"reference_date": exam_event.exam_date.isoformat()},
                    ),
                    None,
                )
            )["eligibility"]
            seen.add(listed["eligible"])
            if not listed["eligible"]:
                assert event_id not in notices, (student_id, event_id)
                continue
            notice = notices[event_id]
            assert (notice["target_belt_id"], notice["target_belt_name"], notice["kind"]) == (
                listed["target_belt_id"],
                listed["target_belt_name"],
                listed["kind"],
            ), (student_id, event_id)
    assert seen == {True, False}


def test_rn019_route_open_event_whose_date_has_passed_is_judged_on_its_own_date(
    academy: None,
) -> None:
    # Ana took the Cinza on 2026-03-14: on 2026-09-14 the six months are
    # complete, on 2026-09-13 they are not, whatever today is (2026-11-01).
    event_repo.create_event(_event(date(2026, 9, 13), "event-early"))
    event_repo.create_event(_event(date(2026, 9, 14), "event-exact"))

    assert _ids(_get()) == ["event-exact", DECEMBER.id, MARCH.id]
