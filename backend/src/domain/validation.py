"""Field parsers for JSON payloads, raising pt-BR validation messages."""

import re
from datetime import date
from enum import StrEnum
from typing import Any

from domain.errors import ValidationError

# Used with ``fullmatch``: ``$`` with ``match`` would also accept a trailing line break.
_HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")

# DynamoDB numbers keep at most 38 significant digits; larger integers make the
# boto3 serializer raise ``decimal.Inexact``. No integer field may go past this.
MAX_STORABLE_DIGITS = 38
MAX_STORABLE_INT = 10**MAX_STORABLE_DIGITS - 1


def required_str(payload: dict[str, Any], field: str, label: str, max_len: int) -> str:
    """Return a trimmed, non-empty string field.

    Raises:
        ValidationError: If missing, not a string, empty or too long.
    """
    value = payload.get(field)
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValidationError(f"Campo obrigatório: {label}")
    if not isinstance(value, str):
        raise ValidationError(f"{label}: valor inválido")
    value = value.strip()
    if len(value) > max_len:
        raise ValidationError(f"{label}: máximo de {max_len} caracteres")
    return value


def optional_str(payload: dict[str, Any], field: str, label: str, max_len: int) -> str | None:
    """Return a trimmed string field, or None when missing or blank.

    Raises:
        ValidationError: If not a string or too long.
    """
    value = payload.get(field)
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    return required_str(payload, field, label, max_len)


def int_field(
    payload: dict[str, Any],
    field: str,
    label: str,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
    default: int | None = None,
    required: bool = True,
) -> int | None:
    """Return an integer field within optional bounds.

    Args:
        payload: Request body.
        field: Key in the payload.
        label: Field name shown to the user.
        minimum: Inclusive lower bound.
        maximum: Inclusive upper bound. Any value is also capped at
            ``MAX_STORABLE_INT`` (in absolute value), the largest integer DynamoDB stores.
        default: Value used when the field is missing.
        required: Whether a missing field without default is an error.

    Raises:
        ValidationError: If missing (when required), not an integer or out of bounds.
    """
    value = payload.get(field)
    if value is None:
        if default is not None or not required:
            return default
        raise ValidationError(f"Campo obrigatório: {label}")
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{label}: deve ser um número inteiro")
    if minimum is not None and maximum is not None and not minimum <= value <= maximum:
        raise ValidationError(f"{label}: deve estar entre {minimum} e {maximum}")
    if minimum is not None and value < minimum:
        raise ValidationError(f"{label}: deve ser maior ou igual a {minimum}")
    if maximum is not None and value > maximum:
        raise ValidationError(f"{label}: deve ser menor ou igual a {maximum}")
    if abs(value) > MAX_STORABLE_INT:
        raise ValidationError(f"{label}: deve ter no máximo {MAX_STORABLE_DIGITS} dígitos")
    return value


def bool_field(payload: dict[str, Any], field: str, label: str, default: bool) -> bool:
    """Return a boolean field, using the default when missing.

    Raises:
        ValidationError: If present but not a boolean.
    """
    value = payload.get(field)
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ValidationError(f"{label}: valor inválido")
    return value


def parse_date(value: Any, label: str) -> date:
    """Parse an ISO calendar date (``YYYY-MM-DD``).

    Raises:
        ValidationError: If the value is not a valid ISO date.
    """
    if not isinstance(value, str) or len(value) != 10:
        raise ValidationError(f"{label}: data inválida (use AAAA-MM-DD)")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError(f"{label}: data inválida (use AAAA-MM-DD)") from exc


def date_field(payload: dict[str, Any], field: str, label: str) -> date:
    """Return a required ISO date field.

    Raises:
        ValidationError: If missing or invalid.
    """
    value = payload.get(field)
    if value is None or value == "":
        raise ValidationError(f"Campo obrigatório: {label}")
    return parse_date(value, label)


def enum_field[E: StrEnum](
    payload: dict[str, Any], field: str, label: str, enum_type: type[E]
) -> E:
    """Return a required enum field.

    Raises:
        ValidationError: If missing or not one of the enum values.
    """
    value = payload.get(field)
    if value is None:
        raise ValidationError(f"Campo obrigatório: {label}")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ValidationError(f"{label}: valor inválido") from exc


def hex_color(payload: dict[str, Any], field: str, label: str, *, required: bool) -> str | None:
    """Return a ``#RRGGBB`` color in upper case.

    Raises:
        ValidationError: If missing (when required) or not in ``#RRGGBB`` format.
    """
    value = payload.get(field)
    if value is None or value == "":
        if required:
            raise ValidationError(f"Campo obrigatório: {label}")
        return None
    if not isinstance(value, str) or not _HEX_COLOR.fullmatch(value):
        raise ValidationError(f"{label}: use o formato #RRGGBB")
    return value.upper()
