"""Edge cases of the exam counter and of the update_item rewrites (RN005, RN013, RN016, RN018)."""

from dataclasses import replace
from datetime import date
from decimal import Decimal
from typing import Any
from unittest import mock

import pytest
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    GUARDIAN,
    OTHER_GUARDIAN,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EVENTS_TABLE_ENV, STUDENTS_TABLE_ENV, table

TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"


@pytest.fixture(autouse=True)
def _fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)


def _event(eid: str = "ev-1", status: EventStatus = EventStatus.OPEN) -> ExamEvent:
    ev = ExamEvent(eid, "Exame", date(2027, 3, 13), status, NOW, NOW)
    event_repo.create_event(ev)
    return ev


def _student(**kw: Any):
    s = replace(make_student(), **kw)
    student_repo.create_student(s)
    return s


def _confirm(eid: str, sid: str):
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": eid}, body={"student_id": sid}), None
    )


def _payload(s, **changes: Any) -> dict[str, Any]:
    p = {
        "full_name": s.full_name,
        "birth_date": s.birth_date.isoformat(),
        "current_belt_id": s.current_belt_id,
        "current_belt_since": s.current_belt_since.isoformat(),
        "stripes": s.stripes,
        "federation_id": s.federation_id,
        "active": s.active,
    }
    return p | changes


def _put_student(user, sid, body):
    return student_handlers.update_student(api_event(user, path={"id": sid}, body=body), None)


def _raw(env, key):
    return table(env).get_item(Key={"id": key})["Item"]


def _decide_failed(event_id: str, student_id: str) -> None:
    """Have the sensei fail the exam, so it is no longer in progress (RN005)."""
    sensei = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=sensei.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    path = {"id": event_id, "student_id": student_id}
    response = exam_handlers.decide_exam(
        api_event(sensei, path=path, body={"result": "FAILED"}), None
    )
    assert response["statusCode"] == 200, response["body"]


def test_rn013_examiner_changes_graduation_after_exam(seeded: None) -> None:
    _event()
    s = _student()
    assert _confirm("ev-1", s.id)["statusCode"] == 201
    # While the exam is in progress nobody changes the graduation (RN005).
    _decide_failed("ev-1", s.id)
    r = _put_student(EXAMINER, s.id, _payload(s, stripes=2))
    assert r["statusCode"] == 200, r["body"]
    item = _raw(STUDENTS_TABLE_ENV, s.id)
    assert int(item["stripes"]) == 2 and int(item["exam_count"]) == 1


def test_rn013_guardian_edits_other_fields_after_exam(seeded: None) -> None:
    _event()
    s = _student(federation_id="FPJ-1")
    assert _confirm("ev-1", s.id)["statusCode"] == 201
    r = _put_student(
        GUARDIAN, s.id, _payload(s, full_name="Ana Maria", federation_id=None, active=False)
    )
    assert r["statusCode"] == 200, r["body"]
    item = _raw(STUDENTS_TABLE_ENV, s.id)
    assert "federation_id" not in item
    assert item["active"] is False
    assert item["full_name"] == "Ana Maria"
    assert int(item["exam_count"]) == 1
    got = student_repo.get_student(s.id)
    assert got is not None and got.federation_id is None and got.active is False
    # empty string federation id
    r = _put_student(GUARDIAN, s.id, _payload(s, federation_id="   "))
    assert r["statusCode"] in (200, 400), r["body"]
    if r["statusCode"] == 200:
        assert response_json(r)["federation_id"] in (None, "")


def test_rn013_guardian_graduation_change_after_exam_is_403(seeded: None) -> None:
    _event()
    s = _student()
    assert _confirm("ev-1", s.id)["statusCode"] == 201
    r = _put_student(GUARDIAN, s.id, _payload(s, stripes=1))
    assert r["statusCode"] == 403
    assert "Somente examinadores" in response_json(r)["message"]
    # reenvio dos mesmos valores
    r = _put_student(GUARDIAN, s.id, _payload(s))
    assert r["statusCode"] == 200


def test_rn013_other_guardian_cannot_edit(seeded: None) -> None:
    s = _student()
    r = _put_student(OTHER_GUARDIAN, s.id, _payload(s, full_name="X"))
    assert r["statusCode"] == 404


def test_rn016_event_put_after_exams_keeps_count_and_close_blocks(seeded: None) -> None:
    _event()
    s = _student()
    s2 = _student(id="student-2")
    assert _confirm("ev-1", s.id)["statusCode"] == 201
    r = event_handlers.update_event(
        api_event(EXAMINER, path={"id": "ev-1"}, body={"name": "Novo", "status": "CLOSED"}), None
    )
    assert r["statusCode"] == 200, r["body"]
    assert int(_raw(EVENTS_TABLE_ENV, "ev-1")["exam_count"]) == 1
    r = _confirm("ev-1", s2.id)
    assert r["statusCode"] == 400
    r = event_handlers.update_event(
        api_event(EXAMINER, path={"id": "ev-1"}, body={"name": "Novo", "status": "OPEN"}), None
    )
    assert r["statusCode"] == 200
    assert _confirm("ev-1", s2.id)["statusCode"] == 201
    assert int(_raw(EVENTS_TABLE_ENV, "ev-1")["exam_count"]) == 2
    r = event_handlers.delete_event(api_event(EXAMINER, path={"id": "ev-1"}), None)
    assert r["statusCode"] == 409


