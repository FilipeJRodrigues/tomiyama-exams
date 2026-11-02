"""The sensei's decision (RN008, RN008a, RN009, RN010).

Only the configured sensei decides, whatever the score; approval updates the
student's graduation in the same transaction; a decided exam is final, for the
decision and for the answers; a closed event still accepts decisions; the
decision is refused if the graduation changed since the attendance.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    GUARDIAN,
    MASTER,
    MASTER_SUB,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain import dates
from domain import decisions as decision_rules
from domain.eligibility import ExamKind
from domain.errors import MSG_SERVICE_BUSY, ConflictError, ForbiddenError, ValidationError
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam, ExamStatus, Graduation
from domain.requirements import Requirement, RequirementKind
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, GUARDIAN_GROUP, MASTER_GROUP, User
from handlers import exams as handlers
from repository import answers as answer_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EXAM_IN_PROGRESS, EXAMS_TABLE_ENV, STUDENTS_TABLE_ENV, table

EVENT_DATE = date(2027, 3, 20)
NOW = "2026-11-01T12:00:00+00:00"
DECIDED_AT = "2027-03-20T15:00:00+00:00"
SENSEI_SUB = "sensei-1"
SENSEI = User(sub=SENSEI_SUB, email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
OTHER_EXAMINER = EXAMINER
DECIDED = "Exame já decidido"
ONLY_SENSEI = "Somente o sensei pode decidir o exame"
NO_SENSEI = "Defina o sensei nas configurações da academia"
CHANGED = "A graduação do aluno mudou desde a presença. Confira antes de decidir."
TRY_AGAIN = "Outra alteração deste exame está em andamento. Tente de novo."
BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: DECIDED_AT)


def _set_sensei(sensei_user_id: str | None) -> None:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=sensei_user_id,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )


@pytest.fixture
def exam_event(seeded: None) -> ExamEvent:
    event = ExamEvent("event-1", "Exame março/2027", EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(event)
    _set_sensei(SENSEI_SUB)
    return event


def _confirm(exam_event: ExamEvent, student: Student) -> Exam:
    student_repo.create_student(student)
    response = handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    stored = exam_repo.get_exam(exam_event.id, student.id)
    assert stored is not None
    return stored


@pytest.fixture
def belt_exam(exam_event: ExamEvent) -> Exam:
    """Ana, Cinza since 2026-03-14 → belt exam to Cinza/Azul."""
    student = replace(make_student(), federation_id="FPJ-123")
    exam = _confirm(exam_event, student)
    assert (exam.kind, exam.target_belt_id) == (ExamKind.BELT, belt_id("Cinza/Azul"))
    return exam


@pytest.fixture
def stripe_exam(exam_event: ExamEvent) -> Exam:
    """Bia, Verde with no stripes (17 years old) → stripe exam towards Roxa."""
    student = replace(
        make_student(belt_name="Verde", birth=date(2010, 1, 1), since=date(2026, 6, 1)),
        id="student-2",
        full_name="Bia",
    )
    exam = _confirm(exam_event, student)
    assert (exam.kind, exam.target_belt_id) == (ExamKind.STRIPE, belt_id("Roxa"))
    return exam


def _decide(exam: Exam, body: Any, user: User | None = SENSEI) -> dict[str, Any]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    return handlers.decide_exam(api_event(user, path=path, body=body), None)


def _approve(exam: Exam, user: User | None = SENSEI, **extra: Any) -> dict[str, Any]:
    return _decide(exam, {"result": "APPROVED", **extra}, user)


def _fail(exam: Exam, user: User | None = SENSEI, **extra: Any) -> dict[str, Any]:
    return _decide(exam, {"result": "FAILED", **extra}, user)


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response) == {"message": message}


def _stored_exam(exam: Exam) -> Exam:
    stored = exam_repo.get_exam(exam.event_id, exam.student_id)
    assert stored is not None
    return stored


def _student_item(student_id: str) -> dict[str, Any]:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id})["Item"]


def _assert_untouched(exam: Exam, student_before: dict[str, Any]) -> None:
    assert _stored_exam(exam) == exam
    assert _student_item(exam.student_id) == student_before


def _cancelled(*codes: str) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
            "CancellationReasons": [{"Code": code} for code in codes],
        },
        "TransactWriteItems",
    )


def _close_event(exam_event: ExamEvent) -> None:
    event_repo.save_event(replace(exam_event, status=EventStatus.CLOSED))


# --- RN005: the attendance stores the graduation it was based on ------------------


def test_rn005_attendance_stores_the_source_graduation(belt_exam: Exam) -> None:
    assert belt_exam.source == Graduation(belt_id("Cinza"), date(2026, 3, 14), 0)
    view = belt_exam.to_dict()
    assert view["source_belt_id"] == belt_id("Cinza")
    assert view["source_belt_since"] == "2026-03-14"
    assert view["source_stripes"] == 0


# --- RN008: who decides --------------------------------------------------------------


def test_rn008_rn009_sensei_approves_belt_exam(belt_exam: Exam) -> None:
    before = _student_item(belt_exam.student_id)

    response = _approve(belt_exam, notes="  Ótimo ukemi  ")

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["exam"]["status"] == "APPROVED"
    assert body["exam"]["decided_by_id"] == SENSEI_SUB
    assert body["exam"]["decided_at"] == DECIDED_AT
    assert body["exam"]["notes"] == "Ótimo ukemi"
    assert body["exam"]["student_name"] == "Ana"
    assert body["student"]["current_belt_id"] == belt_id("Cinza/Azul")
    assert body["student"]["current_belt_since"] == EVENT_DATE.isoformat()
    assert body["student"]["stripes"] == 0

    stored = _stored_exam(belt_exam)
    assert stored.status == ExamStatus.APPROVED
    assert (stored.decided_by_id, stored.decided_at, stored.notes) == (
        SENSEI_SUB,
        DECIDED_AT,
        "Ótimo ukemi",
    )
    assert stored.source == belt_exam.source  # the origin is kept for the certificate
    after = _student_item(belt_exam.student_id)
    assert after["current_belt_id"] == belt_id("Cinza/Azul")
    assert after["current_belt_since"] == EVENT_DATE.isoformat()
    assert after["stripes"] == 0
    assert after["updated_at"] == DECIDED_AT
    # Only the graduation changed and the exam-in-progress marker left (RN005):
    # the counter and every other field are kept.
    assert before[EXAM_IN_PROGRESS] == belt_exam.id
    assert EXAM_IN_PROGRESS not in after
    changed = {"current_belt_id", "current_belt_since", "stripes", "updated_at", EXAM_IN_PROGRESS}
    unchanged = {k: v for k, v in before.items() if k not in changed}
    assert {k: after[k] for k in unchanged} == unchanged
    assert after["exam_count"] == 1
    assert after["federation_id"] == "FPJ-123"


def test_rn008_decision_does_not_depend_on_the_score(belt_exam: Exam) -> None:
    requirement = Requirement(
        "t1", belt_id("Cinza/Azul"), RequirementKind.THEORY, "Vocabulário", "Item", None, 1
    )
    requirement_repo.create_requirement(requirement)
    # Nothing marked (0%): the sensei still approves.
    assert _approve(belt_exam)["statusCode"] == 200


def test_rn008_rn009_sensei_fails_and_student_does_not_change(belt_exam: Exam) -> None:
    before = _student_item(belt_exam.student_id)

    response = _fail(belt_exam)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["exam"]["status"] == "FAILED"
    assert body["exam"]["decided_by_id"] == SENSEI_SUB
    assert body["exam"]["notes"] is None
    assert body["student"] is None
    assert _stored_exam(belt_exam).status == ExamStatus.FAILED
    # Only the exam-in-progress marker leaves the student (RN005).
    assert before.pop(EXAM_IN_PROGRESS) == belt_exam.id
    assert _student_item(belt_exam.student_id) == before


@pytest.mark.parametrize(
    "user",
    [
        OTHER_EXAMINER,
        MASTER,
        # Same groups as the sensei but another account.
        User(sub="examiner-9", email="x@example.com", groups=frozenset({ADMIN_GROUP})),
    ],
    ids=["examiner", "master", "other"],
)
def test_rn008_only_the_sensei_decides(belt_exam: Exam, user: User) -> None:
    before = _student_item(belt_exam.student_id)

    _assert_rejected(_approve(belt_exam, user), 403, ONLY_SENSEI)
    _assert_rejected(_fail(belt_exam, user), 403, ONLY_SENSEI)
    _assert_untouched(belt_exam, before)


def test_rn008_master_decides_when_he_is_the_sensei(belt_exam: Exam) -> None:
    _set_sensei(MASTER_SUB)

    response = _approve(belt_exam, MASTER)

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["exam"]["decided_by_id"] == MASTER_SUB


def test_rn008_previous_sensei_no_longer_decides(belt_exam: Exam) -> None:
    _set_sensei(EXAMINER.sub)

    _assert_rejected(_approve(belt_exam, SENSEI), 403, ONLY_SENSEI)
    assert _approve(belt_exam, EXAMINER)["statusCode"] == 200


def test_rn008_route_is_for_examiners_only(belt_exam: Exam) -> None:
    before = _student_item(belt_exam.student_id)
    # The sensei's account that left the group admin (token renewed): no longer decides.
    left_admin = User(sub=SENSEI_SUB, email=SENSEI.email, groups=frozenset({GUARDIAN_GROUP}))
    master_only = User(sub=SENSEI_SUB, email=SENSEI.email, groups=frozenset({MASTER_GROUP}))

    _assert_rejected(_approve(belt_exam, GUARDIAN), 403, "Esta área é dos examinadores")
    _assert_rejected(_approve(belt_exam, left_admin), 403, "Esta área é dos examinadores")
    _assert_rejected(_approve(belt_exam, master_only), 403, "Esta área é dos examinadores")
    _assert_rejected(_approve(belt_exam, None), 401, "Faça login para continuar")
    _assert_untouched(belt_exam, before)


def test_rn008_sensei_must_be_an_examiner_in_the_token() -> None:
    not_examiner = User(sub=SENSEI_SUB, email=None, groups=frozenset({GUARDIAN_GROUP}))

    with pytest.raises(ForbiddenError, match=ONLY_SENSEI):
        decision_rules.ensure_is_sensei(not_examiner, SENSEI_SUB)
    decision_rules.ensure_is_sensei(SENSEI, SENSEI_SUB)


@pytest.mark.parametrize("settings", ["missing", "no_sensei"])
def test_rn008_without_sensei_is_409(belt_exam: Exam, settings: str) -> None:
    if settings == "missing":
        table("SETTINGS_TABLE").delete_item(Key={"id": "academy"})
    else:
        _set_sensei(None)
    before = _student_item(belt_exam.student_id)

    _assert_rejected(_approve(belt_exam), 409, NO_SENSEI)
    _assert_rejected(_approve(belt_exam, MASTER), 409, NO_SENSEI)
    _assert_untouched(belt_exam, before)


def test_rn008_sensei_is_read_at_decision_time(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}
    real = settings_repo.get_settings

    def counting() -> AcademySettings | None:
        calls["n"] += 1
        return real()

    monkeypatch.setattr(settings_repo, "get_settings", counting)
    assert _approve(belt_exam)["statusCode"] == 200
    assert calls["n"] == 1


@pytest.mark.parametrize("change", ["sensei_removed", "settings_deleted", "other_sensei"])
def test_rn008_sensei_changed_between_read_and_write_writes_nothing(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    stale = settings_repo.get_settings()
    # The master changes the settings after the handler read them.
    if change == "settings_deleted":
        table("SETTINGS_TABLE").delete_item(Key={"id": "academy"})
    else:
        _set_sensei(None if change == "sensei_removed" else OTHER_EXAMINER.sub)
    monkeypatch.setattr(settings_repo, "get_settings", lambda: stale)
    before = _student_item(belt_exam.student_id)

    status, message = (403, ONLY_SENSEI) if change == "other_sensei" else (409, NO_SENSEI)
    _assert_rejected(_approve(belt_exam), status, message)
    _assert_untouched(belt_exam, before)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, decision_rules.MSG_INVALID_RESULT),
        ({"result": "approved"}, decision_rules.MSG_INVALID_RESULT),
        ({"result": "IN_PROGRESS"}, decision_rules.MSG_INVALID_RESULT),
        ({"result": True}, decision_rules.MSG_INVALID_RESULT),
        ({"result": ["APPROVED"]}, decision_rules.MSG_INVALID_RESULT),
        ({"result": "APPROVED", "notes": 5}, "Observação: valor inválido"),
        ({"result": "APPROVED", "notes": "x" * 501}, "Observação: máximo de 500 caracteres"),
        ([], "Corpo da requisição inválido: envie um objeto JSON"),
    ],
)
def test_rn008_invalid_body_is_400(belt_exam: Exam, body: Any, message: str) -> None:
    before = _student_item(belt_exam.student_id)

    _assert_rejected(_decide(belt_exam, body), 400, message)
    _assert_untouched(belt_exam, before)


def test_rn008_notes_limit_and_blank_notes(belt_exam: Exam, stripe_exam: Exam) -> None:
    response = _approve(belt_exam, notes="x" * 500)
    assert response_json(response)["exam"]["notes"] == "x" * 500

    response = _fail(stripe_exam, notes="   ")
    assert response["statusCode"] == 200
    assert response_json(response)["exam"]["notes"] is None
    assert (
        "notes"
        not in table(EXAMS_TABLE_ENV).get_item(
            Key={"event_id": stripe_exam.event_id, "student_id": stripe_exam.student_id}
        )["Item"]
    )


def test_rn008_unknown_event_or_exam_is_404(belt_exam: Exam) -> None:
    _assert_rejected(_approve(replace(belt_exam, event_id="event-x")), 404, "Evento não encontrado")
    _assert_rejected(_approve(replace(belt_exam, student_id="nobody")), 404, "Exame não encontrado")


def test_rn008_parse_decision() -> None:
    assert decision_rules.parse_decision({"result": "FAILED"}) == decision_rules.Decision(
        ExamStatus.FAILED, None
    )
    with pytest.raises(ValidationError):
        decision_rules.parse_decision({"result": "IN_PROGRESS"})


# --- RN009: effect of the approval -----------------------------------------------------


def test_rn009_stripe_approved_adds_a_stripe_and_keeps_the_belt(stripe_exam: Exam) -> None:
    before = _student_item(stripe_exam.student_id)

    response = _approve(stripe_exam)

    assert response["statusCode"] == 200, response["body"]
    after = _student_item(stripe_exam.student_id)
    assert after["current_belt_id"] == belt_id("Verde")
    assert after["current_belt_since"] == before["current_belt_since"]
    assert after["stripes"] == 1
    assert response_json(response)["student"]["stripes"] == 1


def test_rn009_belt_exam_of_intermediate_belt_resets_stripes(exam_event: ExamEvent) -> None:
    student = replace(
        make_student(belt_name="Verde", birth=date(2010, 1, 1), since=date(2026, 6, 1), stripes=1),
        id="student-3",
    )
    exam = _confirm(exam_event, student)
    assert exam.kind == ExamKind.BELT

    assert _approve(exam)["statusCode"] == 200

    after = _student_item(exam.student_id)
    assert (after["current_belt_id"], after["current_belt_since"], after["stripes"]) == (
        belt_id("Roxa"),
        EVENT_DATE.isoformat(),
        0,
    )


def test_rn009_approved_student_rules() -> None:
    event = ExamEvent("e", "Exame", EVENT_DATE, EventStatus.CLOSED, NOW, NOW)
    student = make_student(belt_name="Verde", stripes=0)
    exam = Exam(
        "x", "e", student.id, belt_id("Roxa"), ExamKind.STRIPE, ExamStatus.IN_PROGRESS,
        None, None, None, "examiner-1", NOW,
    )  # fmt: skip

    stripe = decision_rules.approved_student(exam, student, event, DECIDED_AT)
    belt_up = decision_rules.approved_student(
        replace(exam, kind=ExamKind.BELT), student, event, DECIDED_AT
    )

    assert (stripe.current_belt_id, stripe.current_belt_since, stripe.stripes) == (
        student.current_belt_id,
        student.current_belt_since,
        1,
    )
    assert (belt_up.current_belt_id, belt_up.current_belt_since, belt_up.stripes) == (
        belt_id("Roxa"),
        EVENT_DATE,
        0,
    )


# --- RN008a: closed event -------------------------------------------------------------


def test_rn008a_closed_event_still_accepts_the_decision(
    exam_event: ExamEvent, belt_exam: Exam, stripe_exam: Exam
) -> None:
    _close_event(exam_event)

    assert _approve(belt_exam)["statusCode"] == 200
    assert _fail(stripe_exam)["statusCode"] == 200
    assert _student_item(belt_exam.student_id)["current_belt_id"] == belt_id("Cinza/Azul")


# --- RN010: final decision ------------------------------------------------------------


@pytest.mark.parametrize("first", ["APPROVED", "FAILED"])
@pytest.mark.parametrize("second", ["APPROVED", "FAILED"])
def test_rn010_decided_exam_cannot_be_decided_again(
    stripe_exam: Exam, first: str, second: str
) -> None:
    assert _decide(stripe_exam, {"result": first})["statusCode"] == 200
    decided = _stored_exam(stripe_exam)
    student_after_first = _student_item(stripe_exam.student_id)

    _assert_rejected(_decide(stripe_exam, {"result": second, "notes": "outra"}), 409, DECIDED)
    assert _stored_exam(stripe_exam) == decided
    assert _student_item(stripe_exam.student_id) == student_after_first


def test_rn010_decision_race_applies_the_approval_once(
    stripe_exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two decisions read the exam in progress; the first one commits.
    stale_student = student_repo.get_student(stripe_exam.student_id)
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: stripe_exam)
    monkeypatch.setattr(student_repo, "get_student", lambda student_id: stale_student)
    assert _approve(stripe_exam)["statusCode"] == 200

    _assert_rejected(_approve(stripe_exam), 409, DECIDED)
    _assert_rejected(_fail(stripe_exam), 409, DECIDED)
    assert _student_item(stripe_exam.student_id)["stripes"] == 1  # not 2


def _mark(exam: Exam, requirement_id: str, correct: bool) -> dict[str, Any]:
    path = {"id": exam.event_id, "student_id": exam.student_id, "requirement_id": requirement_id}
    return handlers.mark_answer(api_event(EXAMINER, path=path, body={"correct": correct}), None)


def _unmark(exam: Exam, requirement_id: str) -> dict[str, Any]:
    path = {"id": exam.event_id, "student_id": exam.student_id, "requirement_id": requirement_id}
    return handlers.unmark_answer(api_event(EXAMINER, path=path), None)


@pytest.fixture
def items(belt_exam: Exam) -> list[Requirement]:
    requirements = [
        Requirement(
            req_id, belt_id("Cinza/Azul"), RequirementKind.THEORY, "Vocabulário", req_id, None, n
        )
        for n, req_id in enumerate(("t1", "t2"), start=1)
    ]
    for requirement in requirements:
        requirement_repo.create_requirement(requirement)
    return requirements


@pytest.mark.parametrize("decide", [_approve, _fail])
def test_rn010_answers_are_final_after_the_decision(
    items: list[Requirement], belt_exam: Exam, decide: Any
) -> None:
    assert _mark(belt_exam, "t1", True)["statusCode"] == 200
    assert decide(belt_exam)["statusCode"] == 200

    _assert_rejected(_mark(belt_exam, "t1", False), 409, DECIDED)
    _assert_rejected(_mark(belt_exam, "t2", True), 409, DECIDED)
    _assert_rejected(_unmark(belt_exam, "t1"), 409, DECIDED)
    answers = answer_repo.list_by_exam(belt_exam.id)
    assert {key: answer.correct for key, answer in answers.items()} == {"t1": True}


@pytest.mark.parametrize("already_marked", [False, True])
def test_rn010_marking_that_read_the_exam_before_the_decision_is_refused(
    items: list[Requirement],
    belt_exam: Exam,
    monkeypatch: pytest.MonkeyPatch,
    already_marked: bool,
) -> None:
    if already_marked:
        assert _mark(belt_exam, "t1", True)["statusCode"] == 200
    assert _approve(belt_exam)["statusCode"] == 200
    # The marking request read the exam while it was still in progress.
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: belt_exam)

    _assert_rejected(_mark(belt_exam, "t1", False), 409, DECIDED)
    _assert_rejected(_unmark(belt_exam, "t1"), 409, DECIDED)
    answers = answer_repo.list_by_exam(belt_exam.id)
    assert [answer.correct for answer in answers.values()] == ([True] if already_marked else [])


def test_rn010_marking_before_the_decision_write_does_not_block_it(
    items: list[Requirement], belt_exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A mark that lands between the decision's read and write is kept as is:
    # the score is only support for the sensei (RN008).
    real = exam_repo._transact_decision

    def mark_first(transact_items: list[dict[str, Any]]) -> None:
        assert _mark(belt_exam, "t1", True)["statusCode"] == 200
        real(transact_items)

    monkeypatch.setattr(exam_repo, "_transact_decision", mark_first)

    assert _approve(belt_exam)["statusCode"] == 200
    assert set(answer_repo.list_by_exam(belt_exam.id)) == {"t1"}
    _assert_rejected(_mark(belt_exam, "t2", True), 409, DECIDED)


# --- Graduation changed since the attendance (decision of 2026-11-02) -------------------


@pytest.mark.parametrize(
    "change",
    [
        {"current_belt_id": belt_id("Azul")},
        {"current_belt_since": date(2026, 4, 1)},
        {"stripes": 1},
    ],
    ids=["belt", "belt_since", "stripes"],
)
@pytest.mark.parametrize("decide", [_approve, _fail])
def test_rn009_graduation_changed_since_attendance_is_409(
    belt_exam: Exam, change: dict[str, Any], decide: Any
) -> None:
    student = student_repo.get_student(belt_exam.student_id)
    assert student is not None
    student_repo.save_student(replace(student, **change))
    before = _student_item(belt_exam.student_id)

    _assert_rejected(decide(belt_exam), 409, CHANGED)
    _assert_untouched(belt_exam, before)


@pytest.mark.parametrize("decide", [_approve, _fail])
def test_rn009_graduation_changed_between_read_and_write_is_409(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch, decide: Any
) -> None:
    stale = student_repo.get_student(belt_exam.student_id)
    assert stale is not None
    student_repo.save_student(replace(stale, current_belt_id=belt_id("Azul")))
    monkeypatch.setattr(student_repo, "get_student", lambda student_id: stale)
    before = _student_item(belt_exam.student_id)

    _assert_rejected(decide(belt_exam), 409, CHANGED)
    _assert_untouched(belt_exam, before)


def test_rn009_inactive_student_may_still_be_decided(belt_exam: Exam) -> None:
    student = student_repo.get_student(belt_exam.student_id)
    assert student is not None
    student_repo.save_student(replace(student, active=False))

    assert _approve(belt_exam)["statusCode"] == 200

    after = _student_item(belt_exam.student_id)
    assert after["active"] is False
    assert after["current_belt_id"] == belt_id("Cinza/Azul")


def _drop_source(exam: Exam) -> Exam:
    """Turn the stored exam into one confirmed before the source was stored."""
    table(EXAMS_TABLE_ENV).update_item(
        Key={"event_id": exam.event_id, "student_id": exam.student_id},
        UpdateExpression="REMOVE source_belt_id, source_belt_since, source_stripes",
    )
    legacy = _stored_exam(exam)
    assert legacy.source is None
    return legacy


@pytest.mark.parametrize("fixture", ["belt_exam", "stripe_exam"])
def test_rn009_exam_without_source_is_decided_when_graduation_matches(
    fixture: str, request: pytest.FixtureRequest
) -> None:
    exam = _drop_source(request.getfixturevalue(fixture))

    assert _approve(exam)["statusCode"] == 200
    assert _stored_exam(exam).status == ExamStatus.APPROVED


@pytest.mark.parametrize(
    "change",
    [
        {"current_belt_id": belt_id("Azul")},  # target no longer the next belt
        {"current_belt_id": belt_id("Branca/Cinza")},
    ],
)
def test_rn009_exam_without_source_with_another_belt_is_409(
    belt_exam: Exam, change: dict[str, Any]
) -> None:
    exam = _drop_source(belt_exam)
    student = student_repo.get_student(exam.student_id)
    assert student is not None
    student_repo.save_student(replace(student, **change))
    before = _student_item(exam.student_id)

    _assert_rejected(_approve(exam), 409, CHANGED)
    _assert_untouched(exam, before)


def test_rn009_stripe_exam_without_source_after_a_stripe_is_409(stripe_exam: Exam) -> None:
    exam = _drop_source(stripe_exam)
    student = student_repo.get_student(exam.student_id)
    assert student is not None
    student_repo.save_student(replace(student, stripes=1))  # now a belt exam

    _assert_rejected(_approve(exam), 409, CHANGED)


def test_rn009_expected_graduation_rules() -> None:
    from domain.belts import SEED_BELTS

    student = make_student(belt_name="Cinza")
    exam = Exam(
        "x", "e", student.id, belt_id("Cinza/Azul"), ExamKind.BELT, ExamStatus.IN_PROGRESS,
        None, None, None, "examiner-1", NOW, source=Graduation.of(student),
    )  # fmt: skip
    assert decision_rules.expected_graduation(exam, student, []) == Graduation.of(student)
    with pytest.raises(ConflictError, match="graduação"):
        decision_rules.expected_graduation(exam, replace(student, stripes=1), [])
    legacy = replace(exam, source=None)
    assert decision_rules.expected_graduation(legacy, student, SEED_BELTS) == Graduation.of(student)
    unknown = replace(student, current_belt_id="gone")
    with pytest.raises(ConflictError):
        decision_rules.expected_graduation(legacy, unknown, SEED_BELTS)


# --- Concurrency and capacity ------------------------------------------------------------


def test_rn008_transaction_conflict_is_retried(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = exam_repo._transact_decision
    calls = {"n": 0}

    def flaky(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _cancelled("TransactionConflict", "None")
        real(transact_items)

    monkeypatch.setattr(exam_repo, "_transact_decision", flaky)
    monkeypatch.setattr(exam_repo.time, "sleep", lambda seconds: None)

    assert _approve(belt_exam)["statusCode"] == 200
    assert calls["n"] == 2
    assert _student_item(belt_exam.student_id)["current_belt_id"] == belt_id("Cinza/Azul")


@pytest.mark.parametrize(
    ("codes", "status", "message"),
    [
        (("TransactionConflict", "None"), 409, TRY_AGAIN),
        (("None", "TransactionConflict"), 409, TRY_AGAIN),
        (("ThrottlingError", "None"), 503, BUSY),
        (("None", "ProvisionedThroughputExceeded"), 503, BUSY),
    ],
)
def test_rn008_persistent_cancellation_is_409_or_503_not_500(
    belt_exam: Exam,
    monkeypatch: pytest.MonkeyPatch,
    codes: tuple[str, ...],
    status: int,
    message: str,
) -> None:
    calls = {"n": 0}

    def always(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        raise _cancelled(*codes)

    monkeypatch.setattr(exam_repo, "_transact_decision", always)
    monkeypatch.setattr(exam_repo.time, "sleep", lambda seconds: None)
    before = _student_item(belt_exam.student_id)

    _assert_rejected(_approve(belt_exam), status, message)
    assert calls["n"] > 1
    _assert_untouched(belt_exam, before)


@pytest.mark.parametrize(
    "code",
    ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"],
)
def test_rn008_throttled_request_is_503(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    def throttled(transact_items: list[dict[str, Any]]) -> None:
        raise ClientError({"Error": {"Code": code, "Message": "slow down"}}, "TransactWriteItems")

    monkeypatch.setattr(exam_repo, "_transact_decision", throttled)

    _assert_rejected(_approve(belt_exam), 503, BUSY)


def test_rn008_settings_throttled_is_503(belt_exam: Exam, monkeypatch: pytest.MonkeyPatch) -> None:
    class Throttled:
        def get_item(self, **kwargs: Any) -> None:
            raise ClientError(
                {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
                "GetItem",
            )

    real_table = settings_repo.table
    monkeypatch.setattr(
        settings_repo,
        "table",
        lambda env: Throttled() if env == "SETTINGS_TABLE" else real_table(env),
    )

    _assert_rejected(_approve(belt_exam), 503, BUSY)


def test_rn008_exam_replaced_between_read_and_write_is_404(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The request read an exam that was deleted and confirmed again (new id).
    other = replace(belt_exam, id="old-exam-id")
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: other)
    key = {"event_id": belt_exam.event_id, "student_id": belt_exam.student_id}
    exam_before = table(EXAMS_TABLE_ENV).get_item(Key=key)["Item"]
    before = _student_item(belt_exam.student_id)

    _assert_rejected(_approve(belt_exam), 404, "Exame não encontrado")
    assert table(EXAMS_TABLE_ENV).get_item(Key=key)["Item"] == exam_before
    assert _student_item(belt_exam.student_id) == before


# --- Sensei ConditionCheck, third item of the transaction (added by QA) --------------------


@pytest.mark.parametrize(
    ("codes", "status", "message"),
    [
        (("None", "None", "TransactionConflict"), 409, TRY_AGAIN),
        (("None", "None", "ThrottlingError"), 503, BUSY),
    ],
)
def test_rn008_persistent_cancellation_on_the_sensei_item(
    belt_exam: Exam,
    monkeypatch: pytest.MonkeyPatch,
    codes: tuple[str, ...],
    status: int,
    message: str,
) -> None:
    calls = {"n": 0}

    def always(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        raise _cancelled(*codes)

    monkeypatch.setattr(exam_repo, "_transact_decision", always)
    monkeypatch.setattr(exam_repo.time, "sleep", lambda seconds: None)
    before = _student_item(belt_exam.student_id)

    _assert_rejected(_approve(belt_exam), status, message)
    assert calls["n"] > 1
    _assert_untouched(belt_exam, before)


def test_rn008_rn010_replaced_sensei_does_not_learn_the_exam_was_decided(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The handler read the settings and the exam before both changed.
    stale_settings = settings_repo.get_settings()
    stale_exam = exam_repo.get_exam(belt_exam.event_id, belt_exam.student_id)
    _set_sensei(OTHER_EXAMINER.sub)
    table(EXAMS_TABLE_ENV).update_item(
        Key={"event_id": belt_exam.event_id, "student_id": belt_exam.student_id},
        UpdateExpression="SET #status = :approved",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":approved": "APPROVED"},
    )
    monkeypatch.setattr(settings_repo, "get_settings", lambda: stale_settings)
    monkeypatch.setattr(exam_repo, "get_exam", lambda event_id, student_id: stale_exam)

    _assert_rejected(_approve(belt_exam), 403, ONLY_SENSEI)


class _ExamsGetItemThrottled:
    """The real table, except that ``get_item`` keeps being throttled."""

    def __init__(self, real: Any) -> None:
        self._real = real

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def get_item(self, **kwargs: Any) -> None:
        raise ClientError(
            {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
            "GetItem",
        )


@pytest.mark.parametrize("route", ["sheet", "decision"])
def test_rn008_throttled_exam_read_is_503(
    belt_exam: Exam, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    real_table = exam_repo.table
    monkeypatch.setattr(
        exam_repo,
        "table",
        lambda env: (
            _ExamsGetItemThrottled(real_table(env)) if env == EXAMS_TABLE_ENV else real_table(env)
        ),
    )
    before = _student_item(belt_exam.student_id)
    path = {"id": belt_exam.event_id, "student_id": belt_exam.student_id}

    if route == "sheet":
        response = handlers.get_exam_sheet(api_event(SENSEI, path=path), None)
    else:
        response = _approve(belt_exam)

    _assert_rejected(response, 503, MSG_SERVICE_BUSY)
    monkeypatch.undo()
    _assert_untouched(belt_exam, before)
