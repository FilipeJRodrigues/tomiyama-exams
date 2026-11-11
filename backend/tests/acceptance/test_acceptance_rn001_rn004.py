"""Acceptance, rule by rule: eligibility (RN001–RN004 of § 5 of the requirements).

Every step goes through the HTTP handlers (see ``acceptance_support``). The
eligibility is computed on the reference date: the event's date (2027-03-13)
and, without an event, today. The clock stays on ``SCENARIO_NOW`` (2026-11-01)
the whole time, attendances included, so a student who only completes the age
or the waiting period on the event date tells the two dates apart: blocked
today, eligible (and accepted) at the event.

The ages and waiting periods are the ones of the belt table of § 4.
"""

import pytest
from acceptance_support import (
    BELT_SEQUENCE,
    DECISION_AT,
    EVENT_DATE,
    MSG_BLACK_BELT,
    graduation,
    msg_minimum_age,
    msg_waiting_period,
    open_academy,
)

OCTOBER_EVENT_DATE = "2027-10-09"


def test_rn001_minimum_age_in_full_years_on_the_event_date(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    # Azul/Amarela asks for 8 years and 6 months on the Azul. Both have 6 full months
    # today and 10 on the event date, so the age is the only possible block.
    aline = academy.register(guardian, "Aline", "Azul", birth="2019-03-13", since="2026-05-01")
    bento = academy.register(guardian, "Bento", "Azul", birth="2019-03-14", since="2026-05-01")
    # Verde asks for 12 years and 12 months on the Laranja. Both are 11 on the event
    # date and on the Laranja for exactly 12 full months then.
    caio = academy.register(guardian, "Caio", "Laranja", birth="2015-06-01", since="2026-03-13")
    dora = academy.register(
        guardian, "Dora", "Laranja", birth="2015-06-01", since="2026-03-13", stripes=1
    )
    blocked_azul_amarela = academy.eligibility(
        "Azul/Amarela", "BELT", msg_minimum_age("Azul/Amarela", 8)
    )
    blocked_verde = academy.eligibility("Verde", "BELT", msg_minimum_age("Verde", 12))

    # On the event date: Aline turns 8 that very day (full years), Bento the day after.
    at_event = academy.roster(EVENT_DATE)
    assert (at_event["Aline"]["age"], at_event["Bento"]["age"]) == (8, 7)
    assert at_event["Aline"]["eligibility"] == academy.eligibility("Azul/Amarela", "BELT")
    assert at_event["Bento"]["eligibility"] == blocked_azul_amarela
    # The stripe exam does not change the belt and does not check the age; the belt
    # exam of the same age does.
    assert (at_event["Caio"]["age"], at_event["Dora"]["age"]) == (11, 11)
    assert at_event["Caio"]["eligibility"] == academy.eligibility("Verde", "STRIPE")
    assert at_event["Dora"]["eligibility"] == blocked_verde

    # Without an event the reference is today (2026-11-01): Aline is still 7.
    today = academy.roster()
    assert (today["Aline"]["age"], today["Bento"]["age"]) == (7, 7)
    assert today["Aline"]["eligibility"] == blocked_azul_amarela
    assert today["Bento"]["eligibility"] == blocked_azul_amarela

    # The attendance follows the event date, not today (the clock is still on 2026-11-01).
    exam = academy.attend(exam_event, aline)
    assert (exam["kind"], exam["target_belt_id"]) == ("BELT", academy.belt_id("Azul/Amarela"))
    academy.attendance_refused(exam_event, bento, 400, msg_minimum_age("Azul/Amarela", 8))
    exam = academy.attend(exam_event, caio)
    assert (exam["kind"], exam["target_belt_id"]) == ("STRIPE", academy.belt_id("Verde"))
    academy.attendance_refused(exam_event, dora, 400, msg_minimum_age("Verde", 12))
    assert [exam["student_name"] for exam in academy.event_exams(exam_event)] == ["Aline", "Caio"]


def test_rn002_waiting_period_in_full_months_on_the_event_date(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    # Cinza/Azul asks for 6 months on the Cinza (and 6 years; they are 8).
    elisa = academy.register(guardian, "Elisa", "Cinza", birth="2018-05-10", since="2026-09-13")
    fabio = academy.register(guardian, "Fabio", "Cinza", birth="2018-05-10", since="2026-09-14")
    # Roxa asks for 12 months on the Verde: 6 in the stripe exam (half, integer division).
    # They are 14 on the event date (Roxa asks for 13; the waiver starts at 16).
    gabi = academy.register(guardian, "Gabi", "Verde", birth="2013-01-01", since="2026-09-13")
    hugo = academy.register(guardian, "Hugo", "Verde", birth="2013-01-01", since="2026-09-14")
    iara = academy.register(
        guardian, "Iara", "Verde", birth="2013-01-01", since="2026-09-13", stripes=1
    )
    # 5 full months on the Verde on the event date, for the Roxa belt exam (12 months):
    # Joana turns 16 on the event date itself, Kleber the day after.
    joana = academy.register(
        guardian, "Joana", "Verde", birth="2011-03-13", since="2026-10-01", stripes=1
    )
    kleber = academy.register(
        guardian, "Kleber", "Verde", birth="2011-03-14", since="2026-10-01", stripes=1
    )

    at_event = academy.roster(EVENT_DATE)
    # Exactly 6 full months on the event date; one day less is 5 full months.
    assert at_event["Elisa"]["eligibility"] == academy.eligibility("Cinza/Azul", "BELT")
    assert at_event["Fabio"]["eligibility"] == academy.eligibility(
        "Cinza/Azul", "BELT", msg_waiting_period(6, 1)
    )
    # Stripe exam: half of the 12 months.
    assert at_event["Gabi"]["eligibility"] == academy.eligibility("Roxa", "STRIPE")
    assert at_event["Hugo"]["eligibility"] == academy.eligibility(
        "Roxa", "STRIPE", msg_waiting_period(6, 1)
    )
    # Belt exam with the same 6 months: the full 12 are asked.
    assert at_event["Iara"]["eligibility"] == academy.eligibility(
        "Roxa", "BELT", msg_waiting_period(12, 6)
    )
    # Waived from 16 full years on (CBJ art. 2º §4º).
    assert (at_event["Joana"]["age"], at_event["Kleber"]["age"]) == (16, 15)
    assert at_event["Joana"]["eligibility"] == academy.eligibility("Roxa", "BELT")
    assert at_event["Kleber"]["eligibility"] == academy.eligibility(
        "Roxa", "BELT", msg_waiting_period(12, 7)
    )

    # Without an event the reference is today (2026-11-01): Elisa has 1 full month on
    # the Cinza, and Joana is still 15, with 1 full month on the Verde.
    today = academy.roster()
    assert today["Elisa"]["eligibility"] == academy.eligibility(
        "Cinza/Azul", "BELT", msg_waiting_period(6, 5)
    )
    assert today["Joana"]["age"] == 15
    assert today["Joana"]["eligibility"] == academy.eligibility(
        "Roxa", "BELT", msg_waiting_period(12, 11)
    )

    # The attendance follows the event date, not today (the clock is still on 2026-11-01).
    academy.attend(exam_event, elisa)
    academy.attendance_refused(exam_event, fabio, 400, msg_waiting_period(6, 1))
    assert academy.attend(exam_event, gabi)["kind"] == "STRIPE"
    academy.attendance_refused(exam_event, hugo, 400, msg_waiting_period(6, 1))
    academy.attendance_refused(exam_event, iara, 400, msg_waiting_period(12, 6))
    assert academy.attend(exam_event, joana)["kind"] == "BELT"
    academy.attendance_refused(exam_event, kleber, 400, msg_waiting_period(12, 7))
    assert [exam["student_name"] for exam in academy.event_exams(exam_event)] == [
        "Elisa",
        "Gabi",
        "Joana",
    ]


def test_rn003_target_is_the_next_belt_and_marrom_has_none(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    # The sequence of § 4: Branca = 0 ... Marrom = 11.
    assert [(belt["sort_order"], belt["name"]) for belt in academy.belts.values()] == list(
        enumerate(BELT_SEQUENCE)
    )
    # One adult per belt: neither the age nor the waiting period blocks any of them.
    students = {
        belt_name: academy.register(guardian, f"Aluno {order:02d}", belt_name)
        for order, belt_name in enumerate(BELT_SEQUENCE)
    }

    roster = academy.roster(EVENT_DATE)
    assert len(roster) == len(BELT_SEQUENCE)
    for order, belt_name in enumerate(BELT_SEQUENCE[:-1]):
        row = roster[f"Aluno {order:02d}"]
        following = BELT_SEQUENCE[order + 1]
        assert row["current_belt_name"] == belt_name
        # Always the belt immediately after, never a skipped one, in both kinds of exam.
        assert (row["eligibility"]["target_belt_name"], row["eligibility"]["eligible"]) == (
            following,
            True,
        ), belt_name
        assert row["eligibility"]["target_belt_id"] == academy.belt_id(following)
    # Marrom has no next belt: the black belt is the federation's exam.
    assert roster["Aluno 11"]["eligibility"] == {
        "eligible": False,
        "kind": None,
        "target_belt_id": None,
        "target_belt_name": None,
        "reasons": [MSG_BLACK_BELT],
    }

    exam = academy.attend(exam_event, students["Cinza"])
    assert exam["target_belt_id"] == academy.belt_id("Cinza/Azul")
    exam = academy.attend(exam_event, students["Roxa"])
    assert exam["target_belt_id"] == academy.belt_id("Marrom")
    academy.attendance_refused(exam_event, students["Marrom"], 400, MSG_BLACK_BELT)
    assert [exam["student_name"] for exam in academy.event_exams(exam_event)] == [
        "Aluno 02",
        "Aluno 10",
    ]


def test_rn004_stripe_exam_before_the_belt_exam_on_intermediate_belts(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Roxa",))
    guardian = academy.guardian()
    exam_event = academy.event()
    # Adults: no age or waiting-period block; only the kind of exam is at stake.
    vera = academy.register(guardian, "Vera", "Verde")
    academy.register(guardian, "Laranja sem grau", "Laranja")
    academy.register(guardian, "Roxa sem grau", "Roxa")
    academy.register(guardian, "Verde com 1 grau", "Verde", stripes=1)
    academy.register(guardian, "Laranja com 2 graus", "Laranja", stripes=2)
    academy.register(guardian, "Amarela e laranja", "Amarela/Laranja")
    academy.register(guardian, "Cinza", "Cinza")

    roster = academy.roster(EVENT_DATE)
    # Intermediate belt with no stripe: stripe exam, towards the next belt.
    assert roster["Vera"]["eligibility"] == academy.eligibility("Roxa", "STRIPE")
    assert roster["Laranja sem grau"]["eligibility"] == academy.eligibility("Verde", "STRIPE")
    assert roster["Roxa sem grau"]["eligibility"] == academy.eligibility("Marrom", "STRIPE")
    # With 1 stripe or more: belt exam.
    assert roster["Verde com 1 grau"]["eligibility"] == academy.eligibility("Roxa", "BELT")
    assert roster["Laranja com 2 graus"]["eligibility"] == academy.eligibility("Verde", "BELT")
    # Basic belts: always a belt exam (Amarela/Laranja is basic, though Laranja is not).
    assert roster["Amarela e laranja"]["eligibility"] == academy.eligibility("Laranja", "BELT")
    assert roster["Cinza"]["eligibility"] == academy.eligibility("Cinza/Azul", "BELT")

    # Verde with no stripe: the exam is a stripe exam with the items of the target belt.
    exam = academy.attend(exam_event, vera)
    assert (exam["kind"], exam["target_belt_id"], exam["status"]) == (
        "STRIPE",
        academy.belt_id("Roxa"),
        "IN_PROGRESS",
    )
    sheet = academy.sheet(exam_event, vera)
    assert sheet["target_belt"]["name"] == "Roxa"
    assert len(sheet["items"]) == 116  # the Roxa sheet of Appendix A
    assert {item["belt_id"] for item in sheet["items"]} == {academy.belt_id("Roxa")}

    # Approved: 1 stripe more, still on the Verde since the same date.
    academy.clock.set(DECISION_AT)
    academy.decide(exam_event, vera, "APPROVED")
    after = academy.student(vera)
    assert graduation(after) == (academy.belt_id("Verde"), vera["current_belt_since"], 1)

    # With the stripe, the next exam is the belt exam for the Roxa.
    october = academy.event(OCTOBER_EVENT_DATE, "Exame outubro/2027")
    assert academy.roster(OCTOBER_EVENT_DATE)["Vera"]["eligibility"] == academy.eligibility(
        "Roxa", "BELT"
    )
    exam = academy.attend(october, vera)
    assert (exam["kind"], exam["target_belt_id"]) == ("BELT", academy.belt_id("Roxa"))
