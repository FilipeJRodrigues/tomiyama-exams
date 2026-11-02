"""Academy settings (§ 3.7): a single record with the academy data and the sensei.

The images (logos and, from step 5, the certificate signatures) live in the
same record but never in this model nor in its JSON; they have their own
routes (RN012). Saving the text fields keeps them untouched.

The sensei is one of the active examiners (Cognito group ``admin``, account
enabled) and is the only one who decides exams (RN008). Only the admin master
chooses or changes the sensei (decision of 2026-11-02); the other fields are
open to every examiner.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from domain import validation
from domain.errors import ValidationError
from domain.users import Examiner

SETTINGS_ID = "academy"

MAX_ACADEMY_NAME = 255
MAX_CERTIFICATE_CITY = 80
# A Cognito ``sub`` is a 36-character UUID; anything much longer is not an id.
MAX_SENSEI_USER_ID = 128

MSG_SENSEI_NOT_ACTIVE_EXAMINER = "O sensei precisa ser um examinador ativo"
MSG_ONLY_MASTER_CHOOSES_SENSEI = "Somente o administrador master escolhe o sensei"


@dataclass(frozen=True)
class AcademySettings:
    """Text fields of the settings record.

    ``academy_name`` is None only before the first save.
    """

    academy_name: str | None
    sensei_user_id: str | None
    certificate_city: str | None
    created_at: str | None = None
    updated_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return the stored fields (no images)."""
        return {
            "academy_name": self.academy_name,
            "sensei_user_id": self.sensei_user_id,
            "certificate_city": self.certificate_city,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


EMPTY_SETTINGS = AcademySettings(academy_name=None, sensei_user_id=None, certificate_city=None)


def parse_settings(payload: dict[str, Any], now_iso: str) -> AcademySettings:
    """Build the new text fields from a ``PUT /settings`` body.

    Every field is replaced: optional fields missing, null or blank become
    None. Strings are trimmed. Other keys (for example image fields) are
    ignored. Whether the sensei is an active examiner is checked separately by
    ``check_sensei``, which needs the pool's examiners.

    Raises:
        ValidationError: If a field is invalid or ``academy_name`` is blank.
    """
    return AcademySettings(
        academy_name=validation.required_str(
            payload, "academy_name", "Nome da academia", MAX_ACADEMY_NAME
        ),
        sensei_user_id=validation.optional_str(
            payload, "sensei_user_id", "Sensei", MAX_SENSEI_USER_ID
        ),
        certificate_city=validation.optional_str(
            payload, "certificate_city", "Cidade do certificado", MAX_CERTIFICATE_CITY
        ),
        updated_at=now_iso,
    )


def find_active_examiner(examiners: Iterable[Examiner], user_id: str) -> Examiner | None:
    """Return the enabled examiner whose ``sub`` is ``user_id``, or None."""
    return next((ex for ex in examiners if ex.id == user_id and ex.enabled), None)


def check_sensei(settings: AcademySettings, examiners: Iterable[Examiner]) -> Examiner | None:
    """Ensure the chosen sensei is an active examiner (§ 2; required by RN008).

    Args:
        settings: New settings; ``sensei_user_id`` None means "no sensei".
        examiners: Every member of the group ``admin``, enabled or not.

    Returns:
        The sensei, or None when no sensei is set.

    Raises:
        ValidationError: If the user does not exist, is not in the group
            ``admin`` or is disabled.
    """
    if settings.sensei_user_id is None:
        return None
    sensei = find_active_examiner(examiners, settings.sensei_user_id)
    if sensei is None:
        raise ValidationError(MSG_SENSEI_NOT_ACTIVE_EXAMINER)
    return sensei


def settings_view(settings: AcademySettings, examiners: Iterable[Examiner]) -> dict[str, Any]:
    """Return the ``GET``/``PUT /settings`` response body.

    ``sensei`` summarizes the configured sensei, or is None without one.
    ``active`` is False when the account was disabled or left the group
    ``admin`` (or was deleted); in the last two cases ``email`` and ``name``
    are None, since only the group's members are looked up.

    Args:
        settings: Stored settings.
        examiners: Members of the group ``admin`` (may be empty without a sensei).
    """
    sensei: dict[str, Any] | None = None
    if settings.sensei_user_id is not None:
        member = next((ex for ex in examiners if ex.id == settings.sensei_user_id), None)
        sensei = {
            "id": settings.sensei_user_id,
            "email": member.email if member else None,
            "name": member.name if member else None,
            "active": member.enabled if member else False,
        }
    return {**settings.to_dict(), "sensei": sensei}
