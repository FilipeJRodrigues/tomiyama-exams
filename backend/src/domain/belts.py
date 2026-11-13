"""Belts (faixas): seed data, ordering and edit rules (RN001, RN002, RN003, RN015)."""

import uuid
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from enum import StrEnum
from typing import Any

from domain import validation
from domain.errors import ConflictError, ForbiddenError

# Fixed namespace so seeded belts get the same UUID on every deploy (idempotent seed).
_SEED_NAMESPACE = uuid.UUID("6f1f6d0c-4b0e-4f5e-9a51-1c2a9b7e3d10")

# Business ceilings for the editable numbers (RN015); the seed uses 0-11, 0-14 and 0-12.
MAX_SORT_ORDER = 99
MAX_MIN_AGE_YEARS = 99
MAX_MIN_MONTHS_PREVIOUS = 240

# Edit permissions (decision of 2026-11-12, card #142): any examiner changes the
# eligibility numbers (RN001 minimum age, RN002 months in the previous belt);
# only the admin master changes the identity and look of the belt.
EXAMINER_EDITABLE_FIELDS = ("min_age_years", "min_months_previous")
MASTER_ONLY_FIELDS = ("name", "kyu", "sort_order", "level", "color_primary", "color_secondary")
MSG_BELT_NOT_FOUND = "Faixa não encontrada"
MSG_MASTER_ONLY_BELT_FIELDS = (
    "Somente o administrador master altera nome, kyū, ordem, nível e cores da faixa"
)


class BeltLevel(StrEnum):
    """Belt level; stripe exams only exist for intermediate belts (RN004)."""

    BASIC = "BASIC"
    INTERMEDIATE = "INTERMEDIATE"


@dataclass(frozen=True)
class Belt:
    """A belt in the graduation sequence."""

    id: str
    name: str
    kyu: int | None
    sort_order: int
    level: BeltLevel
    min_age_years: int
    min_months_previous: int
    color_primary: str
    color_secondary: str | None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        data = asdict(self)
        data["level"] = self.level.value
        return data


def seed_belt_id(name: str) -> str:
    """Return the deterministic id of a seeded belt."""
    return str(uuid.uuid5(_SEED_NAMESPACE, name))


def _seed(
    sort_order: int,
    name: str,
    kyu: int | None,
    level: BeltLevel,
    min_age: int,
    min_months: int,
    primary: str,
    secondary: str | None = None,
) -> Belt:
    return Belt(
        id=seed_belt_id(name),
        name=name,
        kyu=kyu,
        sort_order=sort_order,
        level=level,
        min_age_years=min_age,
        min_months_previous=min_months,
        color_primary=primary,
        color_secondary=secondary,
    )


_B = BeltLevel.BASIC
_I = BeltLevel.INTERMEDIATE

# Source: CBJ regulation of 09/02/2011, art. 2 (requisitos § 4). Editable on screen.
SEED_BELTS: tuple[Belt, ...] = (
    _seed(0, "Branca", None, _B, 0, 0, "#FFFFFF"),
    _seed(1, "Branca/Cinza", 11, _B, 4, 3, "#FFFFFF", "#9E9E9E"),
    _seed(2, "Cinza", 10, _B, 5, 3, "#9E9E9E"),
    _seed(3, "Cinza/Azul", 9, _B, 6, 6, "#9E9E9E", "#1E63C6"),
    _seed(4, "Azul", 8, _B, 7, 6, "#1E63C6"),
    _seed(5, "Azul/Amarela", 7, _B, 8, 6, "#1E63C6", "#F2C200"),
    _seed(6, "Amarela", 6, _B, 9, 6, "#F2C200"),
    _seed(7, "Amarela/Laranja", 5, _B, 10, 12, "#F2C200", "#F07C00"),
    _seed(8, "Laranja", 4, _I, 11, 12, "#F07C00"),
    _seed(9, "Verde", 3, _I, 12, 12, "#2E8B3A"),
    _seed(10, "Roxa", 2, _I, 13, 12, "#6B2FA0"),
    _seed(11, "Marrom", 1, _I, 14, 12, "#6D4423"),
)


