"""Students: registration, ownership and graduation lock (RN013, RN014, RN018)."""

import uuid
from dataclasses import dataclass, replace
from datetime import date
from typing import Any

from domain import validation
from domain.belts import Belt
from domain.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from domain.users import User

MAX_STRIPES = 4

MSG_GRADUATION_LOCKED = "Somente examinadores alteram a graduação após o primeiro exame"
MSG_GRADUATION_IN_PROGRESS = (
    "Não é possível alterar a graduação com exame em andamento. Decida o exame primeiro."
)
MSG_STUDENT_HAS_EXAMS = "Aluno possui exames registrados"
MSG_STUDENT_NOT_FOUND = "Aluno não encontrado"


@dataclass(frozen=True)
class Student:
    """A student, owned by the guardian account that registered it."""

    id: str
    owner_id: str
    full_name: str
    birth_date: date
    current_belt_id: str
    current_belt_since: date
    stripes: int
    federation_id: str | None
    active: bool
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return {
            "id": self.id,
            "owner_id": self.owner_id,
            "full_name": self.full_name,
            "birth_date": self.birth_date.isoformat(),
            "current_belt_id": self.current_belt_id,
            "current_belt_since": self.current_belt_since.isoformat(),
            "stripes": self.stripes,
            "federation_id": self.federation_id,
            "active": self.active,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class _StudentFields:
    full_name: str
    birth_date: date
    current_belt_id: str
    current_belt_since: date
    stripes: int
    federation_id: str | None
    active: bool


def _parse_fields(
    payload: dict[str, Any], belts_by_id: dict[str, Belt], today: date
) -> _StudentFields:
    """Validate the editable fields of a student.

    Raises:
        ValidationError: If a field is invalid or the dates break RN014.
    """
    fields = _StudentFields(
        full_name=validation.required_str(payload, "full_name", "Nome", 120),
        birth_date=validation.date_field(payload, "birth_date", "Nascimento"),
        current_belt_id=validation.required_str(payload, "current_belt_id", "Faixa atual", 64),
        current_belt_since=validation.date_field(payload, "current_belt_since", "Na faixa desde"),
        stripes=validation.int_field(
            payload, "stripes", "Graus", minimum=0, maximum=MAX_STRIPES, default=0
        ),
        federation_id=validation.optional_str(
            payload, "federation_id", "Registro na federação", 30
        ),
        active=validation.bool_field(payload, "active", "Ativo", default=True),
    )
    if fields.current_belt_id not in belts_by_id:
        raise ValidationError("Faixa atual: faixa não encontrada")
    validate_dates(fields.birth_date, fields.current_belt_since, today)
    return fields


def validate_dates(birth_date: date, belt_since: date, today: date) -> None:
    """Apply RN014: no future dates and belt date not before birth.

    Raises:
        ValidationError: If the dates are inconsistent.
    """
    if birth_date > today or belt_since > today or belt_since < birth_date:
        raise ValidationError("Datas inválidas: verifique nascimento e data da faixa atual")


def create_student(
    payload: dict[str, Any],
    owner: User,
    belts_by_id: dict[str, Belt],
    today: date,
    now_iso: str,
) -> Student:
    """Build a new student owned by the caller.

    The owner always comes from the token, never from the payload.

    Args:
        payload: Request body.
        owner: Authenticated user registering the student.
        belts_by_id: Every belt indexed by id.
        today: Current calendar date.
        now_iso: Current UTC timestamp.

    Returns:
        The new student.

    Raises:
        ValidationError: If a field is invalid.
    """
    fields = _parse_fields(payload, belts_by_id, today)
    return Student(
        id=str(uuid.uuid4()),
        owner_id=owner.sub,
        created_at=now_iso,
        updated_at=now_iso,
        **vars(fields),
    )


def update_student(
    existing: Student,
    payload: dict[str, Any],
    user: User,
    belts_by_id: dict[str, Belt],
    has_exams: bool,
    today: date,
    now_iso: str,
    *,
    exam_in_progress: bool = False,
) -> Student:
    """Apply an edit to a student, enforcing the graduation locks (RN005, RN013).

    After the first exam only examiners (or the exam itself) change the belt,
    the belt date and the stripes (RN013). While an exam is in progress nobody
    changes them, examiners included: the decision is what writes the new
    graduation (RN005, decision of 2026-11-02). Both locks compare with the
    current values, so resending unchanged values does not block editing the
    other fields. For a guardian the 403 wins over the 409: the permission
    holds even after the decision, so "decide the exam first" would mislead.

    Args:
        existing: Student as stored.
        payload: Full set of editable fields.
        user: Authenticated user (already checked for access).
        belts_by_id: Every belt indexed by id.
        has_exams: Whether the student has at least one exam.
        today: Current calendar date.
        now_iso: Current UTC timestamp.
        exam_in_progress: Whether the student has an exam in progress.

    Returns:
        The updated student.

    Raises:
        ValidationError: If a field is invalid.
        ForbiddenError: If a guardian changes the graduation after the first exam.
        ConflictError: If the graduation changes while an exam is in progress.
    """
    fields = _parse_fields(payload, belts_by_id, today)
    updated = replace(existing, updated_at=now_iso, **vars(fields))
    # An exam in progress is an exam: the RN013 lock also holds when the two
    # reads disagree (an attendance confirmed between them).
    if (has_exams or exam_in_progress) and needs_graduation_lock(existing, updated, user):
        raise ForbiddenError(MSG_GRADUATION_LOCKED)
    if exam_in_progress and graduation_changed(existing, updated):
        raise ConflictError(MSG_GRADUATION_IN_PROGRESS)
    return updated


def graduation_changed(existing: Student, updated: Student) -> bool:
    """Whether the belt, the belt date or the stripes differ (RN013)."""
    return (
        updated.current_belt_id != existing.current_belt_id
        or updated.current_belt_since != existing.current_belt_since
        or updated.stripes != existing.stripes
    )


def needs_graduation_lock(existing: Student, updated: Student, user: User) -> bool:
    """Whether the edit is only allowed while the student has no exam (RN013).

    True when a non-examiner changes the graduation; the repository then makes
    the write conditional on the student still having no exam.
    """
    return not user.is_examiner and graduation_changed(existing, updated)


def ensure_can_access(student: Student | None, user: User) -> Student:
    """Return the student if the user may read and edit it (RN013).

    Guardians only see their own students; examiners see all. A student that
    belongs to someone else is reported as not found, so its existence leaks
    nothing.

    Raises:
        NotFoundError: If the student is missing or not visible to the user.
    """
    if student is None or (not user.is_examiner and student.owner_id != user.sub):
        raise NotFoundError(MSG_STUDENT_NOT_FOUND)
    return student


def ensure_can_delete(has_exams: bool) -> None:
    """Apply RN018: a student with exams is never deleted (it may be deactivated).

    Raises:
        ConflictError: If the student has exams.
    """
    if has_exams:
        raise ConflictError(MSG_STUDENT_HAS_EXAMS)
