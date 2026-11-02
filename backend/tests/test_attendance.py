"""Attendance confirmation (RN005): creates the exam in an open event (RN016).

Eligibility is evaluated on the event date (§ 5). Uniqueness per (event,
student) holds under concurrency, and a closed or deleted event never gets an
exam, even when it changes between the read and the write.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    EXAMINER_SUB,
    GUARDIAN,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain import dates
from domain.belts import SEED_BELTS
from domain.eligibility import ExamKind, evaluate
from domain.errors import ConflictError, ValidationError
from domain.events import EventStatus, ExamEvent
from domain.exams import ExamStatus, confirm_attendance
from domain.students import Student
from handlers import events as event_handlers
from handlers import exams as handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo

EVENT_DATE = date(2027, 3, 20)
# A fixed "today" before the event: tests never depend on the real clock.
TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"


@pytest.fixture(autouse=True)
def _fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)


def _event(*, status: EventStatus = EventStatus.OPEN, exam_date: date = EVENT_DATE) -> ExamEvent:
    exam_event = ExamEvent(
        id=f"event-{exam_date.isoformat()}-{status.value}",
        name="Exame março/2027",
        exam_date=exam_date,
        status=status,
        created_at=NOW,
        updated_at=NOW,
    )
    event_repo.create_event(exam_event)
    return exam_event


def _student(student_id: str = "student-1", name: str = "Ana", **kwargs: Any) -> Student:
    student = replace(make_student(**kwargs), id=student_id, full_name=name)
    student_repo.create_student(student)
    return student


def _confirm(event_id: str, student_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.confirm_attendance(
        api_event(user, path={"id": event_id}, body={"student_id": student_id}), None
    )


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response)["message"] == message


# --- success: target belt and kind (RN003/RN004) ---------------------------------


def test_rn005_belt_exam_creates_exam_in_progress(seeded: None) -> None:
    exam_event = _event()
    student = _student(belt_name="Cinza", birth=date(2018, 5, 10), since=date(2026, 3, 14))
    response = _confirm(exam_event.id, student.id)
    assert response["statusCode"] == 201, response["body"]
    body = response_json(response)
    assert body["event_id"] == exam_event.id
    assert body["student_id"] == student.id
    assert body["student_name"] == "Ana"
    assert body["target_belt_id"] == belt_id("Cinza/Azul")
    assert body["kind"] == "BELT"
    assert body["status"] == "IN_PROGRESS"
    assert body["created_by"] == EXAMINER_SUB
    assert body["created_at"]
    assert body["id"]
    assert body["decided_by_id"] is None
    assert body["decided_at"] is None
    assert body["notes"] is None

    stored = exam_repo.get_exam(exam_event.id, student.id)
    assert stored is not None
    assert stored.id == body["id"]
    assert stored.kind == ExamKind.BELT
    assert stored.status == ExamStatus.IN_PROGRESS
    assert stored.created_by == EXAMINER_SUB


def test_rn005_green_without_stripes_is_stripe_exam_towards_purple(seeded: None) -> None:
    exam_event = _event()
    # 14 years old, 7 months on the belt: stripe exam needs half of 12 months.
    student = _student(belt_name="Verde", birth=date(2012, 6, 1), since=date(2026, 8, 1), stripes=0)
    response = _confirm(exam_event.id, student.id)
    assert response["statusCode"] == 201, response["body"]
    body = response_json(response)
    assert body["kind"] == "STRIPE"
    assert body["target_belt_id"] == belt_id("Roxa")


def test_rn005_green_with_one_stripe_is_belt_exam_to_purple(seeded: None) -> None:
    exam_event = _event()
    student = _student(belt_name="Verde", birth=date(2012, 1, 1), since=date(2026, 1, 1), stripes=1)
    response = _confirm(exam_event.id, student.id)
    assert response["statusCode"] == 201, response["body"]
    body = response_json(response)
    assert body["kind"] == "BELT"
    assert body["target_belt_id"] == belt_id("Roxa")


# --- eligibility on the event date -------------------------------------------------


def test_rn005_ineligible_today_but_eligible_on_event_date_is_accepted(seeded: None) -> None:
    exam_event = _event()
    student = _student(belt_name="Cinza", birth=date(2018, 5, 10), since=date(2026, 9, 1))
    assert not evaluate(student, SEED_BELTS, TODAY).eligible
    response = _confirm(exam_event.id, student.id)
    assert response["statusCode"] == 201, response["body"]


def test_rn005_eligible_today_but_ineligible_on_event_date_is_rejected(seeded: None) -> None:
    exam_event = _event(exam_date=date(2026, 3, 1))
    student = _student(belt_name="Cinza", birth=date(2018, 5, 10), since=date(2025, 10, 1))
    assert evaluate(student, SEED_BELTS, TODAY).eligible
    response = _confirm(exam_event.id, student.id)
    _assert_rejected(response, 400, "Carência mínima de 6 meses na faixa atual (faltam 1)")
    assert exam_repo.get_exam(exam_event.id, student.id) is None


def test_rn005_age_counted_on_event_date(seeded: None) -> None:
    # Turns 6 (minimum for Cinza/Azul) after today but before the event.
    exam_event = _event()
    student = _student(belt_name="Cinza", birth=date(2021, 1, 15), since=date(2025, 1, 1))
    assert not evaluate(student, SEED_BELTS, TODAY).eligible
    assert _confirm(exam_event.id, student.id)["statusCode"] == 201


# --- ineligibility reasons (RN001–RN003) -------------------------------------------


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        (
            {"belt_name": "Cinza", "birth": date(2021, 6, 1), "since": date(2025, 1, 1)},
            "Idade mínima para a faixa Cinza/Azul: 6 anos",
        ),
        (
            {"belt_name": "Cinza", "birth": date(2018, 5, 10), "since": date(2027, 1, 10)},
            "Carência mínima de 6 meses na faixa atual (faltam 4)",
        ),
        (
            {"belt_name": "Marrom", "birth": date(2005, 1, 1), "since": date(2020, 1, 1)},
            "Faixa preta é exame da federação",
        ),
        (
            {"belt_name": "Cinza", "birth": date(2021, 6, 1), "since": date(2027, 1, 10)},
            "Idade mínima para a faixa Cinza/Azul: 6 anos; "
            "Carência mínima de 6 meses na faixa atual (faltam 4)",
        ),
    ],
    ids=["age", "waiting-period", "brown-has-no-next", "age-and-waiting-period"],
)
def test_rn005_ineligible_student_is_rejected_with_reason(
    seeded: None, kwargs: dict[str, Any], message: str
) -> None:
    exam_event = _event()
    student = _student(**kwargs)
    _assert_rejected(_confirm(exam_event.id, student.id), 400, message)
    assert exam_repo.list_by_event(exam_event.id) == []


def test_rn005_inactive_student_is_rejected(seeded: None) -> None:
    exam_event = _event()
    student = _student(active=False)
    _assert_rejected(_confirm(exam_event.id, student.id), 400, "Aluno inativo não pode fazer exame")
    assert exam_repo.list_by_event(exam_event.id) == []


def test_rn005_closed_event_blocks_attendance(seeded: None) -> None:
    exam_event = _event(status=EventStatus.CLOSED)
    student = _student()
    _assert_rejected(_confirm(exam_event.id, student.id), 400, "Evento encerrado")
    assert exam_repo.list_by_event(exam_event.id) == []


def test_rn005_domain_rules() -> None:
    open_event = ExamEvent("e", "Exame", EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    exam = confirm_attendance(open_event, make_student(), SEED_BELTS, EXAMINER_SUB, NOW)
    assert exam.status == ExamStatus.IN_PROGRESS
    assert exam.target_belt_id == belt_id("Cinza/Azul")

    closed = replace(open_event, status=EventStatus.CLOSED)
    with pytest.raises(ValidationError, match="Evento encerrado"):
        confirm_attendance(closed, make_student(), SEED_BELTS, EXAMINER_SUB, NOW)
    with pytest.raises(ValidationError, match="Aluno inativo não pode fazer exame"):
        confirm_attendance(open_event, make_student(active=False), SEED_BELTS, EXAMINER_SUB, NOW)


# --- not found and validation ------------------------------------------------------


def test_rn005_unknown_event_returns_404(seeded: None) -> None:
    student = _student()
    _assert_rejected(_confirm("missing", student.id), 404, "Evento não encontrado")


def test_rn005_unknown_student_returns_404(seeded: None) -> None:
    exam_event = _event()
    _assert_rejected(_confirm(exam_event.id, "missing"), 404, "Aluno não encontrado")


@pytest.mark.parametrize("body", [{}, {"student_id": ""}, {"student_id": 7}])
def test_rn005_student_id_is_required(seeded: None, body: dict[str, Any]) -> None:
    exam_event = _event()
    event = api_event(EXAMINER, path={"id": exam_event.id}, body=body)
    assert handlers.confirm_attendance(event, None)["statusCode"] == 400


# --- uniqueness per (event, student) -------------------------------------------------


def test_rn005_repeated_confirmation_returns_409(seeded: None) -> None:
    exam_event = _event()
    student = _student()
    first = _confirm(exam_event.id, student.id)
    assert first["statusCode"] == 201
    _assert_rejected(
        _confirm(exam_event.id, student.id), 409, "Presença já confirmada neste evento"
    )
    exams = exam_repo.list_by_event(exam_event.id)
    assert [exam.id for exam in exams] == [response_json(first)["id"]]


def test_rn005_simultaneous_confirmation_returns_409(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both requests pass the early check; only the conditional write decides."""
    exam_event = _event()
    student = _student()
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: None)
    assert _confirm(exam_event.id, student.id)["statusCode"] == 201
    _assert_rejected(
        _confirm(exam_event.id, student.id), 409, "Presença já confirmada neste evento"
    )
    assert len(exam_repo.list_by_event(exam_event.id)) == 1


