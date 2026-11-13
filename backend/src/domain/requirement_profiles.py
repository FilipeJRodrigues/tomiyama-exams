"""Requirement profiles (RN017, decision of 2026-11-12).

Every requirement belongs to a profile. The **main profile** (fixed id
``main``, "Principal") holds the Appendix A items and only the admin master
changes it; the other examiners will create their own profiles (full copies)
in a later step. Until then the main profile is the only one that exists.

Items written before profiles existed have no ``profile_id`` and are read as
items of the main profile.
"""

from dataclasses import asdict, dataclass
from typing import Any

from domain import validation
from domain.errors import ForbiddenError, NotFoundError, ValidationError
from domain.users import User

MAIN_PROFILE_ID = "main"
MAIN_PROFILE_NAME = "Principal"
MAX_PROFILE_ID = 64

MSG_PROFILE_NOT_FOUND = "Perfil de requisitos não encontrado"
MSG_MAIN_PROFILE_MASTER_ONLY = (
    "Somente o administrador master altera o perfil principal de requisitos"
)
MSG_PROFILE_LOCKED = "Perfil: o perfil de um requisito não pode ser alterado"


@dataclass(frozen=True)
class RequirementProfile:
    """A named list of requirements per belt."""

    id: str
    name: str
    is_main: bool

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return asdict(self)


MAIN_PROFILE = RequirementProfile(id=MAIN_PROFILE_ID, name=MAIN_PROFILE_NAME, is_main=True)


def profile_belt_key(profile_id: str, belt_id: str) -> str:
    """Return the partition key of the ``by_profile_belt`` index (``<profile>#<belt>``)."""
    return f"{profile_id}#{belt_id}"


def find_profile(profile_id: str | None) -> RequirementProfile:
    """Return the profile asked for; no id (or a blank one) means the main profile.

    Raises:
        NotFoundError: If the profile does not exist (for now only ``main`` does).
    """
    if profile_id is None or not profile_id.strip() or profile_id == MAIN_PROFILE_ID:
        return MAIN_PROFILE
    raise NotFoundError(MSG_PROFILE_NOT_FOUND)


def profile_id_field(payload: dict[str, Any]) -> str | None:
    """Return the ``profile_id`` of a request body, or None when missing or blank.

    Raises:
        ValidationError: If it is not a string or is too long.
    """
    return validation.optional_str(payload, "profile_id", "Perfil", MAX_PROFILE_ID)


def check_profile_unchanged(payload: dict[str, Any], current_profile_id: str) -> None:
    """Refuse an edit that moves an item to another profile (the profile is fixed).

    Leaving ``profile_id`` out of the body, or resending the current one (as a
    form that sends back the whole item does), is accepted.

    Raises:
        ValidationError: If ``profile_id`` is invalid or differs from the current one.
    """
    requested = profile_id_field(payload)
    if requested is not None and requested != current_profile_id:
        raise ValidationError(MSG_PROFILE_LOCKED)


def check_can_edit(profile_id: str, user: User) -> None:
    """Allow creating, editing and deleting the main profile's items only to the admin master.

    Raises:
        ForbiddenError: If the profile is the main one and the user is not the master.
    """
    if profile_id == MAIN_PROFILE_ID and not user.is_master:
        raise ForbiddenError(MSG_MAIN_PROFILE_MASTER_ONLY)
