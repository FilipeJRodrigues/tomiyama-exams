"""The sensei's decision on an exam (RN008, RN008a, RN009, RN010).

Only the user configured as sensei (``settings.sensei_user_id``) approves or
fails an exam, whatever the score (RN008); the admin master only decides if he
is the sensei. A closed event still accepts decisions on its exams in progress
(RN008a). Once decided, neither the decision nor the answers change (RN010).

Approving a belt exam moves the student to the target belt, with the event
date as the belt date and no stripes; approving a stripe exam adds one stripe
and keeps the belt; failing changes nothing (RN009).

The decision is refused if the student's graduation changed since the
attendance (decision of 2026-11-02): the exam's target belt and kind were
computed from that graduation, so applying RN009 to another one would be wrong.
An inactive student may still be decided.
"""

from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import Any

from domain import validation
from domain.belts import Belt, next_belt
from domain.eligibility import ExamKind, exam_kind
from domain.errors import ConflictError, ForbiddenError, ValidationError
from domain.events import ExamEvent
from domain.exams import MSG_EXAM_DECIDED, Exam, ExamStatus, Graduation
from domain.students import Student
from domain.users import User

MSG_ONLY_SENSEI = "Somente o sensei pode decidir o exame"
MSG_NO_SENSEI = "Defina o sensei nas configurações da academia"
MSG_GRADUATION_CHANGED = "A graduação do aluno mudou desde a presença. Confira antes de decidir."
MSG_INVALID_RESULT = (
    "Resultado inválido: envie result como APPROVED (aprovado) ou FAILED (reprovado)"
)
MSG_DECISION_TRY_AGAIN = "Outra alteração deste exame está em andamento. Tente de novo."

MAX_NOTES = 500
_RESULTS = frozenset({ExamStatus.APPROVED, ExamStatus.FAILED})


@dataclass(frozen=True)
class Decision:
    """A parsed decision request: the result and an optional note."""

    result: ExamStatus
    notes: str | None


def parse_decision(payload: dict[str, Any]) -> Decision:
    """Return the decision in a ``POST .../decision`` body.

    ``notes`` is optional: missing, null or blank becomes None; text is trimmed.

    Raises:
        ValidationError: If ``result`` is not ``APPROVED`` or ``FAILED`` or
            ``notes`` is not text or too long.
    """
    raw = payload.get("result")
    if not isinstance(raw, str) or raw not in _RESULTS:
        raise ValidationError(MSG_INVALID_RESULT)
    notes = validation.optional_str(payload, "notes", "Observação", MAX_NOTES)
    return Decision(result=ExamStatus(raw), notes=notes)


def ensure_is_sensei(user: User, sensei_user_id: str | None) -> None:
    """Allow only the configured sensei, who must still be an examiner (RN008).

    Group membership comes from the token (``cognito:groups``): a sensei who
    left the group ``admin`` is refused once the token is renewed.

    Raises:
        ConflictError: If no sensei is configured.
        ForbiddenError: If the user is not the sensei (the master included) or
            is no longer an examiner.
    """
    if sensei_user_id is None:
        raise ConflictError(MSG_NO_SENSEI)
    if user.sub != sensei_user_id or not user.is_examiner:
        raise ForbiddenError(MSG_ONLY_SENSEI)


def ensure_in_progress(exam: Exam) -> None:
    """Apply RN010: a decided exam is final.

    Raises:
        ConflictError: If the exam is already decided.
    """
    if exam.status != ExamStatus.IN_PROGRESS:
        raise ConflictError(MSG_EXAM_DECIDED)


def expected_graduation(exam: Exam, student: Student, belts: Iterable[Belt]) -> Graduation:
    """Return the graduation the student must still have for the decision.

    Exams store the graduation of the attendance (``exam.source``). Older
    exams, confirmed before it was stored, fall back to what can be checked:
    the target belt must be the one right after the student's current belt and
    the exam kind must match the current stripes (RN003, RN004). In both cases
    the write is then conditioned on the returned values, so a change made
    after this read is caught too.

    Raises:
        ConflictError: If the graduation changed since the attendance.
    """
    current = Graduation.of(student)
    if exam.source is not None:
        if current != exam.source:
            raise ConflictError(MSG_GRADUATION_CHANGED)
        return current
    belts = list(belts)
    current_belt = next((belt for belt in belts if belt.id == student.current_belt_id), None)
    target = next_belt(current_belt, belts) if current_belt else None
    if (
        current_belt is None
        or target is None
        or target.id != exam.target_belt_id
        or exam_kind(current_belt, student.stripes) != exam.kind
    ):
        raise ConflictError(MSG_GRADUATION_CHANGED)
    return current


def decide(exam: Exam, decision: Decision, decided_by: str, now_iso: str) -> Exam:
    """Return the exam with the decision recorded: who, when and the note (RN008).

    Raises:
        ConflictError: If the exam is already decided (RN010).
    """
    ensure_in_progress(exam)
    return replace(
        exam,
        status=decision.result,
        decided_by_id=decided_by,
        decided_at=now_iso,
        notes=decision.notes,
    )


def approved_student(exam: Exam, student: Student, event: ExamEvent, now_iso: str) -> Student:
    """Return the student after an approved exam (RN009).

    Belt exam: target belt, belt date = event date, no stripes. Stripe exam:
    one more stripe, same belt and belt date.
    """
    if exam.kind == ExamKind.BELT:
        return replace(
            student,
            current_belt_id=exam.target_belt_id,
            current_belt_since=event.exam_date,
            stripes=0,
            updated_at=now_iso,
        )
    return replace(student, stripes=student.stripes + 1, updated_at=now_iso)
