"""Exam routes inside an event, examiners only (RN005–RN007).

- ``POST /events/{id}/exams``: confirm a student's attendance (body
  ``{"student_id": ...}``); creates the exam in progress with target belt and
  kind computed on the event date.
- ``GET /events/{id}/exams``: list the event's exams, with the student's name,
  sorted by name.
- ``GET /events/{id}/exams/{student_id}``: the exam sheet (§ 6.4): exam, event,
  student, target belt, the belt's items in sheet order with their answers,
  and the score per kind (RN007, always recomputed).
- ``PUT /events/{id}/exams/{student_id}/answers/{requirement_id}``: mark an
  item (body ``{"correct": true|false}``), replacing any previous mark (RN006).
- ``DELETE`` on the same path: unmark the item (back to "not marked").
- ``POST /events/{id}/exams/{student_id}/decision``: the sensei approves or
  fails the exam (body ``{"result": "APPROVED"|"FAILED", "notes": ...}``),
  updating the student's graduation on approval (RN008–RN010).
"""

import logging
from typing import Any

from domain import answers as answer_rules
from domain import dates, scoring, validation
from domain import decisions as decision_rules
from domain import exams as exam_rules
from domain.answers import ExamAnswer
from domain.errors import ConflictError, NotFoundError
from domain.events import ExamEvent
from domain.exams import (
    MSG_ALREADY_CONFIRMED,
    MSG_EVENT_NOT_FOUND,
    MSG_EXAM_NOT_FOUND,
    MSG_STUDENT_NOT_FOUND,
    Exam,
    ExamStatus,
)
from domain.names import name_sort_key
from domain.requirements import MSG_REQUIREMENT_NOT_FOUND, Requirement
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    path_param,
    require_examiner,
)
from repository import answers as answer_repo
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import settings as settings_repo
from repository import students as student_repo

logger = logging.getLogger(__name__)


def _event_or_404(event_id: str) -> ExamEvent:
    exam_event = event_repo.get_event(event_id)
    if exam_event is None:
        raise NotFoundError(MSG_EVENT_NOT_FOUND)
    return exam_event


def _exam_view(exam: Exam, student_name: str | None) -> dict[str, Any]:
    return {**exam.to_dict(), "student_name": student_name}


@api_handler
def confirm_attendance(event: Event, context: Any) -> Response:
    """Confirm a student's attendance at an open event (RN005)."""
    user = current_user(event)
    require_examiner(user)
    exam_event = _event_or_404(path_param(event, "id"))
    student_id = validation.required_str(json_body(event), "student_id", "Aluno", 64)
    student = student_repo.get_student(student_id)
    if student is None:
        raise NotFoundError(MSG_STUDENT_NOT_FOUND)
    # Early answer for the common repeat; the conditional write below still
    # guarantees uniqueness under concurrency.
    if exam_repo.get_exam(exam_event.id, student.id) is not None:
        raise ConflictError(MSG_ALREADY_CONFIRMED)
    exam = exam_rules.confirm_attendance(
        exam_event,
        student,
        belt_repo.list_belts(),
        confirmed_by=user.sub,
        now_iso=dates.utc_now_iso(),
    )
    exam_repo.create_exam(exam, student)
    logger.info(
        "Attendance of student %s at event %s confirmed by %s (exam %s, %s)",
        student.id,
        exam_event.id,
        user.sub,
        exam.id,
        exam.kind,
    )
    return json_response(201, _exam_view(exam, student.full_name))


@api_handler
def list_event_exams(event: Event, context: Any) -> Response:
    """List the exams of an event, sorted by student name."""
    require_examiner(current_user(event))
    exam_event = _event_or_404(path_param(event, "id"))
    exams = exam_repo.list_by_event(exam_event.id)
    names = student_repo.get_names(exam.student_id for exam in exams)
    views = [_exam_view(exam, names.get(exam.student_id)) for exam in exams]
    views.sort(key=lambda view: name_sort_key(view["student_name"], view["student_id"]))
    return json_response(200, views)


def _exam_or_404(event_id: str, student_id: str) -> Exam:
    exam = exam_repo.get_exam(event_id, student_id)
    if exam is None:
        raise NotFoundError(MSG_EXAM_NOT_FOUND)
    return exam


def _requirement_or_404(requirement_id: str) -> Requirement:
    requirement = requirement_repo.get_requirement(requirement_id)
    if requirement is None:
        raise NotFoundError(MSG_REQUIREMENT_NOT_FOUND)
    return requirement


def _correct_by_item(answers: dict[str, ExamAnswer]) -> dict[str, bool]:
    return {requirement_id: answer.correct for requirement_id, answer in answers.items()}


