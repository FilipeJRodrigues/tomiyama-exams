"""Exam notices shown to the guardian on the student's profile (RN019).

For an **active** student, each **open** event carries the notice "Exame de
faixas dia dd/mm/aaaa" while the student is eligible for the target belt
(RN001–RN004, computed on the event's date, never on today) and has no exam in
progress in another event. The notice only informs: nothing here writes. It
goes away when the event is closed or when the student's exam in that event is
decided.

Pure assembly of what ``GET /students/{id}/exam-notices`` answers: the least
the notice needs (the event's id, name and date, the target belt and the exam
kind). No scores, no status, no other student and no examiner.
"""

from collections.abc import Iterable
from typing import Any

from domain.belts import Belt
from domain.eligibility import evaluate
from domain.errors import ForbiddenError
from domain.events import ExamEvent
from domain.exams import Exam, ExamStatus
from domain.students import Student
from domain.users import User

MSG_GUARDIANS_ONLY = "Esta área é dos responsáveis"


def ensure_guardian(user: User) -> None:
    """Allow only callers who are not examiners (RN019).

    The notice is the guardian's view; examiners follow the events on the
    exam-day screens. Which students the guardian may see is RN013
    (``domain.students.ensure_can_access``).

    Raises:
        ForbiddenError: If the user is an examiner.
    """
    if user.is_examiner:
        raise ForbiddenError(MSG_GUARDIANS_ONLY)


def can_have_notices(student: Student) -> bool:
    """Whether the student may have any notice: only active students do (RN019)."""
    return student.active


def open_events(events: Iterable[ExamEvent]) -> list[ExamEvent]:
    """Return the open events from the earliest to the latest date.

    Ties on ``exam_date`` are broken by id, so the order is stable.
    """
    return sorted(
        (event for event in events if event.is_open), key=lambda ev: (ev.exam_date, ev.id)
    )


def _notice(
    event: ExamEvent, target_belt_id: str, target_belt_name: str | None, kind: str
) -> dict[str, Any]:
    return {
        "event_id": event.id,
        "event_name": event.name,
        "event_date": event.exam_date.isoformat(),
        "target_belt_id": target_belt_id,
        "target_belt_name": target_belt_name,
        "kind": kind,
    }


def exam_notices(
    student: Student,
    belts: Iterable[Belt],
    events: Iterable[ExamEvent],
    exams: Iterable[Exam],
) -> list[dict[str, Any]]:
    """Return the student's exam notices, one per open event where it holds (RN019).

    For each open event, in ``open_events`` order:

    - the student's exam there is decided (approved or failed): no notice;
    - the student has an exam in progress in another event, open or closed
      (RN005 allows one at a time): no notice;
    - the student's exam there is in progress: the notice stays until the
      decision, with the target belt and the kind stored in the exam at the
      attendance (the graduation is locked meanwhile, RN005);
    - no exam there: the notice holds if the student is eligible on the
      event's date (RN001–RN004), with the target belt and the kind computed
      on that date.

    Args:
        student: The student of the profile.
        belts: Every belt.
        events: The events to consider (closed ones are ignored).
        exams: Every exam of the student.

    Returns:
        The notices, earliest event first; empty for an inactive student.
    """
    if not can_have_notices(student):
        return []
    belts = list(belts)
    belt_names = {belt.id: belt.name for belt in belts}
    exams_by_event = {exam.event_id: exam for exam in exams if exam.student_id == student.id}
    in_progress = {
        event_id
        for event_id, exam in exams_by_event.items()
        if exam.status == ExamStatus.IN_PROGRESS
    }

    notices: list[dict[str, Any]] = []
    for event in open_events(events):
        if in_progress - {event.id}:
            continue
        exam = exams_by_event.get(event.id)
        if exam is not None:
            if exam.status == ExamStatus.IN_PROGRESS:
                notices.append(
                    _notice(
                        event,
                        exam.target_belt_id,
                        belt_names.get(exam.target_belt_id),
                        exam.kind.value,
                    )
                )
            continue
        result = evaluate(student, belts, event.exam_date)
        if result.eligible and result.target_belt is not None and result.kind is not None:
            notices.append(
                _notice(event, result.target_belt.id, result.target_belt.name, result.kind.value)
            )
    return notices