def sort_belts(belts: Iterable[Belt]) -> list[Belt]:
    """Return belts in graduation order."""
    return sorted(belts, key=lambda belt: belt.sort_order)


def next_belt(current: Belt, belts: Iterable[Belt]) -> Belt | None:
    """Return the belt immediately after ``current`` (RN003), or None for the last one."""
    following = [belt for belt in belts if belt.sort_order > current.sort_order]
    return min(following, key=lambda belt: belt.sort_order, default=None)


def previous_belt(current: Belt, belts: Iterable[Belt]) -> Belt | None:
    """Return the belt immediately before ``current``, or None for the first one."""
    preceding = [belt for belt in belts if belt.sort_order < current.sort_order]
    return max(preceding, key=lambda belt: belt.sort_order, default=None)


def parse_belt(belt_id: str, payload: dict[str, Any]) -> Belt:
    """Validate every editable field of a belt (RN015) and return the belt.

    Every field keeps its rule whoever edits: ``name``, ``sort_order``,
    ``level``, ``min_age_years``, ``min_months_previous`` and
    ``color_primary`` are required; ``kyu`` and ``color_secondary`` are
    optional (missing or null means none).

    Raises:
        ValidationError: If a field is missing or invalid.
    """
    return Belt(
        id=belt_id,
        name=validation.required_str(payload, "name", "Nome", 40),
        kyu=validation.int_field(payload, "kyu", "Kyū", minimum=1, maximum=11, required=False),
        sort_order=validation.int_field(
            payload, "sort_order", "Ordem", minimum=0, maximum=MAX_SORT_ORDER
        ),
        level=validation.enum_field(payload, "level", "Nível", BeltLevel),
        min_age_years=validation.int_field(
            payload, "min_age_years", "Idade mínima", minimum=0, maximum=MAX_MIN_AGE_YEARS
        ),
        min_months_previous=validation.int_field(
            payload, "min_months_previous", "Carência", minimum=0, maximum=MAX_MIN_MONTHS_PREVIOUS
        ),
        color_primary=validation.hex_color(payload, "color_primary", "Cor", required=True),
        color_secondary=validation.hex_color(
            payload, "color_secondary", "Cor das pontas", required=False
        ),
    )


def apply_belt_update(existing: Belt, payload: dict[str, Any], all_belts: Iterable[Belt]) -> Belt:
    """Validate an edit of a belt by the admin master (RN015) and return the updated belt.

    The master changes every field. Belts are never created or deleted
    through the API, only edited.

    Args:
        existing: Belt being edited.
        payload: Full set of editable fields.
        all_belts: Every belt, used to enforce unique name and order.

    Returns:
        The updated belt.

    Raises:
        ValidationError: If a field is invalid.
        ConflictError: If the name or order is already used by another belt.
    """
    updated = parse_belt(existing.id, payload)
    for other in all_belts:
        if other.id == existing.id:
            continue
        if other.name.casefold() == updated.name.casefold():
            raise ConflictError("Já existe uma faixa com este nome")
        if other.sort_order == updated.sort_order:
            raise ConflictError("Já existe uma faixa com esta ordem")
    return updated


def apply_examiner_belt_update(existing: Belt, payload: dict[str, Any]) -> Belt:
    """Validate an edit of a belt by an examiner who is not the master (RN001, RN002, RN015).

    The body is the same as the master's and is validated the same way, so a
    missing or invalid field is still a 400. The examiner changes only the
    minimum age (RN001) and the months in the previous belt (RN002); the other
    fields must be sent with the stored values (the form always sends every
    field), compared after validation (trimmed name, colours in upper case).
    Name and order stay the stored ones, so they need no uniqueness check.

    Args:
        existing: Belt as stored.
        payload: Full set of editable fields.

    Returns:
        ``existing`` with the two new numbers; the caller writes only those.

    Raises:
        ValidationError: If a field is missing or invalid.
        ForbiddenError: If a master-only field differs from the stored value.
    """
    updated = parse_belt(existing.id, payload)
    if any(getattr(updated, field) != getattr(existing, field) for field in MASTER_ONLY_FIELDS):
        raise ForbiddenError(MSG_MASTER_ONLY_BELT_FIELDS)
    return updated
