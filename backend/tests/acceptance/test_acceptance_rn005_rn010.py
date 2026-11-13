"""Acceptance, rule by rule: the exam (RN005–RN010 and RN008a of § 5 of the requirements).

Every step goes through the HTTP handlers (see ``acceptance_support``). RN011
(the PDF certificate) is out of scope here (card #98).

Most exams are of an adult on the Branca, for the Branca/Cinza: the smallest
sheet of Appendix A (2 theory and 4 practice items), with no age or waiting
period in the way. Each test sets up its own academy, on a fixed clock.

Not covered here, because one handler call at a time cannot race another: the
"inclusive em corrida simultânea" parts of RN005 and the two simultaneous marks
of RN006. They are covered by the repository tests and by ``tests/regression/``.
"""

from typing import Any

import pytest
from acceptance_support import (
    DECISION_AT,
    EVENT_DATE,
    EXAM_DAY_AT,
    MSG_ALREADY_CONFIRMED,
    MSG_EVENT_CLOSED,
    MSG_EXAM_DECIDED,
    MSG_EXAMINERS_ONLY,
    MSG_GRADUATION_IN_PROGRESS,
    MSG_GRADUATION_LOCKED,
    MSG_IN_PROGRESS_ELSEWHERE,
    MSG_ITEM_NOT_IN_BELT,
    MSG_LOGIN,
    MSG_NO_SENSEI,
    MSG_ONLY_SENSEI,
    MSG_STUDENT_INACTIVE,
    Academy,
    exam_path,
    graduation,
    msg_minimum_age,
    ok,
    open_academy,
    refused,
)

from handlers import exams as exam_handlers
from handlers import requirements as requirement_handlers
from handlers import settings as settings_handlers
from handlers import students as student_handlers

OCTOBER_EVENT_DATE = "2027-10-09"
OCTOBER_EVENT_NAME = "Exame outubro/2027"
# The exam day a little later (10:00 in Brasília), for a second marking.
LATER_AT = "2027-03-13T13:00:00+00:00"

# What is stored of a student (the view also has fields computed on the day).
_STORED_FIELDS = (
    "id",
    "owner_id",
    "full_name",
    "birth_date",
    "current_belt_id",
    "current_belt_since",
    "stripes",
    "federation_id",
    "active",
)


def _stored(student: dict[str, Any]) -> dict[str, Any]:
    return {field: student[field] for field in _STORED_FIELDS}


def _answers(sheet: dict[str, Any]) -> dict[str, Any]:
    """The answer of each item of a sheet, by item id (None: not marked)."""
    return {item["id"]: item["answer"] for item in sheet["items"]}


