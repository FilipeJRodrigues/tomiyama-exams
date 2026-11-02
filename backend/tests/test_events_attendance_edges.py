"""Edge cases of events (RN016) and attendance (RN005): input validation,
boundaries on the event date (RN001/RN002, 29/02, waiver at exactly 16),
reopened events, the § 9 acceptance flow and permissions."""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, belt_id, make_student, response_json

from domain.events import EventStatus, ExamEvent
from handlers import events as event_handlers
from handlers import exams as handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo

NOW = "2026-11-01T12:00:00+00:00"


def _event(exam_date: date = date(2027, 3, 13), status=EventStatus.OPEN, eid="ev-1") -> ExamEvent:
    ev = ExamEvent(eid, "Exame", exam_date, status, NOW, NOW)
    event_repo.create_event(ev)
    return ev


def _student(sid="student-1", name="Ana", **kw: Any):
    s = replace(make_student(**kw), id=sid, full_name=name)
    student_repo.create_student(s)
    return s


def _confirm(eid, body, user=EXAMINER):
    return handlers.confirm_attendance(api_event(user, path={"id": eid}, body=body), None)


def _create_ev(body):
    return event_handlers.create_event(api_event(EXAMINER, body=body), None)


# ---- events: inputs
@pytest.mark.parametrize(
    "body",
    [
        {"name": "x" * 81, "exam_date": "2027-03-13"},
        {"name": "   ", "exam_date": "2027-03-13"},
        {"name": 123, "exam_date": "2027-03-13"},
        {"name": ["a"], "exam_date": "2027-03-13"},
        {"name": "a", "exam_date": "13/03/2027"},
        {"name": "a", "exam_date": "2027-02-30"},
        {"name": "a", "exam_date": 20270313},
        {"name": "a", "exam_date": ["2027-03-13"]},
        {"name": "a", "exam_date": {"x": 1}},
        {"name": "a", "exam_date": True},
        {"name": "a", "exam_date": "2027-03-13", "status": "open"},
        {"name": "a", "exam_date": "2027-03-13", "status": ""},
        {"name": "a", "exam_date": "2027-03-13", "status": ["OPEN"]},
        {"name": "a", "exam_date": "2027-03-13", "status": {"a": 1}},
        {"name": "a", "exam_date": "2027-03-13", "status": 1},
        {"name": "a", "exam_date": "2027-03-13", "status": True},
        {"name": "a"},
        {"exam_date": "2027-03-13"},
        {},
    ],
)
def test_rn016_create_rejects_malformed_fields(aws: None, body: dict[str, Any]) -> None:
    r = _create_ev(body)
    assert r["statusCode"] == 400, (body, r["body"])


@pytest.mark.parametrize("raw", ["null", "[]", '"x"', "1", "", "{", "true"])
def test_rn016_create_rejects_non_object_body(aws: None, raw: str) -> None:
    ev = api_event(EXAMINER)
    ev["body"] = raw
    r = event_handlers.create_event(ev, None)
    assert r["statusCode"] == 400, r["body"]


def test_rn016_name_limit_counts_unicode_after_trim(aws: None) -> None:
    r = _create_ev({"name": "  " + "ç" * 80 + "  ", "exam_date": "2027-03-13"})
    assert r["statusCode"] == 201, r["body"]
    assert response_json(r)["name"] == "ç" * 80
    r = _create_ev({"name": "🥋" * 80, "exam_date": "2027-03-13"})
    assert r["statusCode"] == 201, r["body"]


def test_rn016_leap_day_exam_date(aws: None) -> None:
    assert _create_ev({"name": "a", "exam_date": "2028-02-29"})["statusCode"] == 201
    assert _create_ev({"name": "a", "exam_date": "2027-02-29"})["statusCode"] == 400


@pytest.mark.parametrize(
    "body",
    [
        {"exam_date": "2027-03-13"},
        {"name": "", "exam_date": "2027-03-13"},
        {"name": "a", "exam_date": "2027-03-14"},
        {"name": "a", "exam_date": "bad"},
        {"name": "a", "exam_date": 5},
        {"name": "a", "status": "closed"},
        {"name": "a", "status": ["CLOSED"]},
        {"name": "x" * 81},
    ],
)
def test_rn016_update_rejects_malformed_fields_without_saving(
    aws: None, body: dict[str, Any]
) -> None:
    ev = _event()
    r = event_handlers.update_event(api_event(EXAMINER, path={"id": ev.id}, body=body), None)
    assert r["statusCode"] == 400, (body, r["body"])
    stored = event_repo.get_event(ev.id)
    assert stored == ev


