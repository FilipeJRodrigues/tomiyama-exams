"""Belt and kind lock of requirements with answers (RN017) and the robustness of
the answer transactions (RN006).

An item with answers keeps its belt and kind: ``PUT /requirements/{id}``
answers 409 when either changes, checked in the ``UpdateItem`` condition so a
marking that commits after the handler's read still blocks the move. Resending
the same belt and kind (the form sends every field) passes. Replacing a mark
checks the requirement's belt in the same transaction. Throttling inside the
transaction is retried and, if it persists, becomes 503, never 500.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, belt_id, make_student, response_json

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam
from domain.requirements import Requirement, RequirementKind
from handlers import exams as handlers
from handlers import requirements as requirement_handlers
from repository import answers as answer_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import ANSWERS_TABLE_ENV, REQUIREMENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)
MSG_LOCKED = "Não é possível trocar a faixa ou o tipo de um requisito com respostas registradas"
MSG_BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


@pytest.fixture
def exam(seeded: None) -> Exam:
    """An exam in progress for a Cinza student (target Cinza/Azul) with item ``t1``."""
    event_repo.create_event(
        ExamEvent(
            id="event-1",
            name="Exame março/2027",
            exam_date=date(2027, 3, 20),
            status=EventStatus.OPEN,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    student_repo.create_student(replace(make_student(), id="student-1"))
    response = handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": "event-1"}, body={"student_id": "student-1"}), None
    )
    assert response["statusCode"] == 201, response["body"]
    requirement_repo.create_requirement(
        Requirement(
            id="t1",
            belt_id=belt_id(TARGET),
            kind=RequirementKind.THEORY,
            category="Vocabulário",
            description="Item t1",
            expected_answer="Resposta",
            sort_order=1,
        )
    )
    stored = exam_repo.get_exam("event-1", "student-1")
    assert stored is not None
    return stored


def _path(exam: Exam, requirement_id: str | None = None) -> dict[str, str]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    if requirement_id is not None:
        path["requirement_id"] = requirement_id
    return path


def _mark(exam: Exam, correct: bool = True) -> dict[str, Any]:
    return handlers.mark_answer(
        api_event(EXAMINER, path=_path(exam, "t1"), body={"correct": correct}), None
    )


def _unmark(exam: Exam) -> dict[str, Any]:
    return handlers.unmark_answer(api_event(EXAMINER, path=_path(exam, "t1")), None)


def _sheet(exam: Exam) -> dict[str, Any]:
    return response_json(handlers.get_exam_sheet(api_event(EXAMINER, path=_path(exam)), None))


def _payload(**changes: Any) -> dict[str, Any]:
    payload = {
        "belt_id": belt_id(TARGET),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Item t1",
        "expected_answer": "Resposta",
        "sort_order": 1,
    }
    payload.update(changes)
    return payload


def _put(payload: dict[str, Any]) -> dict[str, Any]:
    return requirement_handlers.update_requirement(
        api_event(EXAMINER, path={"id": "t1"}, body=payload), None
    )


def _stored_requirement() -> dict[str, Any]:
    return table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": "t1"})["Item"]


def _stored_answer(exam: Exam) -> dict[str, Any] | None:
    key = {"exam_id": exam.id, "requirement_id": "t1"}
    return table(ANSWERS_TABLE_ENV).get_item(Key=key).get("Item")


def _assert_answer_on_sheet(exam: Exam, correct: bool) -> None:
    sheet = _sheet(exam)
    assert [item["id"] for item in sheet["items"]] == ["t1"]
    assert sheet["items"][0]["answer"]["correct"] is correct
    assert sheet["summary"]["THEORY"]["correct"] == (1 if correct else 0)


def _cancelled(*codes: str) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )


# --- RN017: belt and kind lock --------------------------------------------------------


@pytest.mark.parametrize(
    "change",
    [{"belt_id": "Cinza"}, {"kind": "PRACTICE"}, {"belt_id": "Cinza", "kind": "PRACTICE"}],
)
def test_rn017_answered_item_cannot_change_belt_or_kind(exam: Exam, change: dict[str, str]) -> None:
    assert _mark(exam)["statusCode"] == 200
    before = _stored_requirement()
    if "belt_id" in change:
        change = {**change, "belt_id": belt_id(change["belt_id"])}

    response = _put(_payload(description="Nova descrição", **change))

    assert response["statusCode"] == 409, response["body"]
    assert response_json(response) == {"message": MSG_LOCKED}
    assert _stored_requirement() == before  # nothing written, not even the description
    _assert_answer_on_sheet(exam, True)


def test_rn017_resending_same_belt_and_kind_edits_the_other_fields(exam: Exam) -> None:
    assert _mark(exam)["statusCode"] == 200

    response = _put(
        _payload(
            category="Nova categoria",
            description="Nova descrição",
            expected_answer="Nova resposta",
            sort_order=9,
        )
    )

    assert response["statusCode"] == 200, response["body"]
    stored = _stored_requirement()
    assert stored["category"] == "Nova categoria"
    assert stored["description"] == "Nova descrição"
    assert stored["expected_answer"] == "Nova resposta"
    assert int(stored["sort_order"]) == 9
    assert int(stored["answer_count"]) == 1
    _assert_answer_on_sheet(exam, True)


def test_rn017_resending_same_values_with_answers_passes(exam: Exam) -> None:
    assert _mark(exam)["statusCode"] == 200

    assert _put(_payload())["statusCode"] == 200
    assert _put(_payload(expected_answer=None))["statusCode"] == 200
    assert "expected_answer" not in _stored_requirement()


def test_rn017_item_without_answers_may_change_belt_and_kind(exam: Exam) -> None:
    response = _put(_payload(belt_id=belt_id("Cinza"), kind="PRACTICE"))

    assert response["statusCode"] == 200, response["body"]
    stored = _stored_requirement()
    assert (stored["belt_id"], stored["kind"]) == (belt_id("Cinza"), "PRACTICE")


def test_rn017_item_unmarked_back_to_zero_answers_may_move(exam: Exam) -> None:
    assert _mark(exam)["statusCode"] == 200
    assert _unmark(exam)["statusCode"] == 200
    assert int(_stored_requirement()["answer_count"]) == 0

    assert _put(_payload(belt_id=belt_id("Cinza")))["statusCode"] == 200
    assert _stored_requirement()["belt_id"] == belt_id("Cinza")


def test_rn017_marking_between_read_and_write_still_blocks_the_move(
    exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The handler reads the item with no answers; a first mark commits before
    # the UpdateItem. The write's own condition must still refuse the move.
    real_get = requirement_repo.get_requirement
    state = {"marked": False}

    def marked_after_read(req_id: str) -> Requirement | None:
        requirement = real_get(req_id)
        if not state["marked"]:
            state["marked"] = True
            assert _mark(exam)["statusCode"] == 200
        return requirement

    monkeypatch.setattr(requirement_repo, "get_requirement", marked_after_read)
    response = _put(_payload(belt_id=belt_id("Cinza")))
    monkeypatch.undo()

    assert state["marked"]
    assert response["statusCode"] == 409, response["body"]
    assert response_json(response) == {"message": MSG_LOCKED}
    assert _stored_requirement()["belt_id"] == belt_id(TARGET)
    _assert_answer_on_sheet(exam, True)


def test_rn017_put_of_answered_item_deleted_meanwhile_is_404(
    exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_get = requirement_repo.get_requirement
    state = {"deleted": False}

    def deleted_after_read(req_id: str) -> Requirement | None:
        requirement = real_get(req_id)
        if not state["deleted"]:
            state["deleted"] = True
            table(REQUIREMENTS_TABLE_ENV).delete_item(Key={"id": req_id})
        return requirement

    monkeypatch.setattr(requirement_repo, "get_requirement", deleted_after_read)
    response = _put(_payload(belt_id=belt_id("Cinza")))
    monkeypatch.undo()

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": "Requisito não encontrado"}
    assert requirement_repo.get_requirement("t1") is None


# --- RN006: replacing a mark checks the requirement's belt ----------------------------


def test_rn006_replace_checks_the_requirement_belt_in_the_transaction(
    exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _mark(exam, True)["statusCode"] == 200
    real = answer_repo._transact
    calls = {"n": 0}

    def moved_before_replace(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] == 2:
            # Item leaves the belt right before the replace (written outside the
            # API lock, the worst case the ConditionCheck has to cover).
            table(REQUIREMENTS_TABLE_ENV).update_item(
                Key={"id": "t1"},
                UpdateExpression="SET belt_id = :belt",
                ExpressionAttributeValues={":belt": belt_id("Cinza")},
            )
        real(transact_items)

    monkeypatch.setattr(answer_repo, "_transact", moved_before_replace)
    response = _mark(exam, False)

    assert calls["n"] == 2  # insert refused (already answered), replace refused
    assert response["statusCode"] == 400, response["body"]
    assert response_json(response) == {"message": "Item não pertence à faixa do exame"}
    stored = _stored_answer(exam)
    assert stored is not None
    assert stored["correct"] is True


def test_rn006_replace_of_item_deleted_meanwhile_is_404(
    exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _mark(exam, True)["statusCode"] == 200
    real = answer_repo._transact
    calls = {"n": 0}

    def deleted_before_replace(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] == 2:
            table(REQUIREMENTS_TABLE_ENV).delete_item(Key={"id": "t1"})
        real(transact_items)

    monkeypatch.setattr(answer_repo, "_transact", deleted_before_replace)
    response = _mark(exam, False)

    assert response["statusCode"] == 404, response["body"]
    assert response_json(response) == {"message": "Requisito não encontrado"}


# --- RN006: throttling inside the transaction ---------------------------------------


@pytest.mark.parametrize("reason", ["ThrottlingError", "ProvisionedThroughputExceeded"])
@pytest.mark.parametrize("unmark", [False, True])
def test_rn006_throttled_transaction_is_retried(
    exam: Exam, monkeypatch: pytest.MonkeyPatch, reason: str, unmark: bool
) -> None:
    if unmark:
        assert _mark(exam)["statusCode"] == 200
    real = answer_repo._transact
    calls = {"n": 0}

    def throttled_once(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _cancelled("None", "None", reason, "None")
        real(transact_items)

    monkeypatch.setattr(answer_repo, "_transact", throttled_once)
    sleeps: list[float] = []
    monkeypatch.setattr(answer_repo.time, "sleep", sleeps.append)

    response = _unmark(exam) if unmark else _mark(exam)

    assert response["statusCode"] == 200, response["body"]
    assert calls["n"] == 2
    assert len(sleeps) == 1
    assert int(_stored_requirement()["answer_count"]) == (0 if unmark else 1)


@pytest.mark.parametrize("reason", ["ThrottlingError", "ProvisionedThroughputExceeded"])
@pytest.mark.parametrize("unmark", [False, True])
def test_rn006_persistent_throttling_is_503_not_500(
    exam: Exam, monkeypatch: pytest.MonkeyPatch, reason: str, unmark: bool
) -> None:
    if unmark:
        assert _mark(exam)["statusCode"] == 200
    calls = {"n": 0}

    def always_throttled(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        raise _cancelled("None", "None", reason, "None")

    monkeypatch.setattr(answer_repo, "_transact", always_throttled)
    sleeps: list[float] = []
    monkeypatch.setattr(answer_repo.time, "sleep", sleeps.append)

    response = _unmark(exam) if unmark else _mark(exam)

    assert response["statusCode"] == 503, response["body"]
    assert response_json(response) == {"message": MSG_BUSY}
    assert calls["n"] == answer_repo._MAX_ATTEMPTS
    assert len(sleeps) == answer_repo._MAX_ATTEMPTS - 1  # no sleep after the last try


@pytest.mark.parametrize("code", ["ProvisionedThroughputExceededException", "ThrottlingException"])
def test_rn006_request_throttled_after_botocore_retries_is_503(
    exam: Exam, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    calls = {"n": 0}

    def throttled(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        raise ClientError({"Error": {"Code": code, "Message": "slow down"}}, "TransactWriteItems")

    monkeypatch.setattr(answer_repo, "_transact", throttled)

    response = _mark(exam)

    assert response["statusCode"] == 503, response["body"]
    assert response_json(response) == {"message": MSG_BUSY}
    assert calls["n"] == 1  # botocore already retried this one
    assert _stored_answer(exam) is None


def test_rn006_conflict_then_throttling_reports_the_last_cause(
    exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}

    def conflict_then_throttled(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] < answer_repo._MAX_ATTEMPTS:
            raise _cancelled("None", "None", "TransactionConflict", "None")
        raise _cancelled("None", "None", "ThrottlingError", "None")

    monkeypatch.setattr(answer_repo, "_transact", conflict_then_throttled)
    monkeypatch.setattr(answer_repo.time, "sleep", lambda seconds: None)

    response = _mark(exam)

    assert response["statusCode"] == 503, response["body"]
    assert response_json(response) == {"message": MSG_BUSY}
