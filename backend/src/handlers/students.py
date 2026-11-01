"""Student routes.

Guardians see and edit only their own students; examiners see all (RN013).

- ``GET /students``: list (examiners: all; guardians: own). Filters ``active``,
  ``belt_id`` and ``reference_date`` (date for the eligibility; default today).
- ``POST /students``: register a student owned by the caller.
- ``GET /students/{id}``: detail with eligibility.
- ``PUT /students/{id}``: edit (graduation lock after the first exam).
- ``DELETE /students/{id}``: delete a student without exams (RN018).
"""

import logging
from datetime import date
from typing import Any

from domain import dates, eligibility
from domain import students as student_rules
from domain.belts import Belt
from domain.errors import ValidationError
from domain.students import Student
from domain.validation import parse_date
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    no_content,
    path_param,
    query_param,
)
from repository import belts as belt_repo
from repository import exams as exam_repo
from repository import students as student_repo

logger = logging.getLogger(__name__)


def _student_view(student: Student, belts: list[Belt], reference: date) -> dict[str, Any]:
    """Return the student with the computed fields shown on the screens."""
    current = next((belt for belt in belts if belt.id == student.current_belt_id), None)
    return {
        **student.to_dict(),
        "current_belt_name": current.name if current else None,
        "age": dates.full_years(student.birth_date, reference),
        "eligibility": eligibility.evaluate(student, belts, reference).to_dict(),
    }


def _reference_date(event: Event) -> date:
    raw = query_param(event, "reference_date")
    return parse_date(raw, "Data de referência") if raw else dates.today()


def _active_filter(event: Event) -> bool | None:
    raw = query_param(event, "active")
    if raw is None:
        return None
    if raw not in ("true", "false"):
        raise ValidationError("Filtro ativo: use true ou false")
    return raw == "true"


@api_handler
def list_students(event: Event, context: Any) -> Response:
    """List the students visible to the caller, sorted by name."""
    user = current_user(event)
    reference = _reference_date(event)
    active = _active_filter(event)
    belt_id = query_param(event, "belt_id")

    students = student_repo.list_all() if user.is_examiner else student_repo.list_by_owner(user.sub)
    if active is not None:
        students = [student for student in students if student.active == active]
    if belt_id:
        students = [student for student in students if student.current_belt_id == belt_id]
    students.sort(key=lambda student: student.full_name.casefold())

    belts = belt_repo.list_belts()
    return json_response(200, [_student_view(student, belts, reference) for student in students])


@api_handler
def create_student(event: Event, context: Any) -> Response:
    """Register a student; the owner is always the caller from the token."""
    user = current_user(event)
    belts = belt_repo.list_belts()
    student = student_rules.create_student(
        json_body(event),
        owner=user,
        belts_by_id={belt.id: belt for belt in belts},
        today=dates.today(),
        now_iso=dates.utc_now_iso(),
    )
    student_repo.create_student(student)
    logger.info("Student %s created by %s", student.id, user.sub)
    return json_response(201, _student_view(student, belts, dates.today()))


@api_handler
def get_student(event: Event, context: Any) -> Response:
    """Return a student visible to the caller."""
    user = current_user(event)
    student = student_rules.ensure_can_access(
        student_repo.get_student(path_param(event, "id")), user
    )
    return json_response(
        200, _student_view(student, belt_repo.list_belts(), _reference_date(event))
    )


@api_handler
def update_student(event: Event, context: Any) -> Response:
    """Edit a student visible to the caller."""
    user = current_user(event)
    existing = student_rules.ensure_can_access(
        student_repo.get_student(path_param(event, "id")), user
    )
    payload = json_body(event)
    belts = belt_repo.list_belts()
    updated = student_rules.update_student(
        existing,
        payload,
        user,
        belts_by_id={belt.id: belt for belt in belts},
        has_exams=exam_repo.student_has_exams(existing.id),
        today=dates.today(),
        now_iso=dates.utc_now_iso(),
    )
    student_repo.save_student(updated)
    logger.info("Student %s updated by %s", updated.id, user.sub)
    return json_response(200, _student_view(updated, belts, dates.today()))


@api_handler
def delete_student(event: Event, context: Any) -> Response:
    """Delete a student without exams; exams are never deleted in cascade."""
    user = current_user(event)
    student = student_rules.ensure_can_access(
        student_repo.get_student(path_param(event, "id")), user
    )
    student_rules.ensure_can_delete(exam_repo.student_has_exams(student.id))
    student_repo.delete_student(student.id)
    logger.info("Student %s deleted by %s", student.id, user.sub)
    return no_content()