def test_rn005_failed_attendance_does_not_increment(seeded: None) -> None:
    _event()
    s = _student()
    assert _confirm("ev-1", s.id)["statusCode"] == 201
    # duplicate bypassing the early check
    with mock.patch.object(exam_repo, "get_exam", return_value=None):
        r = _confirm("ev-1", s.id)
    assert r["statusCode"] == 409
    assert int(_raw(EVENTS_TABLE_ENV, "ev-1")["exam_count"]) == 1
    assert int(_raw(STUDENTS_TABLE_ENV, s.id)["exam_count"]) == 1


def test_rn005_event_closed_between_read_and_write(seeded: None) -> None:
    ev = _event()
    s = _student()
    real = event_repo.get_event

    def closing(eid):
        got = real(eid)
        event_repo.save_event(replace(ev, status=EventStatus.CLOSED))
        return got

    with mock.patch.object(event_repo, "get_event", side_effect=closing):
        r = _confirm("ev-1", s.id)
    assert r["statusCode"] == 400, r["body"]
    assert response_json(r)["message"] == "Evento encerrado"
    assert "exam_count" not in _raw(STUDENTS_TABLE_ENV, s.id)


def test_rn005_event_deleted_between_read_and_write(seeded: None) -> None:
    _event()
    s = _student()
    real = event_repo.get_event

    def deleting(eid):
        got = real(eid)
        event_repo.delete_event(eid)
        return got

    with mock.patch.object(event_repo, "get_event", side_effect=deleting):
        r = _confirm("ev-1", s.id)
    assert r["statusCode"] == 404, r["body"]
    # ADD must not have resurrected the event
    assert table(EVENTS_TABLE_ENV).get_item(Key={"id": "ev-1"}).get("Item") is None


def test_rn005_student_deactivated_between_read_and_write(seeded: None) -> None:
    _event()
    s = _student()
    real = student_repo.get_student

    def deactivating(sid):
        got = real(sid)
        student_repo.save_student(replace(got, active=False))
        return got

    with mock.patch.object(student_repo, "get_student", side_effect=deactivating):
        r = _confirm("ev-1", s.id)
    assert r["statusCode"] == 400, r["body"]
    assert response_json(r)["message"] == "Aluno inativo não pode fazer exame"


def test_rn005_student_deleted_between_read_and_write(seeded: None) -> None:
    _event()
    s = _student()
    real = student_repo.get_student

    def deleting(sid):
        got = real(sid)
        student_repo.delete_student(sid)
        return got

    with mock.patch.object(student_repo, "get_student", side_effect=deleting):
        r = _confirm("ev-1", s.id)
    assert r["statusCode"] == 404, r["body"]
    assert table(STUDENTS_TABLE_ENV).get_item(Key={"id": s.id}).get("Item") is None
    assert "exam_count" not in _raw(EVENTS_TABLE_ENV, "ev-1")


def test_rn005_stripes_stored_as_decimal_matches(seeded: None) -> None:
    _event()
    s = _student(stripes=2)
    table(STUDENTS_TABLE_ENV).update_item(
        Key={"id": s.id},
        UpdateExpression="SET stripes = :s",
        ExpressionAttributeValues={":s": Decimal("2")},
    )
    r = _confirm("ev-1", s.id)
    assert r["statusCode"] in (201, 400), r["body"]
    if r["statusCode"] == 400:
        # not eligible is fine; it must not be 409 student changed
        assert "mudaram" not in response_json(r)["message"]


def test_rn005_transaction_conflict_exhausted_is_409(seeded: None, monkeypatch) -> None:
    _event()
    s = _student()
    monkeypatch.setattr(exam_repo, "_BACKOFF_SECONDS", 0)
    err = ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "x"},
            "CancellationReasons": [
                {"Code": "None"},
                {"Code": "TransactionConflict"},
                {"Code": "None"},
            ],
        },
        "TransactWriteItems",
    )
    with mock.patch.object(exam_repo, "_transact_create", side_effect=err):
        r = _confirm("ev-1", s.id)
    assert r["statusCode"] == 409
    assert "Tente de novo" in response_json(r)["message"]


def test_rn018_delete_student_with_zero_count(seeded: None) -> None:
    s = _student()
    table(STUDENTS_TABLE_ENV).update_item(
        Key={"id": s.id},
        UpdateExpression="SET exam_count = :z",
        ExpressionAttributeValues={":z": 0},
    )
    r = student_handlers.delete_student(api_event(GUARDIAN, path={"id": s.id}), None)
    assert r["statusCode"] == 204


def test_rn013_guardian_graduation_change_without_exams_keeps_values(seeded: None) -> None:
    s = _student(federation_id="F1")
    r = _put_student(GUARDIAN, s.id, _payload(s, current_belt_id=belt_id("Azul"), stripes=1))
    assert r["statusCode"] == 200, r["body"]
    item = _raw(STUDENTS_TABLE_ENV, s.id)
    assert item["federation_id"] == "F1"
    assert item["owner_id"] == s.owner_id
    assert item["created_at"] == s.created_at


def test_rn013_put_missing_student_is_404(seeded: None) -> None:
    s = make_student()
    r = _put_student(EXAMINER, "nope", _payload(s))
    assert r["statusCode"] == 404
    assert table(STUDENTS_TABLE_ENV).get_item(Key={"id": "nope"}).get("Item") is None


def test_rn016_put_missing_event_is_404(aws: None) -> None:
    r = event_handlers.update_event(
        api_event(EXAMINER, path={"id": "nope"}, body={"name": "X"}), None
    )
    assert r["statusCode"] == 404
    assert table(EVENTS_TABLE_ENV).get_item(Key={"id": "nope"}).get("Item") is None
