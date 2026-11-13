"""The exam sheet holds only the main profile's items (RN006, RN007; #144, step 2).

Once an examiner creates another requirement profile (a full copy of the main
one), the target belt has a copy of each item per profile. Until the event
chooses its profile (step 3 of #144), the exam sheet, its score (also the one
returned after a mark or unmark) and the items that may be marked or unmarked
are the target belt's items of the main profile only
(``domain.exams.sheet_profile_id``). An item of another profile is refused
like an item of another belt, with 400 "Item não pertence ao perfil de
requisitos do exame", and nothing is written.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    CopyInvocations,
    api_event,
    belt_id,
    dynamodb_snapshot,
    make_student,
    response_json,
)

from domain import dates, scoring
from domain.answers import (
    MSG_ITEM_NOT_IN_BELT,
    MSG_ITEM_NOT_IN_PROFILE,
    ensure_can_mark,
)
from domain.eligibility import ExamKind
from domain.errors import ConflictError, ValidationError
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, ExamStatus, sheet_profile_id
from domain.requirement_profiles import MAIN_PROFILE_ID
from domain.requirements import (
    Requirement,
    RequirementKind,
    copied_requirement_id,
    seed_requirements,
)
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import exams as handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as profile_handlers
from handlers import requirements as requirement_handlers
from repository import answers as answer_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import REQUIREMENTS_TABLE_ENV, table

EVENT_DATE = date(2027, 3, 20)
TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)
OTHER_BELT = "Cinza"
SENSEI = User(sub="sensei-1", email="sensei-1@example.com", groups=frozenset({ADMIN_GROUP}))
NOT_IN_PROFILE = "Item não pertence ao perfil de requisitos do exame"
NOT_IN_BELT = "Item não pertence à faixa do exame"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


def _open_event() -> ExamEvent:
    return ExamEvent(
        id="event-1",
        name="Exame março/2027",
        exam_date=EVENT_DATE,
        status=EventStatus.OPEN,
        created_at=NOW,
        updated_at=NOW,
    )


@pytest.fixture
def exam(seeded: None) -> Exam:
    """An exam in progress for Ana (Cinza → Cinza/Azul) in an open event."""
    exam_event = _open_event()
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
def main_items(exam: Exam) -> list[Requirement]:
    """Appendix A items of the target belt (11 theory, 13 practice) and of Cinza, in main.

    The second item of the target belt is stored as before the profiles
    existed (no ``profile_id`` nor ``profile_belt``): it still belongs to the
    main sheet. Returns the target belt's items in sheet order.
    """
    belts = {belt_id(TARGET), belt_id(OTHER_BELT)}
    items = [item for item in seed_requirements() if item.belt_id in belts]
    for item in items:
        requirement_repo.create_requirement(item)
    sheet = [item for item in items if item.belt_id == belt_id(TARGET)]
    table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": sheet[1].id}, UpdateExpression="REMOVE profile_id, profile_belt"
    )
    return sheet


def _copy_profile(name: str = "Perfil do Sensei") -> str:
    """Create a profile copied from main, run its copy and add an item only it has."""
    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": name}), None)
    assert created["statusCode"] == 202, created["body"]
    profile_id = response_json(created)["id"]
    result = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert result["outcome"] == "READY", result
    extra = requirement_handlers.create_requirement(
        api_event(
            EXAMINER,
            body={
                "profile_id": profile_id,
                "belt_id": belt_id(TARGET),
                "kind": "THEORY",
                "category": "Vocabulário",
                "description": "Item só do perfil copiado",
                "expected_answer": "Resposta",
            },
        ),
        None,
    )
    assert extra["statusCode"] == 201, extra["body"]
    return profile_id


@pytest.fixture
def copied_profile(main_items: list[Requirement], copy_invocations: CopyInvocations) -> str:
    """A ready profile copied from main, with one more theory item in the target belt."""
    profile_id = _copy_profile()
    copy = requirement_repo.list_profile_belt(profile_id, belt_id(TARGET))
    # The copy really is in the target belt: one copy per main item, plus its own item.
    assert len(copy) == len(main_items) + 1
    assert len(requirement_repo.list_by_belt(belt_id(TARGET))) == 2 * len(main_items) + 1
    return profile_id


def _path(exam: Exam, requirement_id: str | None = None) -> dict[str, str]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    if requirement_id is not None:
        path["requirement_id"] = requirement_id
    return path


def _mark(exam: Exam, requirement_id: str, correct: bool) -> dict[str, Any]:
    event = api_event(EXAMINER, path=_path(exam, requirement_id), body={"correct": correct})
    return handlers.mark_answer(event, None)


def _unmark(exam: Exam, requirement_id: str) -> dict[str, Any]:
    return handlers.unmark_answer(api_event(EXAMINER, path=_path(exam, requirement_id)), None)


def _sheet(exam: Exam) -> dict[str, Any]:
    response = handlers.get_exam_sheet(api_event(EXAMINER, path=_path(exam)), None)
    assert response["statusCode"] == 200, response["body"]
    return response_json(response)


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response)["message"] == message


def _of_kind(items: list[Requirement], kind: RequirementKind) -> list[Requirement]:
    return [item for item in items if item.kind == kind]


def _copy_of(profile_id: str, item: Requirement) -> str:
    return copied_requirement_id(profile_id, item.id)


# --- the rule (pure) -------------------------------------------------------


def test_rn006_sheet_profile_is_main_until_the_event_chooses_one() -> None:
    assert sheet_profile_id(_open_event()) == MAIN_PROFILE_ID


def _domain_exam(status: ExamStatus = ExamStatus.IN_PROGRESS) -> Exam:
    return Exam(
        id="exam-1",
        event_id="event-1",
        student_id="student-1",
        target_belt_id="belt-target",
        kind=ExamKind.BELT,
        status=status,
        decided_by_id=None,
        decided_at=None,
        notes=None,
        created_by="examiner-1",
        created_at=NOW,
    )


def _domain_item(belt: str = "belt-target", profile_id: str = MAIN_PROFILE_ID) -> Requirement:
    return Requirement("r", belt, RequirementKind.THEORY, "c", "d", None, 1, profile_id)


def test_rn006_only_items_of_the_sheet_profile_may_be_marked() -> None:
    exam_event = _open_event()

    ensure_can_mark(_domain_exam(), exam_event, _domain_item())
    with pytest.raises(ValidationError) as other_profile:
        ensure_can_mark(_domain_exam(), exam_event, _domain_item(profile_id="perfil-2"))
    assert other_profile.value.message == MSG_ITEM_NOT_IN_PROFILE == NOT_IN_PROFILE
    # The belt is checked first, then the profile; the exam and the event before both.
    with pytest.raises(ValidationError) as other_belt:
        ensure_can_mark(
            _domain_exam(), exam_event, _domain_item(belt="belt-x", profile_id="perfil-2")
        )
    assert other_belt.value.message == MSG_ITEM_NOT_IN_BELT == NOT_IN_BELT
    with pytest.raises(ConflictError):
        ensure_can_mark(
            _domain_exam(ExamStatus.APPROVED), exam_event, _domain_item(profile_id="perfil-2")
        )
    closed = replace(exam_event, status=EventStatus.CLOSED)
    with pytest.raises(ValidationError) as closed_event:
        ensure_can_mark(_domain_exam(), closed, _domain_item(profile_id="perfil-2"))
    assert closed_event.value.message == "Evento encerrado"


# --- the sheet and its score ---------------------------------------------------


def test_rn006_sheet_lists_only_the_main_items_with_another_profile(
    main_items: list[Requirement], exam: Exam, copy_invocations: CopyInvocations
) -> None:
    before = _sheet(exam)

    _copy_profile("Perfil do Sensei")
    _copy_profile("Outro perfil")
    after = _sheet(exam)

    # Same items, same count and same sheet order as before any other profile existed.
    assert after["items"] == before["items"]
    assert [item["id"] for item in after["items"]] == [item.id for item in main_items]
    assert {item["profile_id"] for item in after["items"]} == {MAIN_PROFILE_ID}
    assert after["summary"] == before["summary"]
    assert after["summary"]["THEORY"]["total"] == 11
    assert after["summary"]["PRACTICE"]["total"] == 13


def test_rn007_score_counts_only_the_main_items(
    main_items: list[Requirement], exam: Exam, copied_profile: str
) -> None:
    theory = _of_kind(main_items, RequirementKind.THEORY)
    practice = _of_kind(main_items, RequirementKind.PRACTICE)
    theory_marks = dict(
        zip([item.id for item in theory[:4]], [True, True, True, False], strict=True)
    )
    for requirement_id, correct in theory_marks.items():
        assert _mark(exam, requirement_id, correct)["statusCode"] == 200
    marked = _mark(exam, practice[0].id, True)
    assert marked["statusCode"] == 200, marked["body"]

    # 3 of 11 theory items and 1 of 13 practice items correct: the copies do not count.
    expected = {
        "THEORY": {"kind": "THEORY", "total": 11, "marked": 4, "correct": 3, "percent": 27.3},
        "PRACTICE": {"kind": "PRACTICE", "total": 13, "marked": 1, "correct": 1, "percent": 7.7},
    }
    assert response_json(marked)["summary"] == expected
    assert _sheet(exam)["summary"] == expected

    unmarked = _unmark(exam, practice[0].id)
    assert unmarked["statusCode"] == 200, unmarked["body"]
    expected["PRACTICE"] = {
        "kind": "PRACTICE",
        "total": 13,
        "marked": 0,
        "correct": 0,
        "percent": 0.0,
    }
    assert response_json(unmarked)["summary"] == expected
    assert _sheet(exam)["summary"] == expected
    answers = {key: answer.correct for key, answer in answer_repo.list_by_exam(exam.id).items()}
    assert answers == theory_marks
    # The same score as the main items alone give.
    assert scoring.summary(main_items, answers) == expected


# --- marking and unmarking --------------------------------------------------


def test_rn006_item_of_another_profile_cannot_be_marked_nor_unmarked(
    main_items: list[Requirement], exam: Exam, copied_profile: str
) -> None:
    assert _mark(exam, main_items[0].id, True)["statusCode"] == 200
    own_item = next(
        item
        for item in requirement_repo.list_profile_belt(copied_profile, belt_id(TARGET))
        if item.description == "Item só do perfil copiado"
    )
    others = [
        _copy_of(copied_profile, main_items[0]),  # copy of an item already marked
        _copy_of(copied_profile, main_items[1]),  # copy of the item stored before profiles
        _copy_of(copied_profile, main_items[-1]),
        own_item.id,
    ]
    snapshot = dynamodb_snapshot()

    for requirement_id in others:
        _assert_rejected(_mark(exam, requirement_id, True), 400, NOT_IN_PROFILE)
        _assert_rejected(_mark(exam, requirement_id, False), 400, NOT_IN_PROFILE)
        _assert_rejected(_unmark(exam, requirement_id), 400, NOT_IN_PROFILE)

    # Nothing written: no answer, no answers counter on the copies.
    assert dynamodb_snapshot() == snapshot
    assert set(answer_repo.list_by_exam(exam.id)) == {main_items[0].id}
    for requirement_id in others:
        stored = table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": requirement_id})["Item"]
        assert "answer_count" not in stored


def test_rn006_item_of_another_profile_and_another_belt_answers_the_belt_message(
    main_items: list[Requirement], exam: Exam, copied_profile: str
) -> None:
    other_belt = next(item for item in seed_requirements() if item.belt_id == belt_id(OTHER_BELT))
    copy_id = _copy_of(copied_profile, other_belt)
    snapshot = dynamodb_snapshot()

    _assert_rejected(_mark(exam, copy_id, True), 400, NOT_IN_BELT)
    _assert_rejected(_unmark(exam, copy_id), 400, NOT_IN_BELT)
    _assert_rejected(_mark(exam, other_belt.id, True), 400, NOT_IN_BELT)
    assert dynamodb_snapshot() == snapshot


def test_rn006_items_of_the_main_profile_are_still_marked_and_unmarked(
    main_items: list[Requirement], exam: Exam, copied_profile: str
) -> None:
    # The item stored before the profiles existed is a main item too.
    for item in main_items[:2]:
        assert _mark(exam, item.id, True)["statusCode"] == 200
    assert _unmark(exam, main_items[0].id)["statusCode"] == 200

    sheet = _sheet(exam)
    answered = [item["id"] for item in sheet["items"] if item["answer"] is not None]
    assert answered == [main_items[1].id]


# --- the decision ----------------------------------------------------------


def test_rn007_rn008_decision_keeps_the_main_sheet_and_score(
    main_items: list[Requirement], exam: Exam, copied_profile: str
) -> None:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    theory = _of_kind(main_items, RequirementKind.THEORY)
    for item in theory[:2]:
        assert _mark(exam, item.id, True)["statusCode"] == 200
    before = _sheet(exam)

    decided = handlers.decide_exam(
        api_event(SENSEI, path=_path(exam), body={"result": "APPROVED"}), None
    )

    assert decided["statusCode"] == 200, decided["body"]
    assert response_json(decided)["exam"]["status"] == "APPROVED"
    after = _sheet(exam)
    assert after["items"] == before["items"]
    assert after["summary"] == before["summary"]
    assert after["summary"]["THEORY"] == {
        "kind": "THEORY",
        "total": 11,
        "marked": 2,
        "correct": 2,
        "percent": 18.2,
    }
    # Decided exam: the decision lock comes before the profile check (RN010).
    copy_id = _copy_of(copied_profile, theory[2])
    _assert_rejected(_mark(exam, copy_id, True), 409, "Exame já decidido")
    _assert_rejected(_unmark(exam, copy_id), 409, "Exame já decidido")
