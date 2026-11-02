"""Exam routes inside an event, examiners only (RN005).

- ``POST /events/{id}/exams``: confirm a student's attendance (body
  ``{"student_id": ...}``); creates the exam in progress with target belt and
  kind computed on the event date.
- ``GET /events/{id}/exams``: list the event's exams, with the student's name,
  sorted by name.
"""

import logging
from typing import Any

from domain import dates, validation
from domain import exams as exam_rules
from domain.errors import ConflictError, NotFoundError
from domain.events import ExamEvent
from domain.exams import MSG_ALREADY_CONFIRMED, MSG_EVENT_NOT_FOUND, MSG_STUDENT_NOT_FOUND, Exam
from domain.names import name_sort_key
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
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
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