def test_rn005_repository_rejects_duplicate(seeded: None) -> None:
    exam_event = _event()
    student = _student()
    open_event = event_repo.get_event(exam_event.id)
    exam = confirm_attendance(open_event, student, SEED_BELTS, EXAMINER_SUB, NOW)
    exam_repo.create_exam(exam)
    again = confirm_attendance(open_event, student, SEED_BELTS, EXAMINER_SUB, NOW)
    with pytest.raises(ConflictError, match="Presença já confirmada neste evento"):
        exam_repo.create_exam(again)
    assert exam_repo.get_exam(exam_event.id, student.id).id == exam.id


def test_rn005_transaction_conflict_is_retried(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _event()
    student = _student()
    real = exam_repo._transact_create
    calls = {"n": 0}

    def flaky(exam: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ClientError(
                {
                    "Error": {"Code": "TransactionCanceledException", "Message": "conflict"},
                    "CancellationReasons": [
                        {"Code": "None"},
                        {"Code": "TransactionConflict"},
                        {"Code": "None"},
                    ],
                },
                "TransactWriteItems",
            )
        real(exam)

    monkeypatch.setattr(exam_repo, "_transact_create", flaky)
    monkeypatch.setattr(exam_repo.time, "sleep", lambda seconds: None)
    assert _confirm(exam_event.id, student.id)["statusCode"] == 201
    assert calls["n"] == 2


def test_rn005_persistent_transaction_conflict_is_409_not_500(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _event()
    student = _student()

    def always_conflict(exam: Any) -> None:
        raise ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "conflict"},
                "CancellationReasons": [{"Code": "TransactionConflict"}],
            },
            "TransactWriteItems",
        )

    monkeypatch.setattr(exam_repo, "_transact_create", always_conflict)
    monkeypatch.setattr(exam_repo.time, "sleep", lambda seconds: None)
    _assert_rejected(
        _confirm(exam_event.id, student.id),
        409,
        "Outra confirmação está em andamento. Tente de novo.",
    )


