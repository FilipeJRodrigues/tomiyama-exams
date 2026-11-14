"""The exam sheet holds the items of the event's requirement profile (RN006, RN007; #144, 3b-1).

The event chooses its profile (default: the main one). The sheet of each of
its exams, the score (also the one returned after a mark or unmark) and the
items that may be marked or unmarked are the target belt's items of that
profile only (``domain.exams.sheet_profile_id``). An item of any other
profile, the main one included when the event uses another, is refused with
400 "Item não pertence ao perfil de requisitos do exame", and nothing is
written. Two events with different profiles never mix their items, even for
the same target belt.
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
from domain.answers import MSG_ITEM_NOT_IN_PROFILE, ensure_can_mark
from domain.eligibility import ExamKind
from domain.errors import ValidationError
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
from handlers import events as event_handlers
from handlers import exams as handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as profile_handlers
from handlers import requirements as requirement_handlers
from repository import answers as answer_repo
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
OWN_ITEM = "Item só do perfil copiado"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


@pytest.fixture
def main_items(seeded: None) -> list[Requirement]:
    """Appendix A items of the target belt (11 theory, 13 practice) and of Cinza, in main."""
    belts = {belt_id(TARGET), belt_id(OTHER_BELT)}
    items = [item for item in seed_requirements() if item.belt_id in belts]
    for item in items:
        requirement_repo.create_requirement(item)
    return [item for item in items if item.belt_id == belt_id(TARGET)]


def _copy_profile(name: str) -> str:
    """Create a profile copied from main, run its copy and add a theory item only it has."""
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
                "description": OWN_ITEM,
                "expected_answer": "Resposta",
            },
        ),
        None,
    )
    assert extra["statusCode"] == 201, extra["body"]
    return profile_id


@pytest.fixture
def profile(main_items: list[Requirement], copy_invocations: CopyInvocations) -> str:
    """A ready profile copied from main: the target belt has 12 theory and 13 practice items."""
    return _copy_profile("Perfil do Sensei")


def _event(name: str, profile_id: str | None = None) -> str:
    body: dict[str, Any] = {"name": name, "exam_date": EVENT_DATE.isoformat()}
    if profile_id is not None:
        body["profile_id"] = profile_id
    response = event_handlers.create_event(api_event(EXAMINER, body=body), None)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)["id"]


def _attend(event_id: str, student_id: str, name: str) -> Exam:
    student_repo.create_student(replace(make_student(), id=student_id, full_name=name))
    response = handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": student_id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    stored = exam_repo.get_exam(event_id, student_id)
    assert stored is not None
    assert stored.target_belt_id == belt_id(TARGET)
    return stored


@pytest.fixture
def profile_exam(profile: str) -> Exam:
    """Ana's exam (Cinza → Cinza/Azul) in an event that uses the copied profile."""
    return _attend(_event("Exame do perfil", profile), "student-1", "Ana")


@pytest.fixture
def main_exam(profile: str) -> Exam:
    """Bia's exam, same target belt, in an event of the main profile (the default)."""
    return _attend(_event("Exame principal"), "student-2", "Bia")


def _profile_items(profile_id: str) -> list[Requirement]:
    return requirement_repo.list_profile_belt(profile_id, belt_id(TARGET))


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


def _summary(kind: str, total: int, marked: int, correct: int, percent: float) -> dict[str, Any]:
    return {
        "kind": kind,
        "total": total,
        "marked": marked,
        "correct": correct,
        "percent": percent,
    }


# --- the rule (pure) -------------------------------------------------------