def test_rn016_update_blank_exam_date_keeps_date(aws: None) -> None:
    ev = _event()
    for d in ("", None):
        r = event_handlers.update_event(
            api_event(EXAMINER, path={"id": ev.id}, body={"name": "b", "exam_date": d}), None
        )
        assert r["statusCode"] == 200, r["body"]
        assert response_json(r)["exam_date"] == "2027-03-13"


def test_rn016_update_ignores_id_and_created_at(aws: None) -> None:
    ev = _event()
    r = event_handlers.update_event(
        api_event(
            EXAMINER,
            path={"id": ev.id},
            body={"name": "b", "id": "hack", "created_at": "x"},
        ),
        None,
    )
    assert r["statusCode"] == 200
    body = response_json(r)
    assert body["id"] == ev.id and body["created_at"] == NOW
    assert event_repo.get_event("hack") is None


def test_rn016_guardian_cannot_change_or_delete_event(aws: None) -> None:
    ev = _event()
    for fn, body in [
        (event_handlers.update_event, {"name": "x", "status": "CLOSED"}),
        (event_handlers.delete_event, None),
    ]:
        r = fn(api_event(GUARDIAN, path={"id": ev.id}, body=body), None)
        assert r["statusCode"] == 403
    assert event_repo.get_event(ev.id) == ev


def test_rn016_list_orders_by_exam_date_not_insertion(aws: None) -> None:
    _event(date(2027, 1, 1), eid="a")
    _event(date(2028, 1, 1), eid="b")
    _event(date(2026, 1, 1), eid="c")
    r = event_handlers.list_events(api_event(EXAMINER), None)
    assert [e["id"] for e in response_json(r)] == ["b", "a", "c"]


# ---- attendance: inputs
@pytest.mark.parametrize(
    "body",
    [{"student_id": 1}, {"student_id": ["s"]}, {"student_id": {"a": 1}}, {"student_id": True}],
)
def test_rn005_student_id_of_wrong_type(seeded: None, body: dict[str, Any]) -> None:
    ev = _event()
    r = _confirm(ev.id, body)
    assert r["statusCode"] == 400, r["body"]


@pytest.mark.parametrize("raw", ["null", "[]", "", "{", '"s"'])
def test_rn005_non_object_body(seeded: None, raw: str) -> None:
    ev = _event()
    e = api_event(EXAMINER, path={"id": ev.id})
    e["body"] = raw
    r = handlers.confirm_attendance(e, None)
    assert r["statusCode"] == 400, r["body"]


def test_rn005_student_id_is_trimmed(seeded: None) -> None:
    ev = _event()
    _student()
    r = _confirm(ev.id, {"student_id": "  student-1  "})
    assert r["statusCode"] == 201, r["body"]
    assert response_json(r)["student_id"] == "student-1"


def test_rn005_huge_student_id_is_not_500(seeded: None) -> None:
    ev = _event()
    r = _confirm(ev.id, {"student_id": "x" * 5000})
    assert r["statusCode"] in (400, 404), r["body"]


def test_rn005_guardian_cannot_confirm_own_student(seeded: None) -> None:
    ev = _event()
    _student()
    r = _confirm(ev.id, {"student_id": "student-1"}, user=GUARDIAN)
    assert r["statusCode"] == 403
    assert exam_repo.list_by_event(ev.id) == []


# ---- acceptance flow § 9
def test_rn005_acceptance_flow_section_9(seeded: None) -> None:
    ev = _event(date(2027, 3, 13))
    _student(belt_name="Cinza", birth=date(2018, 5, 10), since=date(2026, 3, 14))
    bruno = _student(
        "bruno", "Bruno", belt_name="Azul", birth=date(2019, 6, 1), since=date(2025, 1, 1)
    )
    r = _confirm(ev.id, {"student_id": "student-1"})
    assert r["statusCode"] == 201, r["body"]
    assert response_json(r)["target_belt_id"] == belt_id("Cinza/Azul")
    r = _confirm(ev.id, {"student_id": bruno.id})
    assert r["statusCode"] == 400
    assert response_json(r)["message"] == "Idade mínima para a faixa Azul/Amarela: 8 anos"


# ---- boundaries on event date
def test_rn005_rn001_birthday_on_event_date_is_eligible(seeded: None) -> None:
    # Azul -> Azul/Amarela requires 8 years; born 2019-03-13 turns 8 on 2027-03-13
    ev = _event(date(2027, 3, 13))
    _student(belt_name="Azul", birth=date(2019, 3, 13), since=date(2025, 1, 1))
    assert _confirm(ev.id, {"student_id": "student-1"})["statusCode"] == 201