def _of_kind(sheet: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """The items of ``kind`` of a sheet, in sheet order."""
    return [item for item in sheet["items"] if item["kind"] == kind]


def _unmark_refused(
    academy: Academy,
    exam_event: dict[str, Any],
    student: dict[str, Any],
    item: dict[str, Any],
    status: int,
    message: str,
) -> None:
    refused(
        exam_handlers.unmark_answer,
        academy.examiner,
        status,
        message,
        path={**exam_path(exam_event, student), "requirement_id": item["id"]},
    )


# --- RN005 ---------------------------------------------------------------------------------


def test_rn005_attendance_of_active_and_eligible_student_in_open_event(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    closed_event = academy.set_event_status(
        academy.event(OCTOBER_EVENT_DATE, OCTOBER_EVENT_NAME), "CLOSED"
    )
    ana = academy.register(guardian, "Ana", "Cinza")
    vera = academy.register(guardian, "Vera", "Verde")
    davi = academy.register(guardian, "Davi", "Cinza")
    ivo = academy.register(guardian, "Ivo", "Cinza", active=False)
    # 7 on the event date; Azul/Amarela asks for 8.
    bruno = academy.register(guardian, "Bruno", "Azul", birth="2019-06-20", since="2026-07-01")
    blocked = msg_minimum_age("Azul/Amarela", 8)

    academy.clock.set(EXAM_DAY_AT)
    # The exam-day list has only the active students (§ 6.3); Ivo is inactive.
    roster = academy.roster(EVENT_DATE)
    assert list(roster) == ["Ana", "Bruno", "Davi", "Vera"]
    inactive = ok(student_handlers.list_students, academy.examiner, query={"active": "false"})
    assert [student["full_name"] for student in inactive] == ["Ivo"]
    assert roster["Bruno"]["eligibility"]["reasons"] == [blocked]

    # Active and eligible, open event: the exam is created "Em andamento", with the
    # target belt and the kind computed (RN003/RN004).
    exam = academy.attend(exam_event, ana)
    assert {key: exam[key] for key in ("event_id", "student_id", "student_name")} == {
        "event_id": exam_event["id"],
        "student_id": ana["id"],
        "student_name": "Ana",
    }
    assert (exam["target_belt_id"], exam["kind"], exam["status"]) == (
        academy.belt_id("Cinza/Azul"),
        "BELT",
        "IN_PROGRESS",
    )
    assert (exam["decided_by_id"], exam["decided_at"]) == (None, None)
    stripe_exam = academy.attend(exam_event, vera)
    assert (stripe_exam["target_belt_id"], stripe_exam["kind"], stripe_exam["status"]) == (
        academy.belt_id("Roxa"),
        "STRIPE",
        "IN_PROGRESS",
    )
    assert academy.event_exams(exam_event) == [exam, stripe_exam]

    # Only an examiner confirms the attendance.
    for caller, status, message in ((guardian, 403, MSG_EXAMINERS_ONLY), (None, 401, MSG_LOGIN)):
        refused(
            exam_handlers.confirm_attendance,
            caller,
            status,
            message,
            body={"student_id": davi["id"]},
            path={"id": exam_event["id"]},
        )
    # Inactive, ineligible (with the reason), repeated and closed event: all refused.
    academy.attendance_refused(exam_event, ivo, 400, MSG_STUDENT_INACTIVE)
    academy.attendance_refused(exam_event, bruno, 400, blocked)
    academy.attendance_refused(exam_event, ana, 409, MSG_ALREADY_CONFIRMED)
    academy.attendance_refused(closed_event, davi, 400, MSG_EVENT_CLOSED)

    # Nothing was recorded by the refusals.
    assert academy.event_exams(exam_event) == [exam, stripe_exam]
    assert academy.event_exams(closed_event) == []
    for student in (davi, ivo, bruno):
        assert academy.history(student) == []


def test_rn005_one_exam_in_progress_at_a_time(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    march = academy.event()
    october = academy.event(OCTOBER_EVENT_DATE, OCTOBER_EVENT_NAME)
    ana = academy.register(guardian, "Ana", "Branca")
    bia = academy.register(guardian, "Bia", "Branca")

    academy.clock.set(EXAM_DAY_AT)
    academy.attend(march, ana)
    academy.attend(march, bia)
    # With an exam in progress in March, October refuses both, and records nothing.
    academy.attendance_refused(october, ana, 409, MSG_IN_PROGRESS_ELSEWHERE)
    academy.attendance_refused(october, bia, 409, MSG_IN_PROGRESS_ELSEWHERE)
    assert academy.event_exams(october) == []
    assert [exam["event_id"] for exam in academy.history(ana)] == [march["id"]]

    # The sensei's decision, failed or approved, frees the student for another event.
    academy.clock.set(DECISION_AT)
    academy.decide(march, ana, "FAILED")
    academy.decide(march, bia, "APPROVED")
    again = academy.attend(october, ana)
    assert (again["status"], again["target_belt_id"]) == (
        "IN_PROGRESS",
        academy.belt_id("Branca/Cinza"),
    )
    onwards = academy.attend(october, bia)
    assert (onwards["status"], onwards["target_belt_id"]) == (
        "IN_PROGRESS",
        academy.belt_id("Cinza"),
    )
    assert [exam["student_name"] for exam in academy.event_exams(october)] == ["Ana", "Bia"]


def test_rn005_graduation_cannot_change_while_the_exam_is_in_progress(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Cinza")
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)

    changes: tuple[dict[str, Any], ...] = (
        {"current_belt_id": academy.belt_id("Azul")},
        {"current_belt_since": "2026-01-10"},
        {"stripes": 1},
    )
    for change in changes:
        # Nobody changes the graduation, not even an examiner (409); for the guardian
        # the lock of RN013 (403) comes first.
        for examiner in (academy.examiner, academy.sensei, academy.master):
            academy.update_student_refused(examiner, ana, 409, MSG_GRADUATION_IN_PROGRESS, **change)
        academy.update_student_refused(guardian, ana, 403, MSG_GRADUATION_LOCKED, **change)
    # A refused edit records nothing, the other fields sent with it included.
    academy.update_student_refused(
        academy.examiner, ana, 409, MSG_GRADUATION_IN_PROGRESS, full_name="Outro nome", stripes=1
    )
    assert _stored(academy.student(ana)) == _stored(ana)

    # The other fields stay editable, and resending the same graduation is accepted.
    edited = academy.update_student(academy.examiner, ana, full_name="Ana Souza")
    edited = academy.update_student(guardian, edited, federation_id="SP-123")
    assert _stored(academy.student(ana)) == {
        **_stored(ana),
        "full_name": "Ana Souza",
        "federation_id": "SP-123",
    }

    # Once the exam is decided, the examiner changes the graduation again.
    academy.clock.set(DECISION_AT)
    academy.decide(exam_event, ana, "FAILED")
    academy.update_student(academy.examiner, edited, stripes=1)
    assert graduation(academy.student(ana)) == (
        academy.belt_id("Cinza"),
        ana["current_belt_since"],
        1,
    )


# --- RN006 ---------------------------------------------------------------------------------


def test_rn006_marking_replaces_and_records_who_marked(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Branca/Cinza", "Cinza"))
    other_examiner = academy.add_examiner("examinador@example.com", "Davi")
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Branca")
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)

    sheet = academy.sheet(exam_event, ana)
    items = sheet["items"]
    assert len(items) == 6  # the Branca/Cinza sheet of Appendix A
    assert all(answer is None for answer in _answers(sheet).values())

    # Right or wrong, item by item, with who marked.
    marked = academy.mark(exam_event, ana, items[0], True)
    assert marked["answer"] == {
        "requirement_id": items[0]["id"],
        "correct": True,
        "marked_by": academy.examiner.sub,
        "marked_at": EXAM_DAY_AT,
    }
    assert academy.mark(exam_event, ana, items[1], False)["answer"]["correct"] is False

    # Marking again replaces (a correction before the decision), with the new marker.
    academy.clock.set(LATER_AT)
    replaced = academy.mark(exam_event, ana, items[0], False, by=other_examiner)
    assert replaced["answer"] == {
        "requirement_id": items[0]["id"],
        "correct": False,
        "marked_by": other_examiner.sub,
        "marked_at": LATER_AT,
    }
    expected = {
        **{item["id"]: None for item in items},
        items[0]["id"]: replaced["answer"],
        items[1]["id"]: {
            "requirement_id": items[1]["id"],
            "correct": False,
            "marked_by": academy.examiner.sub,
            "marked_at": EXAM_DAY_AT,
        },
    }
    assert _answers(academy.sheet(exam_event, ana)) == expected

    # The item has to be of the target belt: one of the Cinza sheet is refused.
    cinza_items = ok(
        requirement_handlers.list_requirements,
        academy.examiner,
        query={"belt_id": academy.belt_id("Cinza")},
    )
    assert len(cinza_items) == 14
    academy.mark_refused(exam_event, ana, cinza_items[0], 400, MSG_ITEM_NOT_IN_BELT)
    # Only examiners mark.
    academy.mark_refused(exam_event, ana, items[2], 403, MSG_EXAMINERS_ONLY, by=guardian)
    academy.mark_refused(exam_event, ana, items[2], 401, MSG_LOGIN, anonymous=True)
    assert _answers(academy.sheet(exam_event, ana)) == expected

    # Blocked with the event closed: a new mark and a replacement alike.
    academy.set_event_status(exam_event, "CLOSED")
    academy.mark_refused(exam_event, ana, items[2], 400, MSG_EVENT_CLOSED)
    academy.mark_refused(exam_event, ana, items[0], 400, MSG_EVENT_CLOSED)
    assert _answers(academy.sheet(exam_event, ana)) == expected
    academy.set_event_status(exam_event, "OPEN")
    expected[items[2]["id"]] = academy.mark(exam_event, ana, items[2], True)["answer"]

    # Blocked with the exam decided.
    academy.clock.set(DECISION_AT)
    academy.decide(exam_event, ana, "FAILED")
    academy.mark_refused(exam_event, ana, items[3], 409, MSG_EXAM_DECIDED)
    academy.mark_refused(exam_event, ana, items[0], 409, MSG_EXAM_DECIDED)
    assert _answers(academy.sheet(exam_event, ana)) == expected


# --- RN007 ---------------------------------------------------------------------------------


def test_rn007_percent_by_kind_over_every_item_of_the_kind(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Cinza/Azul",))
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Cinza")
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)

    # The Cinza/Azul sheet of Appendix A: 11 theory and 13 practice items.
    sheet = academy.sheet(exam_event, ana)
    theory, practice = _of_kind(sheet, "THEORY"), _of_kind(sheet, "PRACTICE")
    assert (len(theory), len(practice)) == (11, 13)
    assert sheet["summary"] == {
        "THEORY": {"kind": "THEORY", "total": 11, "marked": 0, "correct": 0, "percent": 0.0},
        "PRACTICE": {"kind": "PRACTICE", "total": 13, "marked": 0, "correct": 0, "percent": 0.0},
    }

    # Theory: 6 of 11 marked, 5 right. Practice: all 13 marked, 5 right.
    for position, item in enumerate(theory[:6]):
        academy.mark(exam_event, ana, item, position != 3)
    for position, item in enumerate(practice):
        last = academy.mark(exam_event, ana, item, position < 5)
    # Each kind on its own, over every item of the kind (an unmarked item counts as
    # not right: 5 / 11 = 45.45..., not 5 / 6 = 83.3), with one decimal (45.5 and
    # 38.5, not 45.4 and 38.4), and "marcados X de N".
    expected = {
        "THEORY": {"kind": "THEORY", "total": 11, "marked": 6, "correct": 5, "percent": 45.5},
        "PRACTICE": {"kind": "PRACTICE", "total": 13, "marked": 13, "correct": 5, "percent": 38.5},
    }
    assert last["summary"] == expected
    assert academy.sheet(exam_event, ana)["summary"] == expected

    # A corrected item changes the percentage: 6 / 11 = 54.5.
    corrected = academy.mark(exam_event, ana, theory[3], True)
    assert corrected["summary"]["THEORY"] == {
        "kind": "THEORY",
        "total": 11,
        "marked": 6,
        "correct": 6,
        "percent": 54.5,
    }

    # Always recomputed, never stored: a new theory item on the sheet changes the
    # percentage of the same answers (6 / 12 = 50.0), and removing it brings it back.
    # (The master: only the admin master changes the main profile, #144.)
    new_item = ok(
        requirement_handlers.create_requirement,
        academy.master,
        201,
        body={
            "belt_id": academy.belt_id("Cinza/Azul"),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": "Item novo na folha",
        },
    )
    summary = academy.sheet(exam_event, ana)["summary"]
    assert summary["THEORY"] == {
        "kind": "THEORY",
        "total": 12,
        "marked": 6,
        "correct": 6,
        "percent": 50.0,
    }
    assert summary["PRACTICE"] == expected["PRACTICE"]
    ok(requirement_handlers.delete_requirement, academy.master, 204, path={"id": new_item["id"]})
    assert academy.sheet(exam_event, ana)["summary"]["THEORY"]["percent"] == 54.5

    # The decision does not freeze it either: the summary is the same after it.
    academy.clock.set(DECISION_AT)
    before = academy.sheet(exam_event, ana)["summary"]
    academy.decide(exam_event, ana, "APPROVED")
    assert academy.sheet(exam_event, ana)["summary"] == before


def test_rn007_belt_without_items_of_a_kind_has_no_percent(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Branca/Cinza",))
    guardian = academy.guardian()
    exam_event = academy.event()
    bia = academy.register(guardian, "Bia", "Branca")
    # The master removes the 2 theory items of the Branca/Cinza sheet (RN017; only
    # the admin master changes the main profile, #144).
    theory = ok(
        requirement_handlers.list_requirements,
        academy.examiner,
        query={"belt_id": academy.belt_id("Branca/Cinza"), "kind": "THEORY"},
    )
    assert len(theory) == 2
    for item in theory:
        ok(requirement_handlers.delete_requirement, academy.master, 204, path={"id": item["id"]})

    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, bia)
    sheet = academy.sheet(exam_event, bia)
    # No theory item: no percentage (the screen shows "—"), not 0%.
    assert sheet["summary"] == {
        "THEORY": {"kind": "THEORY", "total": 0, "marked": 0, "correct": 0, "percent": None},
        "PRACTICE": {"kind": "PRACTICE", "total": 4, "marked": 0, "correct": 0, "percent": 0.0},
    }
    marked = academy.mark(exam_event, bia, sheet["items"][0], True)
    assert marked["summary"] == {
        "THEORY": {"kind": "THEORY", "total": 0, "marked": 0, "correct": 0, "percent": None},
        "PRACTICE": {"kind": "PRACTICE", "total": 4, "marked": 1, "correct": 1, "percent": 25.0},
    }


# --- RN008 and RN008a ----------------------------------------------------------------------


def test_rn008_only_the_sensei_decides_whatever_the_percent(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Branca/Cinza",))
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Branca")
    bia = academy.register(guardian, "Bia", "Branca")
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)
    academy.attend(exam_event, bia)
    # Bia gets every item right (100% and 100%); Ana has nothing marked (0% and 0%).
    for item in academy.sheet(exam_event, bia)["items"]:
        academy.mark(exam_event, bia, item, True)
    all_right = {"THEORY": 100.0, "PRACTICE": 100.0}
    nothing = {"THEORY": 0.0, "PRACTICE": 0.0}

    def percents(student: dict[str, Any]) -> dict[str, float]:
        summary = academy.sheet(exam_event, student)["summary"]
        return {kind: score["percent"] for kind, score in summary.items()}

    assert (percents(ana), percents(bia)) == (nothing, all_right)

    academy.clock.set(DECISION_AT)
    # Another examiner and the master (who is not the sensei) do not decide.
    for not_sensei in (academy.examiner, academy.master):
        for result in ("APPROVED", "FAILED"):
            academy.decide_refused(
                exam_event, ana, 403, MSG_ONLY_SENSEI, by=not_sensei, result=result
            )
    academy.decide_refused(exam_event, ana, 403, MSG_EXAMINERS_ONLY, by=guardian)
    academy.decide_refused(exam_event, ana, 401, MSG_LOGIN, by=None)
    assert [exam["status"] for exam in academy.event_exams(exam_event)] == [
        "IN_PROGRESS",
        "IN_PROGRESS",
    ]
    assert graduation(academy.student(ana)) == graduation(ana)

    # The percentage is only a support: the sensei approves the 0% and fails the 100%.
    approved = academy.decide(exam_event, ana, "APPROVED")["exam"]
    failed = academy.decide(exam_event, bia, "FAILED")["exam"]
    # Who decided and when are recorded.
    assert (approved["status"], approved["decided_by_id"], approved["decided_at"]) == (
        "APPROVED",
        academy.sensei.sub,
        DECISION_AT,
    )
    assert (failed["status"], failed["decided_by_id"], failed["decided_at"]) == (
        "FAILED",
        academy.sensei.sub,
        DECISION_AT,
    )
    for student, status in ((ana, "APPROVED"), (bia, "FAILED")):
        exam = academy.sheet(exam_event, student)["exam"]
        assert (exam["status"], exam["decided_by_id"], exam["decided_at"]) == (
            status,
            academy.sensei.sub,
            DECISION_AT,
        )
    assert (percents(ana), percents(bia)) == (nothing, all_right)
    assert academy.student(ana)["current_belt_name"] == "Branca/Cinza"
    assert academy.student(bia)["current_belt_name"] == "Branca"


def test_rn008_without_a_sensei_nobody_decides(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, with_sensei=False)
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Branca")
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)

    academy.clock.set(DECISION_AT)
    assert ok(settings_handlers.get_settings, academy.examiner)["sensei"] is None
    for examiner in (academy.sensei, academy.master, academy.examiner):
        academy.decide_refused(exam_event, ana, 409, MSG_NO_SENSEI, by=examiner)
    assert academy.sheet(exam_event, ana)["exam"]["status"] == "IN_PROGRESS"

    # With the sensei set in the settings, the same request is accepted.
    academy.choose_sensei(academy.sensei)
    decided = academy.decide(exam_event, ana, "APPROVED")
    assert (decided["exam"]["status"], decided["exam"]["decided_by_id"]) == (
        "APPROVED",
        academy.sensei.sub,
    )


def test_rn008_only_the_master_chooses_the_sensei(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Branca")
    bia = academy.register(guardian, "Bia", "Branca")
    caio = academy.register(guardian, "Caio", "Branca")
    academy.clock.set(EXAM_DAY_AT)
    for student in (ana, bia, caio):
        academy.attend(exam_event, student)
    academy.clock.set(DECISION_AT)

    def sensei_id() -> str | None:
        return ok(settings_handlers.get_settings, academy.examiner)["sensei_user_id"]

    # Another examiner, or the sensei, does not choose, switch or remove the sensei.
    academy.choose_sensei_refused(academy.examiner, by=academy.examiner)
    academy.choose_sensei_refused(academy.examiner, by=academy.sensei)
    academy.choose_sensei_refused(None, by=academy.examiner)
    academy.choose_sensei_refused(None, by=academy.sensei)
    assert sensei_id() == academy.sensei.sub
    # The refused examiner is still not the sensei.
    academy.decide_refused(exam_event, ana, 403, MSG_ONLY_SENSEI, by=academy.examiner)
    academy.decide(exam_event, ana, "APPROVED")

    # The master switches the sensei: the new one decides, the former one no longer.
    chosen = academy.choose_sensei(academy.examiner)
    assert chosen["sensei_user_id"] == academy.examiner.sub
    assert sensei_id() == academy.examiner.sub
    academy.decide_refused(exam_event, bia, 403, MSG_ONLY_SENSEI, by=academy.sensei)
    academy.decide_refused(exam_event, bia, 403, MSG_ONLY_SENSEI, by=academy.master)
    decided = academy.decide(exam_event, bia, "FAILED", by=academy.examiner)
    assert decided["exam"]["decided_by_id"] == academy.examiner.sub

    # The master only decides when the master is the sensei.
    academy.choose_sensei(academy.master)
    academy.decide_refused(exam_event, caio, 403, MSG_ONLY_SENSEI, by=academy.examiner)
    decided = academy.decide(exam_event, caio, "APPROVED", by=academy.master)
    assert (decided["exam"]["status"], decided["exam"]["decided_by_id"]) == (
        "APPROVED",
        academy.master.sub,
    )


def test_rn008a_closed_event_still_accepts_the_decision(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Branca/Cinza",))
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Branca")
    bia = academy.register(guardian, "Bia", "Branca")
    caio = academy.register(guardian, "Caio", "Branca")
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)
    academy.attend(exam_event, bia)
    items = academy.sheet(exam_event, ana)["items"]
    academy.mark(exam_event, ana, items[0], True)

    closed = academy.set_event_status(exam_event, "CLOSED")
    assert closed["status"] == "CLOSED"
    # Closed: no attendance and no marking (RN016).
    academy.attendance_refused(exam_event, caio, 400, MSG_EVENT_CLOSED)
    academy.mark_refused(exam_event, ana, items[1], 400, MSG_EVENT_CLOSED)

    # The sensei still decides the exams in progress of the closed event.
    academy.clock.set(DECISION_AT)
    approved = academy.decide(exam_event, ana, "APPROVED")
    failed = academy.decide(exam_event, bia, "FAILED")
    assert (approved["exam"]["status"], failed["exam"]["status"]) == ("APPROVED", "FAILED")
    assert graduation(academy.student(ana)) == (academy.belt_id("Branca/Cinza"), EVENT_DATE, 0)
    assert graduation(academy.student(bia)) == graduation(bia)
    # Only the decision goes on: the event is still closed for the rest.
    assert academy.sheet(exam_event, ana)["event"]["status"] == "CLOSED"
    academy.attendance_refused(exam_event, caio, 400, MSG_EVENT_CLOSED)


# --- RN009 ---------------------------------------------------------------------------------

# Three different days: the attendance is confirmed three days before the event and
# the sensei decides three days after it. The new belt date can only be the event's.
PRESENCE_AT = "2027-03-10T12:00:00+00:00"
LATE_DECISION_AT = "2027-03-16T13:00:00+00:00"


def test_rn009_approved_belt_exam_moves_to_the_target_belt_on_the_event_date_with_no_stripes(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    assert exam_event["exam_date"] == EVENT_DATE == "2027-03-13"
    # Belt exams of students who have stripes: the approval takes them back to 0.
    lia = academy.register(guardian, "Lia", "Laranja", stripes=1)
    vitor = academy.register(guardian, "Vitor", "Verde", stripes=3)
    ana = academy.register(guardian, "Ana", "Cinza")

    academy.clock.set(PRESENCE_AT)
    for student, target in ((lia, "Verde"), (vitor, "Roxa"), (ana, "Cinza/Azul")):
        exam = academy.attend(exam_event, student)
        assert (exam["kind"], exam["target_belt_id"]) == ("BELT", academy.belt_id(target))
        assert exam["created_at"] == PRESENCE_AT

    academy.clock.set(LATE_DECISION_AT)
    for student, target in ((lia, "Verde"), (vitor, "Roxa"), (ana, "Cinza/Azul")):
        decided = academy.decide(exam_event, student, "APPROVED")
        assert decided["exam"]["decided_at"] == LATE_DECISION_AT
        # Target belt, since the EVENT date (not the attendance's 2027-03-10, the
        # decision's 2027-03-16 or the former 2026-03-14), with 0 stripes.
        new_graduation = (academy.belt_id(target), "2027-03-13", 0)
        assert graduation(decided["student"]) == new_graduation
        for viewer in (academy.examiner, guardian):
            seen = ok(student_handlers.get_student, viewer, path={"id": student["id"]})
            assert graduation(seen) == new_graduation
            assert seen["current_belt_name"] == target
        # Nothing else of the student changes.
        assert _stored(academy.student(student)) == {
            **_stored(student),
            "current_belt_id": new_graduation[0],
            "current_belt_since": new_graduation[1],
            "stripes": new_graduation[2],
        }


def test_rn009_approved_stripe_exam_adds_one_stripe_and_keeps_the_belt(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    lia = academy.register(guardian, "Lia", "Laranja")
    rui = academy.register(guardian, "Rui", "Roxa")

    academy.clock.set(PRESENCE_AT)
    for student in (lia, rui):
        assert academy.attend(exam_event, student)["kind"] == "STRIPE"

    academy.clock.set(LATE_DECISION_AT)
    for student, belt_name in ((lia, "Laranja"), (rui, "Roxa")):
        decided = academy.decide(exam_event, student, "APPROVED")
        # One stripe more; the belt and its date stay (not the target belt, not the
        # event date).
        kept = (academy.belt_id(belt_name), student["current_belt_since"], 1)
        assert graduation(decided["student"]) == kept
        assert _stored(academy.student(student)) == {**_stored(student), "stripes": 1}


def test_rn009_failed_exam_changes_nothing(user_pool: str, monkeypatch: pytest.MonkeyPatch) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    lia = academy.register(guardian, "Lia", "Laranja", stripes=2)  # belt exam
    vera = academy.register(guardian, "Vera", "Verde")  # stripe exam

    academy.clock.set(PRESENCE_AT)
    assert academy.attend(exam_event, lia)["kind"] == "BELT"
    assert academy.attend(exam_event, vera)["kind"] == "STRIPE"

    academy.clock.set(LATE_DECISION_AT)
    for student in (lia, vera):
        decided = academy.decide(exam_event, student, "FAILED")
        assert (decided["exam"]["status"], decided["student"]) == ("FAILED", None)
        assert _stored(academy.student(student)) == _stored(student)
    # The next exam is the same one again.
    october = academy.roster(OCTOBER_EVENT_DATE)
    assert october["Lia"]["eligibility"] == academy.eligibility("Verde", "BELT")
    assert october["Vera"]["eligibility"] == academy.eligibility("Roxa", "STRIPE")


# --- RN010 ---------------------------------------------------------------------------------


def test_rn010_decided_exam_is_final(user_pool: str, monkeypatch: pytest.MonkeyPatch) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Branca/Cinza",))
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Branca")
    bia = academy.register(guardian, "Bia", "Branca")
    academy.clock.set(EXAM_DAY_AT)
    for student in (ana, bia):
        academy.attend(exam_event, student)
        items = academy.sheet(exam_event, student)["items"]
        academy.mark(exam_event, student, items[0], True)
        academy.mark(exam_event, student, items[1], False)

    academy.clock.set(DECISION_AT)
    academy.decide(exam_event, ana, "APPROVED")
    academy.decide(exam_event, bia, "FAILED")
    decided = {student["id"]: academy.sheet(exam_event, student) for student in (ana, bia)}
    students = {student["id"]: _stored(academy.student(student)) for student in (ana, bia)}
    assert graduation(students[ana["id"]]) == (academy.belt_id("Branca/Cinza"), EVENT_DATE, 0)

    # A day later, nothing of the decided exams changes: answers or decision.
    academy.clock.set("2027-03-16T13:00:00+00:00")
    for student in (ana, bia):
        # Replacing an answer, marking a new item and unmarking.
        academy.mark_refused(exam_event, student, items[0], 409, MSG_EXAM_DECIDED)
        academy.mark_refused(exam_event, student, items[2], 409, MSG_EXAM_DECIDED)
        _unmark_refused(academy, exam_event, student, items[0], 409, MSG_EXAM_DECIDED)
        # Deciding again, with the same result or the other one.
        for result in ("APPROVED", "FAILED"):
            academy.decide_refused(
                exam_event, student, 409, MSG_EXAM_DECIDED, by=academy.sensei, result=result
            )
        assert academy.sheet(exam_event, student) == decided[student["id"]]
        # The approval is not applied twice, and the failure does not become one.
        assert _stored(academy.student(student)) == students[student["id"]]
