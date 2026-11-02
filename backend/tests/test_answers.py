"""Marking of exam items (RN006), score per kind (RN007) and the delete lock of
requirements with answers (RN017).

Marking needs an exam in progress (RN010) in an open event (RN016), checked in
the same transaction as the write; a second mark replaces the first, the last
one wins, and concurrent marks never become a 500.
"""

from dataclasses import replace
from datetime import date
from decimal import Decimal
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

from domain import dates, scoring
from domain.answers import ExamAnswer
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam
from domain.requirements import Requirement, RequirementKind, seed_requirements
from domain.users import ADMIN_GROUP, User
from handlers import exams as handlers
from handlers import requirements as requirement_handlers
from repository import answers as answer_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import (
    ANSWERS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    REQUIREMENTS_TABLE_ENV,
    table,
)

EVENT_DATE = date(2027, 3, 20)
TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)
OTHER_EXAMINER = User(sub="examiner-2", email="outro@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


def _requirement(
    req_id: str,
    *,
    kind: RequirementKind = RequirementKind.THEORY,
    belt: str = TARGET,
    sort_order: int = 1,
    category: str = "Vocabulário",
) -> Requirement:
    requirement = Requirement(
        id=req_id,
        belt_id=belt_id(belt),
        kind=kind,
        category=category,
        description=f"Item {req_id}",
        expected_answer="Resposta",
        sort_order=sort_order,
    )
    requirement_repo.create_requirement(requirement)
    return requirement


@pytest.fixture
def exam(seeded: None) -> Exam:
    """An exam in progress for Ana (Cinza → Cinza/Azul) in an open event."""
    exam_event = ExamEvent(
        id="event-1",
        name="Exame março/2027",
        exam_date=EVENT_DATE,
        status=EventStatus.OPEN,
        created_at=NOW,
        updated_at=NOW,
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1", full_name="Ana")
    student_repo.create_student(student)
    response = handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    stored = exam_repo.get_exam(exam_event.id, student.id)
    assert stored is not None
    assert stored.target_belt_id == belt_id(TARGET)
    return stored


@pytest.fixture
def items(exam: Exam) -> list[Requirement]:
    """Three theory and one practice item of the target belt."""
    return [
        _requirement("t1", sort_order=1),
        _requirement("t2", sort_order=2),
        _requirement("t3", sort_order=3),
        _requirement("p1", kind=RequirementKind.PRACTICE, sort_order=4, category="Naguewaza"),
    ]


def _path(exam: Exam, requirement_id: str | None = None) -> dict[str, str]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    if requirement_id is not None:
        path["requirement_id"] = requirement_id
    return path


def _mark(exam: Exam, requirement_id: str, correct: Any, user: Any = EXAMINER) -> dict[str, Any]:
    event = api_event(user, path=_path(exam, requirement_id), body={"correct": correct})
    return handlers.mark_answer(event, None)


def _unmark(exam: Exam, requirement_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.unmark_answer(api_event(user, path=_path(exam, requirement_id)), None)


def _sheet(exam: Exam, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.get_exam_sheet(api_event(user, path=_path(exam)), None)


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response)["message"] == message


def _stored_answers(exam: Exam) -> list[dict[str, Any]]:
    return table(ANSWERS_TABLE_ENV).scan()["Items"]


def _answer_count(requirement_id: str) -> int:
    item = table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": requirement_id})["Item"]
    return int(item.get("answer_count", 0))


def _set_exam_status(exam: Exam, status: str) -> None:
    table(EXAMS_TABLE_ENV).update_item(
        Key={"event_id": exam.event_id, "student_id": exam.student_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": status},
    )


def _close_event(exam: Exam) -> None:
    table(EVENTS_TABLE_ENV).update_item(
        Key={"id": exam.event_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": EventStatus.CLOSED.value},
    )


def _cancelled(*codes: str) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )


# --- RN006: marking ---------------------------------------------------------------


def test_rn006_mark_records_answer_who_and_when(items: list[Requirement], exam: Exam) -> None:
    response = _mark(exam, "t1", True)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["answer"] == {
        "requirement_id": "t1",
        "correct": True,
        "marked_by": EXAMINER_SUB,
        "marked_at": MARKED_AT,
    }
    stored = answer_repo.list_by_exam(exam.id)
    assert stored == {"t1": ExamAnswer(exam.id, "t1", True, EXAMINER_SUB, MARKED_AT)}
    assert _answer_count("t1") == 1


def test_rn006_marking_again_replaces_and_records_new_examiner(
    items: list[Requirement], exam: Exam
) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    response = _mark(exam, "t1", False, user=OTHER_EXAMINER)

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["answer"]["correct"] is False
    stored = _stored_answers(exam)
    assert len(stored) == 1
    assert stored[0]["correct"] is False
    assert stored[0]["marked_by"] == "examiner-2"
    # Replacing never counts the item twice.
    assert _answer_count("t1") == 1


def test_rn006_answers_are_per_exam_and_item(items: list[Requirement], exam: Exam) -> None:
    for req_id, correct in [("t1", True), ("t2", False), ("p1", True)]:
        assert _mark(exam, req_id, correct)["statusCode"] == 200

    stored = answer_repo.list_by_exam(exam.id)
    assert {key: answer.correct for key, answer in stored.items()} == {
        "t1": True,
        "t2": False,
        "p1": True,
    }


@pytest.mark.parametrize("correct", [None, "true", 1, 0, "certo", [True]])
def test_rn006_correct_must_be_boolean(items: list[Requirement], exam: Exam, correct: Any) -> None:
    _assert_rejected(
        _mark(exam, "t1", correct),
        400,
        "Marcação inválida: envie correct como true (certo) ou false (errado)",
    )
    assert _stored_answers(exam) == []


def test_rn006_body_must_be_json_object(items: list[Requirement], exam: Exam) -> None:
    event = api_event(EXAMINER, path=_path(exam, "t1"))
    event["body"] = "[true]"
    response = handlers.mark_answer(event, None)
    _assert_rejected(response, 400, "Corpo da requisição inválido: envie um objeto JSON")


def test_rn006_item_of_other_belt_is_rejected(items: list[Requirement], exam: Exam) -> None:
    _requirement("cinza-1", belt="Cinza")

    _assert_rejected(_mark(exam, "cinza-1", True), 400, "Item não pertence à faixa do exame")
    _assert_rejected(_unmark(exam, "cinza-1"), 400, "Item não pertence à faixa do exame")
    assert _stored_answers(exam) == []
    assert _answer_count("cinza-1") == 0


def test_rn006_unknown_requirement_is_404(items: list[Requirement], exam: Exam) -> None:
    _assert_rejected(_mark(exam, "missing", True), 404, "Requisito não encontrado")
    _assert_rejected(_unmark(exam, "missing"), 404, "Requisito não encontrado")


def test_rn006_unknown_exam_is_404(items: list[Requirement], exam: Exam) -> None:
    other = replace(exam, student_id="student-x")
    _assert_rejected(_mark(other, "t1", True), 404, "Exame não encontrado")
    _assert_rejected(_unmark(other, "t1"), 404, "Exame não encontrado")
    _assert_rejected(_sheet(other), 404, "Exame não encontrado")


def test_rn006_unknown_event_is_404(items: list[Requirement], exam: Exam) -> None:
    other = replace(exam, event_id="event-x")
    _assert_rejected(_mark(other, "t1", True), 404, "Evento não encontrado")
    _assert_rejected(_sheet(other), 404, "Evento não encontrado")


@pytest.mark.parametrize("status", ["APPROVED", "FAILED"])
def test_rn006_rn010_decided_exam_blocks_marking(
    items: list[Requirement], exam: Exam, status: str
) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    _set_exam_status(exam, status)

    _assert_rejected(_mark(exam, "t1", False), 409, "Exame já decidido")
    _assert_rejected(_mark(exam, "t2", True), 409, "Exame já decidido")
    _assert_rejected(_unmark(exam, "t1"), 409, "Exame já decidido")
    stored = answer_repo.list_by_exam(exam.id)
    assert {key: answer.correct for key, answer in stored.items()} == {"t1": True}


def test_rn006_rn016_closed_event_blocks_marking(items: list[Requirement], exam: Exam) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    _close_event(exam)

    _assert_rejected(_mark(exam, "t1", False), 400, "Evento encerrado")
    _assert_rejected(_mark(exam, "t2", True), 400, "Evento encerrado")
    _assert_rejected(_unmark(exam, "t1"), 400, "Evento encerrado")
    assert len(_stored_answers(exam)) == 1
    # The sheet stays readable (read-only screen).
    assert _sheet(exam)["statusCode"] == 200


# --- RN006: changes between the read and the write --------------------------------


def _stale_exam(monkeypatch: pytest.MonkeyPatch, exam: Exam) -> None:
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: exam)


def _stale_event(monkeypatch: pytest.MonkeyPatch, exam: Exam) -> None:
    open_event = event_repo.get_event(exam.event_id)
    monkeypatch.setattr(event_repo, "get_event", lambda event_id: open_event)


def _stale_requirement(monkeypatch: pytest.MonkeyPatch, requirement: Requirement) -> None:
    monkeypatch.setattr(requirement_repo, "get_requirement", lambda req_id: requirement)


@pytest.mark.parametrize("already_marked", [False, True])
def test_rn006_event_closed_between_read_and_write(
    items: list[Requirement],
    exam: Exam,
    monkeypatch: pytest.MonkeyPatch,
    already_marked: bool,
) -> None:
    if already_marked:
        assert _mark(exam, "t1", True)["statusCode"] == 200
    _stale_event(monkeypatch, exam)
    _close_event(exam)

    _assert_rejected(_mark(exam, "t1", False), 400, "Evento encerrado")
    stored = answer_repo.list_by_exam(exam.id)
    assert [answer.correct for answer in stored.values()] == ([True] if already_marked else [])
    assert _answer_count("t1") == (1 if already_marked else 0)


@pytest.mark.parametrize("already_marked", [False, True])
def test_rn006_exam_decided_between_read_and_write(
    items: list[Requirement],
    exam: Exam,
    monkeypatch: pytest.MonkeyPatch,
    already_marked: bool,
) -> None:
    if already_marked:
        assert _mark(exam, "t1", True)["statusCode"] == 200
    _stale_exam(monkeypatch, exam)
    _set_exam_status(exam, "APPROVED")

    _assert_rejected(_mark(exam, "t1", False), 409, "Exame já decidido")
    stored = answer_repo.list_by_exam(exam.id)
    assert [answer.correct for answer in stored.values()] == ([True] if already_marked else [])


def test_rn006_unmark_blocked_when_event_closed_meanwhile(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    _stale_event(monkeypatch, exam)
    _close_event(exam)

    _assert_rejected(_unmark(exam, "t1"), 400, "Evento encerrado")
    assert len(_stored_answers(exam)) == 1
    assert _answer_count("t1") == 1


def test_rn006_exam_replaced_between_read_and_write_is_404(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A different exam id under the same key: answers never go to the wrong exam.
    _stale_exam(monkeypatch, replace(exam, id="old-exam"))

    _assert_rejected(_mark(exam, "t1", True), 404, "Exame não encontrado")
    assert _stored_answers(exam) == []


def test_rn006_requirement_deleted_between_read_and_write(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stale_requirement(monkeypatch, items[0])
    requirement_repo.delete_requirement("t1")

    _assert_rejected(_mark(exam, "t1", True), 404, "Requisito não encontrado")
    assert _stored_answers(exam) == []
    # The counter update never recreates the deleted item.
    assert "Item" not in table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": "t1"})


def test_rn006_requirement_moved_between_read_and_write(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stale_requirement(monkeypatch, items[0])
    requirement_repo.save_requirement(replace(items[0], belt_id=belt_id("Cinza")))

    _assert_rejected(_mark(exam, "t1", True), 400, "Item não pertence à faixa do exame")
    assert _stored_answers(exam) == []


# --- RN006: concurrency -------------------------------------------------------------


def test_rn006_simultaneous_first_marks_last_wins(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = answer_repo._transact
    calls = {"n": 0}

    def other_examiner_first(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            # The other examiner's first mark commits just before ours.
            other = ExamAnswer(exam.id, "t1", True, "examiner-2", "2027-03-20T13:44:59+00:00")
            real(answer_repo._create_items(exam, other))
        real(transact_items)

    monkeypatch.setattr(answer_repo, "_transact", other_examiner_first)
    response = _mark(exam, "t1", False)

    assert response["statusCode"] == 200, response["body"]
    stored = _stored_answers(exam)
    assert len(stored) == 1
    assert stored[0]["correct"] is False
    assert stored[0]["marked_by"] == EXAMINER_SUB
    assert _answer_count("t1") == 1
    assert calls["n"] == 2  # insert refused, then replace


def test_rn006_unmarked_between_attempts_goes_back_to_insert(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    real = answer_repo._transact
    calls = {"n": 0}

    def unmark_before_replace(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] == 2:
            # Another examiner unmarks after our insert was refused.
            real(answer_repo._delete_items(exam, "t1"))
        real(transact_items)

    monkeypatch.setattr(answer_repo, "_transact", unmark_before_replace)
    response = _mark(exam, "t1", False)

    assert response["statusCode"] == 200, response["body"]
    stored = _stored_answers(exam)
    assert [item["correct"] for item in stored] == [False]
    assert _answer_count("t1") == 1
    assert calls["n"] == 3  # insert refused, replace refused, insert


def test_rn006_transaction_conflict_is_retried(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = answer_repo._transact
    calls = {"n": 0}

    def flaky(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _cancelled("None", "None", "TransactionConflict", "None")
        real(transact_items)

    monkeypatch.setattr(answer_repo, "_transact", flaky)
    monkeypatch.setattr(answer_repo.time, "sleep", lambda seconds: None)

    assert _mark(exam, "t1", True)["statusCode"] == 200
    assert calls["n"] == 2
    assert _answer_count("t1") == 1


@pytest.mark.parametrize("call", [_mark, _unmark])
def test_rn006_persistent_conflict_is_409_not_500(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch, call: Any
) -> None:
    def always_conflict(transact_items: list[dict[str, Any]]) -> None:
        raise _cancelled("None", "None", "TransactionConflict", "None")

    monkeypatch.setattr(answer_repo, "_transact", always_conflict)
    monkeypatch.setattr(answer_repo.time, "sleep", lambda seconds: None)
    response = call(exam, "t1", True) if call is _mark else call(exam, "t1")

    _assert_rejected(response, 409, "Outra marcação está em andamento. Tente de novo.")


# --- RN006: unmarking -----------------------------------------------------------------


def test_rn006_unmark_returns_item_to_not_marked(items: list[Requirement], exam: Exam) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    response = _unmark(exam, "t1")

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["answer"] is None
    assert body["summary"]["THEORY"] == {
        "kind": "THEORY",
        "total": 3,
        "marked": 0,
        "correct": 0,
        "percent": 0.0,
    }
    assert _stored_answers(exam) == []
    assert _answer_count("t1") == 0
    sheet = response_json(_sheet(exam))
    assert sheet["items"][0]["answer"] is None


def test_rn006_unmark_of_not_marked_item_is_a_no_op(items: list[Requirement], exam: Exam) -> None:
    response = _unmark(exam, "t2")

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["answer"] is None
    assert _answer_count("t2") == 0


# --- authorization -------------------------------------------------------------------


@pytest.mark.parametrize("call", ["sheet", "mark", "unmark"])
def test_rn006_only_examiners(items: list[Requirement], exam: Exam, call: str) -> None:
    responses = {
        "sheet": lambda: _sheet(exam, user=GUARDIAN),
        "mark": lambda: _mark(exam, "t1", True, user=GUARDIAN),
        "unmark": lambda: _unmark(exam, "t1", user=GUARDIAN),
    }
    _assert_rejected(responses[call](), 403, "Esta área é dos examinadores")
    assert _stored_answers(exam) == []


@pytest.mark.parametrize("call", ["sheet", "mark", "unmark"])
def test_rn006_requires_login(items: list[Requirement], exam: Exam, call: str) -> None:
    responses = {
        "sheet": lambda: _sheet(exam, user=None),
        "mark": lambda: _mark(exam, "t1", True, user=None),
        "unmark": lambda: _unmark(exam, "t1", user=None),
    }
    _assert_rejected(responses[call](), 401, "Faça login para continuar")


# --- RN007: score per kind -----------------------------------------------------------


def test_rn007_sheet_shows_items_answers_and_score(exam: Exam) -> None:
    sheet_items = [req for req in seed_requirements() if req.belt_id == belt_id(TARGET)]
    for requirement in sheet_items:
        requirement_repo.create_requirement(requirement)
    theory = [req for req in sheet_items if req.kind == RequirementKind.THEORY]
    for requirement, correct in zip(theory[:4], [True, True, True, False], strict=True):
        assert _mark(exam, requirement.id, correct)["statusCode"] == 200

    response = _sheet(exam)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["exam"]["id"] == exam.id
    assert body["exam"]["student_name"] == "Ana"
    assert body["exam"]["kind"] == "BELT"
    assert body["exam"]["status"] == "IN_PROGRESS"
    assert body["event"]["id"] == exam.event_id
    assert body["event"]["status"] == "OPEN"
    assert body["student"] == {"id": "student-1", "full_name": "Ana", "birth_date": "2018-05-10"}
    assert body["target_belt"]["name"] == TARGET
    # Every item of the belt (11 theory, 13 practice), in sheet order.
    assert [item["id"] for item in body["items"]] == [req.id for req in sheet_items]
    first = body["items"][0]
    assert set(first) >= {"id", "kind", "category", "description", "expected_answer", "answer"}
    marked = {item["id"]: item["answer"] for item in body["items"] if item["answer"]}
    assert marked[theory[0].id] == {
        "requirement_id": theory[0].id,
        "correct": True,
        "marked_by": EXAMINER_SUB,
        "marked_at": MARKED_AT,
    }
    assert marked[theory[3].id]["correct"] is False
    # 3 of 11 theory items correct: 27.3%; unmarked items count as not correct.
    assert body["summary"] == {
        "THEORY": {"kind": "THEORY", "total": 11, "marked": 4, "correct": 3, "percent": 27.3},
        "PRACTICE": {"kind": "PRACTICE", "total": 13, "marked": 0, "correct": 0, "percent": 0.0},
    }


def test_rn007_mark_returns_updated_score(items: list[Requirement], exam: Exam) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    body = response_json(_mark(exam, "t2", True))

    assert body["summary"]["THEORY"] == {
        "kind": "THEORY",
        "total": 3,
        "marked": 2,
        "correct": 2,
        "percent": 66.7,
    }
    body = response_json(_mark(exam, "p1", False))
    assert body["summary"]["PRACTICE"] == {
        "kind": "PRACTICE",
        "total": 1,
        "marked": 1,
        "correct": 0,
        "percent": 0.0,
    }


def test_rn007_score_applies_own_write_despite_stale_read(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The answers query is eventually consistent: it may miss the write just made.
    monkeypatch.setattr(answer_repo, "list_by_exam", lambda exam_id: {})
    body = response_json(_mark(exam, "t1", True))

    assert body["summary"]["THEORY"]["marked"] == 1
    assert body["summary"]["THEORY"]["correct"] == 1


def test_rn007_belt_without_items_of_a_kind_has_no_percent(exam: Exam) -> None:
    _requirement("t1")
    assert _mark(exam, "t1", True)["statusCode"] == 200

    body = response_json(_sheet(exam))

    assert body["summary"]["THEORY"]["percent"] == 100.0
    assert body["summary"]["PRACTICE"] == {
        "kind": "PRACTICE",
        "total": 0,
        "marked": 0,
        "correct": 0,
        "percent": None,
    }


def test_rn007_score_is_recomputed_never_stored(items: list[Requirement], exam: Exam) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    assert response_json(_sheet(exam))["summary"]["THEORY"]["percent"] == 33.3

    # A new item of the belt changes the score on the next read.
    _requirement("t4", sort_order=5)
    assert response_json(_sheet(exam))["summary"]["THEORY"]["percent"] == 25.0

    exam_item = table(EXAMS_TABLE_ENV).get_item(
        Key={"event_id": exam.event_id, "student_id": exam.student_id}
    )["Item"]
    stored_attributes = set(exam_item) | {key for item in _stored_answers(exam) for key in item}
    assert not stored_attributes & {"percent", "summary", "score", "marked", "total"}


def test_rn007_answers_outside_the_belt_are_ignored() -> None:
    requirements = [
        Requirement("a", "b", RequirementKind.THEORY, "c", "d", None, 1),
        Requirement("x", "b", RequirementKind.PRACTICE, "c", "d", None, 2),
    ]
    result = scoring.summary(requirements, {"a": True, "gone": True})

    assert result["THEORY"]["percent"] == 100.0
    assert result["PRACTICE"]["marked"] == 0
    assert scoring.score(requirements, {"a": True})[RequirementKind.THEORY].percent == Decimal(
        "100.0"
    )


# --- RN017: requirement with answers cannot be deleted ------------------------------


def _delete_requirement(requirement_id: str) -> dict[str, Any]:
    return requirement_handlers.delete_requirement(
        api_event(EXAMINER, path={"id": requirement_id}), None
    )


def test_rn017_requirement_with_answers_cannot_be_deleted(
    items: list[Requirement], exam: Exam
) -> None:
    assert _mark(exam, "t1", False)["statusCode"] == 200

    _assert_rejected(_delete_requirement("t1"), 409, "Requisito possui respostas registradas")
    assert requirement_repo.get_requirement("t1") is not None
    # Items without answers are still deleted.
    assert _delete_requirement("t2")["statusCode"] == 204


def test_rn017_requirement_can_be_deleted_after_unmark(
    items: list[Requirement], exam: Exam
) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    assert _unmark(exam, "t1")["statusCode"] == 200

    assert _delete_requirement("t1")["statusCode"] == 204


def test_rn017_edit_keeps_the_answers_counter(items: list[Requirement], exam: Exam) -> None:
    assert _mark(exam, "t1", True)["statusCode"] == 200
    payload = {
        "belt_id": belt_id(TARGET),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Texto corrigido",
        "sort_order": 1,
    }
    response = requirement_handlers.update_requirement(
        api_event(EXAMINER, path={"id": "t1"}, body=payload), None
    )

    assert response["statusCode"] == 200, response["body"]
    assert requirement_repo.get_requirement("t1").description == "Texto corrigido"
    assert _answer_count("t1") == 1
    _assert_rejected(_delete_requirement("t1"), 409, "Requisito possui respostas registradas")


def test_rn017_first_answer_during_delete_blocks_it(
    items: list[Requirement], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_get = requirement_repo.get_requirement

    def answer_arrives(requirement_id: str) -> Requirement | None:
        requirement = real_get(requirement_id)
        # The marking commits after the delete handler read the item.
        answer = ExamAnswer(exam.id, requirement_id, True, EXAMINER_SUB, MARKED_AT)
        answer_repo.save_answer(exam, answer)
        return requirement

    monkeypatch.setattr(requirement_repo, "get_requirement", answer_arrives)
    response = _delete_requirement("t1")
    monkeypatch.undo()

    _assert_rejected(response, 409, "Requisito possui respostas registradas")
    assert requirement_repo.get_requirement("t1") is not None
    assert len(_stored_answers(exam)) == 1