def test_rn005_rn001_day_before_birthday_is_blocked(seeded: None) -> None:
    ev = _event(date(2027, 3, 12))
    _student(belt_name="Azul", birth=date(2019, 3, 13), since=date(2025, 1, 1))
    r = _confirm(ev.id, {"student_id": "student-1"})
    assert r["statusCode"] == 400


def test_rn005_rn001_born_on_leap_day(seeded: None) -> None:
    # born 2020-02-29 (Branca -> Branca/Cinza requires 4)
    ev = _event(date(2024, 2, 28))
    _student(belt_name="Branca", birth=date(2020, 2, 29), since=date(2023, 1, 1))
    assert _confirm(ev.id, {"student_id": "student-1"})["statusCode"] == 400
    ev2 = _event(date(2024, 2, 29), eid="ev-2")
    assert _confirm(ev2.id, {"student_id": "student-1"})["statusCode"] == 201


def test_rn005_rn002_exact_waiting_period_on_event_date(seeded: None) -> None:
    # Cinza -> Cinza/Azul needs 6 months; since 2026-09-13, event 2027-03-13 = 6 months
    ev = _event(date(2027, 3, 13))
    _student(belt_name="Cinza", birth=date(2018, 5, 10), since=date(2026, 9, 13))
    assert _confirm(ev.id, {"student_id": "student-1"})["statusCode"] == 201
    ev2 = _event(date(2027, 3, 12), eid="ev-2")
    r = _confirm(ev2.id, {"student_id": "student-1"})
    assert r["statusCode"] == 400
    assert "faltam 1" in response_json(r)["message"]


def test_rn005_rn002_waiver_from_exactly_16_on_event_date(seeded: None) -> None:
    ev = _event(date(2027, 3, 13))
    _student(belt_name="Verde", stripes=1, birth=date(2011, 3, 13), since=date(2027, 1, 1))
    assert _confirm(ev.id, {"student_id": "student-1"})["statusCode"] == 201
    ev2 = _event(date(2027, 3, 12), eid="ev-2")
    assert _confirm(ev2.id, {"student_id": "student-1"})["statusCode"] == 400


def test_rn005_rn004_stripe_exam_needs_half_waiting(seeded: None) -> None:
    # Verde 0 stripes -> STRIPE towards Roxa: 12 // 2 = 6 months
    ev = _event(date(2027, 3, 13))
    _student(belt_name="Verde", birth=date(2014, 1, 1), since=date(2026, 9, 13))
    r = _confirm(ev.id, {"student_id": "student-1"})
    assert r["statusCode"] == 201, r["body"]
    assert response_json(r)["kind"] == "STRIPE"


def test_rn005_rn003_brown_belt_is_federation_exam(seeded: None) -> None:
    ev = _event()
    _student(belt_name="Marrom", stripes=2, birth=date(2000, 1, 1), since=date(2020, 1, 1))
    r = _confirm(ev.id, {"student_id": "student-1"})
    assert r["statusCode"] == 400
    assert response_json(r)["message"] == "Faixa preta é exame da federação"


def test_rn005_reopened_event_accepts_attendance(seeded: None) -> None:
    ev = _event(status=EventStatus.CLOSED)
    _student()
    assert _confirm(ev.id, {"student_id": "student-1"})["statusCode"] == 400
    r = event_handlers.update_event(
        api_event(EXAMINER, path={"id": ev.id}, body={"name": "x", "status": "OPEN"}), None
    )
    assert r["statusCode"] == 200
    assert _confirm(ev.id, {"student_id": "student-1"})["statusCode"] == 201


def test_rn005_exam_keeps_target_after_belt_change(seeded: None) -> None:
    ev1 = _event(eid="ev-1")
    ev2 = _event(eid="ev-2")
    s = _student()
    assert _confirm(ev1.id, {"student_id": s.id})["statusCode"] == 201
    student_repo.save_student(replace(s, current_belt_id=belt_id("Cinza/Azul")))
    r = _confirm(ev2.id, {"student_id": s.id})
    assert r["statusCode"] == 201, r["body"]
    assert response_json(r)["target_belt_id"] == belt_id("Azul")
    assert exam_repo.get_exam(ev1.id, s.id).target_belt_id == belt_id("Cinza/Azul")


def test_rn018_guardian_cannot_delete_student_after_attendance(seeded: None) -> None:
    ev = _event()
    _student()
    assert _confirm(ev.id, {"student_id": "student-1"})["statusCode"] == 201
    r = student_handlers.delete_student(api_event(GUARDIAN, path={"id": "student-1"}), None)
    assert r["statusCode"] == 409, r["body"]
