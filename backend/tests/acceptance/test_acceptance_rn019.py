"""Acceptance: the exam notice to the guardian (RN019 of § 5 of the requirements).

Every step goes through the HTTP handlers (see ``acceptance_support``). The
guardian reads ``GET /students/{id}/exam-notices`` on the student's profile
(§ 6.2). The clock starts on ``SCENARIO_NOW`` (2026-11-01); the events are on
2027-03-13 and 2027-10-09, so a student who only completes the waiting period
or the age on the event's date tells that date from today.
"""

from typing import Any

import pytest
from acceptance_support import (
    DECISION_AT,
    EVENT_DATE,
    EVENT_NAME,
    EXAM_DAY_AT,
    MSG_LOGIN,
    MSG_STUDENT_NOT_FOUND,
    Academy,
    msg_minimum_age,
    msg_waiting_period,
    ok,
    open_academy,
    refused,
)

from domain.users import User
from handlers import events as event_handlers
from handlers import students as student_handlers

OCTOBER_EVENT_DATE = "2027-10-09"
OCTOBER_EVENT_NAME = "Exame outubro/2027"
MSG_GUARDIANS_ONLY = "Esta área é dos responsáveis"


def _notices(guardian: User, student: dict[str, Any]) -> list[dict[str, Any]]:
    """``GET /students/{id}/exam-notices`` as the guardian."""
    return ok(student_handlers.list_student_exam_notices, guardian, path={"id": student["id"]})


def _notice(
    academy: Academy, exam_event: dict[str, Any], belt_name: str, kind: str = "BELT"
) -> dict[str, Any]:
    """The notice of ``exam_event``: only the event, the target belt and the kind."""
    return {
        "event_id": exam_event["id"],
        "event_name": exam_event["name"],
        "event_date": exam_event["exam_date"],
        "target_belt_id": academy.belt_id(belt_name),
        "target_belt_name": belt_name,
        "kind": kind,
    }


def test_rn019_guardian_sees_the_exam_notice_of_each_open_event_the_student_is_eligible_for(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    other_guardian = academy.guardian("outra-familia@example.com")
    # Created out of date order: the notices come earliest event first.
    october = academy.event(OCTOBER_EVENT_DATE, OCTOBER_EVENT_NAME)
    march = academy.event()
    assert (march["name"], march["exam_date"]) == (EVENT_NAME, EVENT_DATE)
    ana = academy.register(guardian, "Ana", "Cinza")
    davi = academy.register(guardian, "Davi", "Cinza")
    vera = academy.register(guardian, "Vera", "Verde")
    ivo = academy.register(guardian, "Ivo", "Cinza", active=False)
    # Cinza/Azul asks for 6 months on the Cinza: 2 today, 6 on the March event.
    lia = academy.register(guardian, "Lia", "Cinza", birth="2018-05-10", since="2026-09-01")
    # Azul/Amarela asks for 8 years: 7 on the March event, 8 on the October one.
    bruno = academy.register(guardian, "Bruno", "Azul", birth="2019-06-20", since="2026-07-01")

    # Active and eligible: one notice per open event, with the date the screen
    # shows as "Exame de faixas dia dd/mm/aaaa" and the target of the exam.
    both = [_notice(academy, march, "Cinza/Azul"), _notice(academy, october, "Cinza/Azul")]
    assert _notices(guardian, ana) == both
    assert [notice["event_date"] for notice in both] == ["2027-03-13", "2027-10-09"]
    assert _notices(guardian, vera) == [
        _notice(academy, march, "Roxa", "STRIPE"),
        _notice(academy, october, "Roxa", "STRIPE"),
    ]

    # The eligibility is the one of the event's date, not today's: Lia is blocked
    # today and has both notices; Bruno has only the one of the event he is 8 at.
    assert academy.roster()["Lia"]["eligibility"]["reasons"] == [msg_waiting_period(6, 4)]
    assert _notices(guardian, lia) == both
    assert academy.roster(EVENT_DATE)["Bruno"]["eligibility"]["reasons"] == [
        msg_minimum_age("Azul/Amarela", 8)
    ]
    assert _notices(guardian, bruno) == [_notice(academy, october, "Azul/Amarela")]

    # An inactive student has no notice.
    assert _notices(guardian, ivo) == []

    # Only the guardian of the student reads it (RN013); the examiners do not use it.
    path = {"id": ana["id"]}
    notices_route = student_handlers.list_student_exam_notices
    refused(notices_route, other_guardian, 404, MSG_STUDENT_NOT_FOUND, path=path)
    refused(notices_route, None, 401, MSG_LOGIN, path=path)
    for examiner in (academy.examiner, academy.sensei, academy.master):
        refused(notices_route, examiner, 403, MSG_GUARDIANS_ONLY, path=path)
    # The guardian still has no access to the events themselves (RN016).
    refused(event_handlers.list_events, guardian, 403, "Esta área é dos examinadores")

    # The attendance is confirmed at the door (exam in progress): the notice of
    # that event stays until the decision, and the one of the other event goes.
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(march, ana)
    academy.attend(march, davi)
    assert _notices(guardian, ana) == [_notice(academy, march, "Cinza/Azul")]
    # Reading the notices changes nothing (the notice only informs).
    assert academy.history(ana)[0]["status"] == "IN_PROGRESS"
    assert _notices(guardian, vera)[0] == _notice(academy, march, "Roxa", "STRIPE")

    # Decided, the notice of that event goes away. Failed, Ana keeps the Cinza and
    # is eligible in October; approved, Davi's next notice is for the Azul.
    academy.clock.set(DECISION_AT)
    academy.decide(march, ana, "FAILED")
    academy.decide(march, davi, "APPROVED")
    assert _notices(guardian, ana) == [_notice(academy, october, "Cinza/Azul")]
    assert _notices(guardian, davi) == [_notice(academy, october, "Azul")]

    # A closed event has no notice; reopened, it has again.
    academy.set_event_status(october, "CLOSED")
    assert _notices(guardian, ana) == []
    assert _notices(guardian, vera) == [_notice(academy, march, "Roxa", "STRIPE")]
    academy.set_event_status(october, "OPEN")
    assert _notices(guardian, ana) == [_notice(academy, october, "Cinza/Azul")]


def test_rn019_exam_in_progress_in_a_closed_event_holds_every_other_notice(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    march = academy.event()
    october = academy.event(OCTOBER_EVENT_DATE, OCTOBER_EVENT_NAME)
    ana = academy.register(guardian, "Ana", "Cinza")

    academy.clock.set(EXAM_DAY_AT)
    academy.attend(march, ana)
    # RN008a: the closed event still waits for the sensei's decision, so Ana
    # still has an exam in progress in another event than October.
    academy.set_event_status(march, "CLOSED")
    assert _notices(guardian, ana) == []

    academy.clock.set(DECISION_AT)
    academy.decide(march, ana, "FAILED")
    assert _notices(guardian, ana) == [_notice(academy, october, "Cinza/Azul")]