def _domain_event(profile_id: str | None = None) -> ExamEvent:
    event = ExamEvent("event-1", "Exame março/2027", EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    return event if profile_id is None else replace(event, profile_id=profile_id)


def _domain_exam() -> Exam:
    return Exam(
        id="exam-1",
        event_id="event-1",
        student_id="student-1",
        target_belt_id="belt-target",
        kind=ExamKind.BELT,
        status=ExamStatus.IN_PROGRESS,
        decided_by_id=None,
        decided_at=None,
        notes=None,
        created_by="examiner-1",
        created_at=NOW,
    )


def _domain_item(profile_id: str, belt: str = "belt-target") -> Requirement:
    return Requirement("r", belt, RequirementKind.THEORY, "c", "d", None, 1, profile_id)


def test_rn006_sheet_profile_is_the_profile_of_the_event() -> None:
    assert sheet_profile_id(_domain_event()) == MAIN_PROFILE_ID
    assert sheet_profile_id(_domain_event("perfil-2")) == "perfil-2"


def test_rn006_only_items_of_the_events_profile_may_be_marked() -> None:
    exam_event = _domain_event("perfil-2")

    ensure_can_mark(_domain_exam(), exam_event, _domain_item("perfil-2"))
    for other in (MAIN_PROFILE_ID, "perfil-3"):
        with pytest.raises(ValidationError) as refused:
            ensure_can_mark(_domain_exam(), exam_event, _domain_item(other))
        assert refused.value.message == MSG_ITEM_NOT_IN_PROFILE == NOT_IN_PROFILE
    # The belt is still checked first.
    with pytest.raises(ValidationError) as other_belt:
        ensure_can_mark(_domain_exam(), exam_event, _domain_item("perfil-2", belt="belt-x"))
    assert other_belt.value.message == NOT_IN_BELT


# --- the sheet and its score ---------------------------------------------------


def test_rn006_sheet_lists_the_items_of_the_events_profile(
    main_items: list[Requirement], profile: str, profile_exam: Exam
) -> None:
    sheet = _sheet(profile_exam)

    expected = _profile_items(profile)
    assert len(expected) == len(main_items) + 1
    assert [item["id"] for item in sheet["items"]] == [item.id for item in expected]
    assert {item["profile_id"] for item in sheet["items"]} == {profile}
    assert OWN_ITEM in {item["description"] for item in sheet["items"]}
    # No item of the main profile, although it has the same belt.
    assert not {item["id"] for item in sheet["items"]} & {item.id for item in main_items}
    assert sheet["event"]["profile_id"] == profile
    assert sheet["summary"] == {
        "THEORY": _summary("THEORY", 12, 0, 0, 0.0),
        "PRACTICE": _summary("PRACTICE", 13, 0, 0, 0.0),
    }


def test_rn006_event_of_the_main_profile_keeps_the_main_sheet(
    main_items: list[Requirement], profile: str, main_exam: Exam
) -> None:
    sheet = _sheet(main_exam)

    assert [item["id"] for item in sheet["items"]] == [item.id for item in main_items]
    assert {item["profile_id"] for item in sheet["items"]} == {MAIN_PROFILE_ID}
    assert sheet["event"]["profile_id"] == "main"
    assert sheet["summary"]["THEORY"]["total"] == 11
    assert sheet["summary"]["PRACTICE"]["total"] == 13


def test_rn007_score_counts_only_the_items_of_the_events_profile(
    main_items: list[Requirement], profile: str, profile_exam: Exam
) -> None:
    items = _profile_items(profile)
    theory = _of_kind(items, RequirementKind.THEORY)
    practice = _of_kind(items, RequirementKind.PRACTICE)
    own_item = next(item for item in items if item.description == OWN_ITEM)
    theory_marks = {theory[0].id: True, theory[1].id: True, theory[2].id: False, own_item.id: True}
    for requirement_id, correct in theory_marks.items():
        assert _mark(profile_exam, requirement_id, correct)["statusCode"] == 200
    marked = _mark(profile_exam, practice[0].id, True)
    assert marked["statusCode"] == 200, marked["body"]

    # 3 of the profile's 12 theory items (not of the main profile's 11) and 1 of 13.
    expected = {
        "THEORY": _summary("THEORY", 12, 4, 3, 25.0),
        "PRACTICE": _summary("PRACTICE", 13, 1, 1, 7.7),
    }
    assert response_json(marked)["summary"] == expected
    assert _sheet(profile_exam)["summary"] == expected

    unmarked = _unmark(profile_exam, practice[0].id)
    assert unmarked["statusCode"] == 200, unmarked["body"]
    expected["PRACTICE"] = _summary("PRACTICE", 13, 0, 0, 0.0)
    assert response_json(unmarked)["summary"] == expected
    assert _sheet(profile_exam)["summary"] == expected
    answers = {
        key: answer.correct for key, answer in answer_repo.list_by_exam(profile_exam.id).items()
    }
    assert answers == theory_marks
    assert scoring.summary(items, answers) == expected


# --- marking and unmarking --------------------------------------------------


def test_rn006_item_of_the_main_profile_is_refused_in_an_event_of_another_profile(
    main_items: list[Requirement], profile: str, profile_exam: Exam
) -> None:
    copy_id = copied_requirement_id(profile, main_items[0].id)
    assert _mark(profile_exam, copy_id, True)["statusCode"] == 200
    snapshot = dynamodb_snapshot()

    # The original of an item already marked through its copy, and two others.
    for item in (main_items[0], main_items[1], main_items[-1]):
        _assert_rejected(_mark(profile_exam, item.id, True), 400, NOT_IN_PROFILE)
        _assert_rejected(_mark(profile_exam, item.id, False), 400, NOT_IN_PROFILE)
        _assert_rejected(_unmark(profile_exam, item.id), 400, NOT_IN_PROFILE)

    # Nothing written: no answer, no answers counter on the main items.
    assert dynamodb_snapshot() == snapshot
    assert set(answer_repo.list_by_exam(profile_exam.id)) == {copy_id}
    for item in (main_items[0], main_items[1], main_items[-1]):
        stored = table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": item.id})["Item"]
        assert "answer_count" not in stored


def test_rn006_item_of_a_third_profile_is_refused(
    main_items: list[Requirement], profile: str, profile_exam: Exam
) -> None:
    third = _copy_profile("Outro perfil")
    third_copy = copied_requirement_id(third, main_items[0].id)
    snapshot = dynamodb_snapshot()

    _assert_rejected(_mark(profile_exam, third_copy, True), 400, NOT_IN_PROFILE)
    _assert_rejected(_unmark(profile_exam, third_copy), 400, NOT_IN_PROFILE)
    assert dynamodb_snapshot() == snapshot


def test_rn006_item_of_another_belt_answers_the_belt_message_in_any_profile(
    main_items: list[Requirement], profile: str, profile_exam: Exam
) -> None:
    other_belt = next(item for item in seed_requirements() if item.belt_id == belt_id(OTHER_BELT))
    snapshot = dynamodb_snapshot()

    # Same profile as the event, another belt; and the main item of that belt.
    _assert_rejected(
        _mark(profile_exam, copied_requirement_id(profile, other_belt.id), True), 400, NOT_IN_BELT
    )
    _assert_rejected(_mark(profile_exam, other_belt.id, True), 400, NOT_IN_BELT)
    _assert_rejected(_unmark(profile_exam, other_belt.id), 400, NOT_IN_BELT)
    assert dynamodb_snapshot() == snapshot


# --- two events, two profiles, the same belt ---------------------------------


def test_rn006_rn007_events_with_different_profiles_do_not_mix(
    main_items: list[Requirement], profile: str, profile_exam: Exam, main_exam: Exam
) -> None:
    assert profile_exam.target_belt_id == main_exam.target_belt_id
    theory = _of_kind(main_items, RequirementKind.THEORY)
    copies = [copied_requirement_id(profile, item.id) for item in theory]

    # The same two questions in each exam: the originals in one, the copies in the other.
    for item in theory[:2]:
        assert _mark(main_exam, item.id, True)["statusCode"] == 200
    for copy_id in copies[:2]:
        assert _mark(profile_exam, copy_id, False)["statusCode"] == 200
    assert _mark(profile_exam, copies[2], True)["statusCode"] == 200

    main_sheet = _sheet(main_exam)
    profile_sheet = _sheet(profile_exam)
    assert main_sheet["summary"]["THEORY"] == _summary("THEORY", 11, 2, 2, 18.2)
    assert profile_sheet["summary"]["THEORY"] == _summary("THEORY", 12, 3, 1, 8.3)
    main_ids = {item["id"] for item in main_sheet["items"]}
    profile_ids = {item["id"] for item in profile_sheet["items"]}
    assert not main_ids & profile_ids
    assert {item["profile_id"] for item in main_sheet["items"]} == {MAIN_PROFILE_ID}
    assert {item["profile_id"] for item in profile_sheet["items"]} == {profile}
    assert set(answer_repo.list_by_exam(main_exam.id)) == {item.id for item in theory[:2]}
    assert set(answer_repo.list_by_exam(profile_exam.id)) == set(copies[:3])

    # Each exam refuses the other's items.
    snapshot = dynamodb_snapshot()
    _assert_rejected(_mark(main_exam, copies[0], True), 400, NOT_IN_PROFILE)
    _assert_rejected(_unmark(main_exam, copies[0]), 400, NOT_IN_PROFILE)
    _assert_rejected(_mark(profile_exam, theory[0].id, True), 400, NOT_IN_PROFILE)
    _assert_rejected(_unmark(profile_exam, theory[0].id), 400, NOT_IN_PROFILE)
    assert dynamodb_snapshot() == snapshot


def test_rn006_editing_the_events_profile_changes_only_its_sheet(
    main_items: list[Requirement], profile: str, profile_exam: Exam, main_exam: Exam
) -> None:
    main_before = _sheet(main_exam)
    added = requirement_handlers.create_requirement(
        api_event(
            EXAMINER,
            body={
                "profile_id": profile,
                "belt_id": belt_id(TARGET),
                "kind": "PRACTICE",
                "category": "Ukemi",
                "description": "Outro item só do perfil",
            },
        ),
        None,
    )
    assert added["statusCode"] == 201, added["body"]

    assert _sheet(profile_exam)["summary"]["PRACTICE"]["total"] == 14
    assert _sheet(main_exam) == main_before


# --- the decision ----------------------------------------------------------


def test_rn007_rn008_decision_keeps_the_sheet_of_the_events_profile(
    main_items: list[Requirement], profile: str, profile_exam: Exam
) -> None:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    theory = _of_kind(_profile_items(profile), RequirementKind.THEORY)
    for item in theory[:3]:
        assert _mark(profile_exam, item.id, True)["statusCode"] == 200
    before = _sheet(profile_exam)

    decided = handlers.decide_exam(
        api_event(SENSEI, path=_path(profile_exam), body={"result": "APPROVED"}), None
    )

    assert decided["statusCode"] == 200, decided["body"]
    assert response_json(decided)["exam"]["status"] == "APPROVED"
    after = _sheet(profile_exam)
    assert after["items"] == before["items"]
    assert after["summary"] == before["summary"]
    assert after["summary"]["THEORY"] == _summary("THEORY", 12, 3, 3, 25.0)
    # Decided exam: the decision lock comes before the profile check (RN010).
    _assert_rejected(_mark(profile_exam, main_items[0].id, True), 409, "Exame já decidido")


def test_rn016_event_with_exams_keeps_its_sheet_profile(
    main_items: list[Requirement], profile: str, profile_exam: Exam
) -> None:
    before = _sheet(profile_exam)

    response = event_handlers.update_event(
        api_event(
            EXAMINER,
            path={"id": profile_exam.event_id},
            body={"name": "Exame do perfil", "profile_id": "main"},
        ),
        None,
    )

    assert response["statusCode"] == 409, response["body"]
    assert _sheet(profile_exam) == before
