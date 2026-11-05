"""A student's exam history (RN018): every exam is kept and listed, newest first.

Pure assembly of what ``GET /students/{id}/exams`` shows: each exam with its
event's name and date and the names of its belts. The scores are left out
(the answers are not read). The target belt, the kind and the source
graduation are the ones stored in the exam at the attendance, so later belt
changes of the student never alter an old exam.
"""

from collections.abc import Iterable, Mapping
from datetime import date
from typing import Any

from domain.belts import Belt
from domain.events import ExamEvent
from domain.exams import Exam


def _belt_name(belts_by_id: Mapping[str, Belt], belt_id: str) -> str | None:
    belt = belts_by_id.get(belt_id)
    return belt.name if belt else None


def history_entry(
    exam: Exam, event: ExamEvent | None, belts_by_id: Mapping[str, Belt]
) -> dict[str, Any]:
    """Return one exam as the history shows it.

    Args:
        exam: The stored exam.
        event: The exam's event, or None if it no longer exists.
        belts_by_id: Every belt, by id.

    Returns:
        The exam's event, belts, kind, status and decision. Names (and the
        event's date) are None when the event or the belt no longer exists;
        ``source`` (the student's graduation at the attendance) is None for
        exams confirmed before it was stored.
    """
    source = None
    if exam.source is not None:
        source = {
            "belt_id": exam.source.belt_id,
            "belt_name": _belt_name(belts_by_id, exam.source.belt_id),
            "belt_since": exam.source.belt_since.isoformat(),
            "stripes": exam.source.stripes,
        }
    return {
        "event_id": exam.event_id,
        "event_name": event.name if event else None,
        "exam_date": event.exam_date.isoformat() if event else None,
        "target_belt_id": exam.target_belt_id,
        "target_belt_name": _belt_name(belts_by_id, exam.target_belt_id),
        "kind": exam.kind.value,
        "status": exam.status.value,
        "decided_by_id": exam.decided_by_id,
        "decided_at": exam.decided_at,
        "notes": exam.notes,
        "created_at": exam.created_at,
        "source": source,
    }


def student_history(
    exams: Iterable[Exam],
    events_by_id: Mapping[str, ExamEvent],
    belts_by_id: Mapping[str, Belt],
) -> list[dict[str, Any]]:
    """Return the student's exams from the most recent to the oldest.

    Ordered by the event's ``exam_date``; on the same date, the newest
    attendance (``created_at``) first; then by ``event_id``, so the order is
    stable. Exams whose event no longer exists have no date and go last,
    newest attendance first.

    Args:
        exams: Every exam of the student.
        events_by_id: The exams' events, by id (missing ones are left out).
        belts_by_id: Every belt, by id.
    """

    def newest_first(exam: Exam) -> tuple[bool, date, str, str]:
        event = events_by_id.get(exam.event_id)
        exam_date = event.exam_date if event else date.min
        return (event is not None, exam_date, exam.created_at, exam.event_id)

    ordered = sorted(exams, key=newest_first, reverse=True)
    return [history_entry(exam, events_by_id.get(exam.event_id), belts_by_id) for exam in ordered]