@api_handler
def get_exam_sheet(event: Event, context: Any) -> Response:
    """Return everything the exam screen shows (§ 6.4) in one call."""
    require_examiner(current_user(event))
    exam_event = _event_or_404(path_param(event, "id"))
    exam = _exam_or_404(exam_event.id, path_param(event, "student_id"))
    student = student_repo.get_student(exam.student_id)
    target_belt = belt_repo.get_belt(exam.target_belt_id)
    requirements = requirement_repo.list_by_belt(exam.target_belt_id)
    answers = answer_repo.list_by_exam(exam.id)
    items = [
        {
            **requirement.to_dict(),
            "answer": answers[requirement.id].to_dict() if requirement.id in answers else None,
        }
        for requirement in requirements
    ]
    student_view = None
    if student is not None:
        student_view = {
            "id": student.id,
            "full_name": student.full_name,
            "birth_date": student.birth_date.isoformat(),
        }
    body = {
        "exam": _exam_view(exam, student.full_name if student else None),
        "event": exam_event.to_dict(),
        "student": student_view,
        "target_belt": target_belt.to_dict() if target_belt else None,
        "items": items,
        "summary": scoring.summary(requirements, _correct_by_item(answers)),
    }
    return json_response(200, body)


def _marking_context(event: Event) -> tuple[ExamEvent, Exam, Requirement]:
    exam_event = _event_or_404(path_param(event, "id"))
    exam = _exam_or_404(exam_event.id, path_param(event, "student_id"))
    return exam_event, exam, _requirement_or_404(path_param(event, "requirement_id"))


def _summary_after(exam: Exam, requirement_id: str, answer: ExamAnswer | None) -> dict[str, Any]:
    """Recompute the score (RN007) with this request's write applied.

    The answers query is eventually consistent; applying our own write keeps
    the summary right for the caller's optimistic update.
    """
    answers = _correct_by_item(answer_repo.list_by_exam(exam.id))
    if answer is None:
        answers.pop(requirement_id, None)
    else:
        answers[requirement_id] = answer.correct
    return scoring.summary(requirement_repo.list_by_belt(exam.target_belt_id), answers)


@api_handler
def mark_answer(event: Event, context: Any) -> Response:
    """Mark an item as correct or wrong, replacing any previous mark (RN006)."""
    user = current_user(event)
    require_examiner(user)
    exam_event, exam, requirement = _marking_context(event)
    correct = answer_rules.parse_correct(json_body(event))
    answer = answer_rules.mark(
        exam,
        exam_event,
        requirement,
        correct=correct,
        marked_by=user.sub,
        now_iso=dates.utc_now_iso(),
    )
    answer_repo.save_answer(exam, answer)
    logger.info(
        "Item %s of exam %s marked %s by %s", requirement.id, exam.id, answer.correct, user.sub
    )
    body = {"answer": answer.to_dict(), "summary": _summary_after(exam, requirement.id, answer)}
    return json_response(200, body)


@api_handler
def unmark_answer(event: Event, context: Any) -> Response:
    """Unmark an item (back to "not marked"), with the same locks as marking."""
    user = current_user(event)
    require_examiner(user)
    exam_event, exam, requirement = _marking_context(event)
    answer_rules.ensure_can_mark(exam, exam_event, requirement)
    if answer_repo.delete_answer(exam, requirement.id):
        logger.info("Item %s of exam %s unmarked by %s", requirement.id, exam.id, user.sub)
    body = {"answer": None, "summary": _summary_after(exam, requirement.id, None)}
    return json_response(200, body)


@api_handler
def decide_exam(event: Event, context: Any) -> Response:
    """Approve or fail an exam; only the sensei decides (RN008–RN010).

    The sensei is read from the settings at each request. A closed event still
    accepts the decision (RN008a). On approval the student's graduation is
    updated in the same transaction (RN009); the decision is refused if the
    graduation changed since the attendance.
    """
    user = current_user(event)
    require_examiner(user)
    exam_event = _event_or_404(path_param(event, "id"))
    exam = _exam_or_404(exam_event.id, path_param(event, "student_id"))
    settings = settings_repo.get_settings()
    decision_rules.ensure_is_sensei(user, settings.sensei_user_id if settings else None)
    decision_rules.ensure_in_progress(exam)
    decision = decision_rules.parse_decision(json_body(event))
    student = student_repo.get_student(exam.student_id)
    if student is None:
        raise NotFoundError(MSG_STUDENT_NOT_FOUND)
    # The belts are only needed for exams confirmed before the source graduation was stored.
    belts = belt_repo.list_belts() if exam.source is None else []
    expected = decision_rules.expected_graduation(exam, student, belts)
    now_iso = dates.utc_now_iso()
    decided = decision_rules.decide(exam, decision, decided_by=user.sub, now_iso=now_iso)
    approved = None
    if decided.status == ExamStatus.APPROVED:
        approved = decision_rules.approved_student(exam, student, exam_event, now_iso)
    exam_repo.decide_exam(decided, expected, approved)
    logger.info(
        "Exam %s (%s) of student %s decided %s by %s",
        exam.id,
        exam.kind,
        student.id,
        decided.status,
        user.sub,
    )
    body = {
        "exam": _exam_view(decided, student.full_name),
        "student": approved.to_dict() if approved else None,
    }
    return json_response(200, body)