# --- event or student changed between the read and the write --------------------------


def _stale_reads(
    monkeypatch: pytest.MonkeyPatch, exam_event: ExamEvent, student: Student | None = None
) -> None:
    """Make the handler see the event (and student) as they were before the change."""
    monkeypatch.setattr(event_repo, "get_event", lambda event_id: exam_event)
    if student is not None:
        monkeypatch.setattr(student_repo, "get_student", lambda student_id: student)


def test_rn005_event_closed_between_read_and_write(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _event()
    student = _student()
    event_repo.save_event(replace(exam_event, status=EventStatus.CLOSED))
    _stale_reads(monkeypatch, exam_event)
    _assert_rejected(_confirm(exam_event.id, student.id), 400, "Evento encerrado")
    assert exam_repo.list_by_event(exam_event.id) == []


def test_rn005_event_deleted_between_read_and_write(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _event()
    student = _student()
    event_repo.delete_event(exam_event.id)
    _stale_reads(monkeypatch, exam_event)
    _assert_rejected(_confirm(exam_event.id, student.id), 404, "Evento não encontrado")
    assert exam_repo.list_by_event(exam_event.id) == []


def test_rn005_student_deleted_between_read_and_write(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _event()
    student = _student()
    student_repo.delete_student(student.id)
    _stale_reads(monkeypatch, exam_event, student)
    _assert_rejected(_confirm(exam_event.id, student.id), 404, "Aluno não encontrado")
    assert exam_repo.list_by_event(exam_event.id) == []


def test_rn005_student_deactivated_between_read_and_write(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _event()
    student = _student()
    student_repo.save_student(replace(student, active=False))
    _stale_reads(monkeypatch, exam_event, student)
    _assert_rejected(_confirm(exam_event.id, student.id), 400, "Aluno inativo não pode fazer exame")
    assert exam_repo.list_by_event(exam_event.id) == []


# --- history preserved after attendance (RN016, RN018) ----------------------------------


def test_rn005_after_attendance_event_and_student_cannot_be_deleted(seeded: None) -> None:
    exam_event = _event()
    student = _student()
    assert _confirm(exam_event.id, student.id)["statusCode"] == 201

    response = event_handlers.delete_event(api_event(EXAMINER, path={"id": exam_event.id}), None)
    _assert_rejected(response, 409, "Evento possui exames registrados")
    assert event_repo.get_event(exam_event.id) is not None

    for user in (EXAMINER, GUARDIAN):
        response = student_handlers.delete_student(api_event(user, path={"id": student.id}), None)
        _assert_rejected(response, 409, "Aluno possui exames registrados")
    assert student_repo.get_student(student.id) is not None


# --- listing -----------------------------------------------------------------------------


def test_rn005_list_event_exams_sorted_by_name(seeded: None) -> None:
    exam_event = _event()
    other_event = _event(exam_date=date(2027, 4, 10))
    bruno = _student("student-b", "bruno")
    ana = _student("student-a", "Ana")
    carla = _student("student-c", "Carla")
    for student in (bruno, ana):
        assert _confirm(exam_event.id, student.id)["statusCode"] == 201
    assert _confirm(other_event.id, carla.id)["statusCode"] == 201

    response = handlers.list_event_exams(api_event(EXAMINER, path={"id": exam_event.id}), None)
    assert response["statusCode"] == 200
    body = response_json(response)
    assert [item["student_name"] for item in body] == ["Ana", "bruno"]
    assert {item["event_id"] for item in body} == {exam_event.id}
    assert all(item["status"] == "IN_PROGRESS" for item in body)


def test_rn005_list_empty_event(seeded: None) -> None:
    exam_event = _event()
    response = handlers.list_event_exams(api_event(EXAMINER, path={"id": exam_event.id}), None)
    assert response["statusCode"] == 200
    assert response_json(response) == []


def test_rn005_list_unknown_event_returns_404(seeded: None) -> None:
    response = handlers.list_event_exams(api_event(EXAMINER, path={"id": "missing"}), None)
    _assert_rejected(response, 404, "Evento não encontrado")


def test_rn005_list_follows_pagination(seeded: None) -> None:
    """More than one BatchGetItem call (100 keys per call) when joining the names."""
    exam_event = _event()
    open_event = event_repo.get_event(exam_event.id)
    for index in range(130):
        student = _student(f"student-{index:03d}", f"Aluno {index:03d}")
        exam_repo.create_exam(
            confirm_attendance(open_event, student, SEED_BELTS, EXAMINER_SUB, NOW)
        )
    assert len(exam_repo.list_by_event(exam_event.id)) == 130
    response = handlers.list_event_exams(api_event(EXAMINER, path={"id": exam_event.id}), None)
    names = [item["student_name"] for item in response_json(response)]
    assert names == [f"Aluno {index:03d}" for index in range(130)]


# --- authorization -------------------------------------------------------------------------

ROUTES = [handlers.confirm_attendance, handlers.list_event_exams]


@pytest.mark.parametrize("call", ROUTES)
def test_rn005_only_examiners(seeded: None, call: Any) -> None:
    exam_event = _event()
    student = _student()
    event = api_event(GUARDIAN, path={"id": exam_event.id}, body={"student_id": student.id})
    _assert_rejected(call(event, None), 403, "Esta área é dos examinadores")
    assert exam_repo.list_by_event(exam_event.id) == []


@pytest.mark.parametrize("call", ROUTES)
def test_rn005_requires_login(seeded: None, call: Any) -> None:
    exam_event = _event()
    event = api_event(None, path={"id": exam_event.id}, body={"student_id": "student-1"})
    assert call(event, None)["statusCode"] == 401
    assert exam_repo.list_by_event(exam_event.id) == []
