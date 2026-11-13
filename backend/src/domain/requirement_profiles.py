"""Requirement profiles (RN017, decisions of 2026-11-12 and 2026-11-13).

Every requirement belongs to a profile. The **main profile** (fixed id
``main``, "Principal") holds the Appendix A items; it is never renamed and
only the admin master changes its items. Any examiner creates other profiles,
each a **full copy** of the main profile or of another profile, renames them
and creates, edits and deletes their items. There are at most
``MAX_PROFILES`` profiles in all, the main one included.

A new profile starts ``COPYING``: a background job
(``handlers.requirement_profile_copy``) copies the source's items and then
marks it ``READY``. While it copies, its items are listed as copied so far,
but not created, edited nor deleted (409). A copy with no sign of life for
``COPY_STALL_SECONDS`` is **stalled** and any examiner may resume it.

The main profile is not stored: it is ``MAIN_PROFILE``, always ``READY``. The
others live in one item of the ``Settings`` table
(``repository.requirement_profiles``).

Items written before profiles existed have no ``profile_id`` and are read as
items of the main profile.
"""

from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from domain import validation
from domain.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from domain.names import fold_name, name_sort_key
from domain.users import User

MAIN_PROFILE_ID = "main"
MAIN_PROFILE_NAME = "Principal"
MAX_PROFILE_ID = 64
MAX_PROFILE_NAME = 60

# At most this many profiles in all: the main one and two created by the
# examiners (decision of 2026-11-13). Every stored profile counts, whatever
# its status.
MAX_PROFILES = 3

# A copy whose last sign of life (start, progress or resume) is this old is
# stalled. The copy function runs at most 900 s and writes its progress every
# ``PROGRESS_EVERY_SECONDS`` while it runs, so a live copy is never this quiet.
COPY_STALL_SECONDS = 15 * 60

MSG_PROFILE_NOT_FOUND = "Perfil de requisitos não encontrado"
MSG_SOURCE_PROFILE_NOT_FOUND = "Perfil de origem não encontrado"
MSG_MAIN_PROFILE_MASTER_ONLY = (
    "Somente o administrador master altera o perfil principal de requisitos"
)
MSG_MAIN_PROFILE_RENAME = "O nome do perfil principal não pode ser alterado"
MSG_PROFILE_LOCKED = "Perfil: o perfil de um requisito não pode ser alterado"
MSG_PROFILE_NAME_TAKEN = "Já existe um perfil de requisitos com este nome"
MSG_PROFILE_LIMIT = (
    f"Limite de {MAX_PROFILES} perfis de requisitos atingido. Exclua um perfil para criar outro."
)
MSG_SOURCE_PROFILE_COPYING = "O perfil de origem ainda está sendo copiado. Aguarde o fim da cópia."
MSG_PROFILE_COPYING = (
    "O perfil ainda está sendo copiado. Aguarde o fim da cópia para alterar os itens."
)
MSG_PROFILE_READY = "A cópia deste perfil já terminou"
MSG_COPY_IN_PROGRESS = "A cópia deste perfil está em andamento. Aguarde."
MSG_PROFILES_BUSY = "Os perfis de requisitos estão sendo alterados por outra pessoa. Tente de novo."


class ProfileStatus(StrEnum):
    """Whether the profile's items are complete (``READY``) or still being copied."""

    READY = "READY"
    COPYING = "COPYING"


@dataclass(frozen=True)
class RequirementProfile:
    """A named list of requirements per belt.

    Attributes:
        id: ``main`` for the main profile; a random UUID for the others.
        name: Name shown in the selector; unique among the profiles, ignoring
            case and accents.
        is_main: True only for the main profile.
        status: ``COPYING`` until the background copy finishes.
        source_profile_id: Profile the items were copied from (None for main).
        created_by: ``sub`` of the examiner who created it (None for main).
        created_at: When it was created (None for main).
        copy_updated_at: Last sign of life of the copy: the request that
            started or resumed it, or the copy's own progress. None while
            copying means the copy never started (it is stalled).
        copied_items: Items already in the profile, at the last progress.
        total_items: Items of the source, once the copy has read them.
    """

    id: str
    name: str
    is_main: bool
    status: ProfileStatus = ProfileStatus.READY
    source_profile_id: str | None = None
    created_by: str | None = None
    created_at: str | None = None
    copy_updated_at: str | None = None
    copied_items: int | None = None
    total_items: int | None = None

    def is_copy_stalled(self, now_iso: str) -> bool:
        """Whether the profile is copying with no sign of life for ``COPY_STALL_SECONDS``."""
        if self.status is not ProfileStatus.COPYING:
            return False
        if self.copy_updated_at is None:
            return True
        return self.copy_updated_at <= stall_threshold(now_iso)

    def to_dict(self, now_iso: str) -> dict[str, Any]:
        """Return the JSON representation, with ``copy_stalled`` computed at ``now_iso``."""
        data = asdict(self)
        data["status"] = self.status.value
        data["copy_stalled"] = self.is_copy_stalled(now_iso)
        return data

    def to_item(self) -> dict[str, Any]:
        """Return the stored map (no ``id``, the key of the map; no None values)."""
        data = asdict(self)
        data["status"] = self.status.value
        return {
            key: value
            for key, value in data.items()
            if key not in {"id", "is_main"} and value is not None
        }

    @classmethod
    def from_item(cls, profile_id: str, item: Mapping[str, Any]) -> "RequirementProfile":
        """Build a stored profile from its map in the profiles item."""

        def optional_int(key: str) -> int | None:
            value = item.get(key)
            return None if value is None else int(value)

        return cls(
            id=profile_id,
            name=str(item["name"]),
            is_main=False,
            status=ProfileStatus(item.get("status", ProfileStatus.READY.value)),
            source_profile_id=item.get("source_profile_id"),
            created_by=item.get("created_by"),
            created_at=item.get("created_at"),
            copy_updated_at=item.get("copy_updated_at"),
            copied_items=optional_int("copied_items"),
            total_items=optional_int("total_items"),
        )


MAIN_PROFILE = RequirementProfile(id=MAIN_PROFILE_ID, name=MAIN_PROFILE_NAME, is_main=True)

Lookup = Callable[[str], RequirementProfile | None]


def stall_threshold(now_iso: str) -> str:
    """Return the ISO time before which a copy's last sign of life means it stalled.

    Every time is written by ``domain.dates.utc_now_iso`` (UTC, whole
    seconds), so the strings compare in time order, in Python and in a
    DynamoDB condition alike.
    """
    moment = datetime.fromisoformat(now_iso) - timedelta(seconds=COPY_STALL_SECONDS)
    return moment.isoformat(timespec="seconds")


def profile_belt_key(profile_id: str, belt_id: str) -> str:
    """Return the partition key of the ``by_profile_belt`` index (``<profile>#<belt>``)."""
    return f"{profile_id}#{belt_id}"


def profile_attributes_to_fix(
    profile_id: Any, profile_belt: Any, belt_id: str
) -> tuple[str, str] | None:
    """Return the ``profile_id`` and ``profile_belt`` a stored item must get, or None if right.

    An item without ``profile_id`` belongs to the main profile, and an item
    is found in ``by_profile_belt`` only if its ``profile_belt`` is
    ``<profile_id>#<belt_id>`` of its current belt. Used by the v2 migration
    (#144), which fixes items written before profiles existed and items whose
    belt changed without ``profile_belt`` (code from before profiles).

    Args:
        profile_id: Stored ``profile_id`` (None when absent).
        profile_belt: Stored ``profile_belt`` (None when absent).
        belt_id: Stored ``belt_id``.
    """
    profile = profile_id or MAIN_PROFILE_ID
    key = profile_belt_key(profile, belt_id)
    if profile_id == profile and profile_belt == key:
        return None
    return profile, key


def resolve_profile(profile_id: str, lookup: Lookup) -> RequirementProfile:
    """Return the profile with exactly this id (``main`` is the main profile).

    Args:
        profile_id: Id from the path, the body or a stored item.
        lookup: Reads a stored profile by id (None if there is none); never
            called for ``main``.

    Raises:
        NotFoundError: If no profile has this id.
    """
    if profile_id == MAIN_PROFILE_ID:
        return MAIN_PROFILE
    profile = lookup(profile_id)
    if profile is None:
        raise NotFoundError(MSG_PROFILE_NOT_FOUND)
    return profile


def find_profile(profile_id: str | None, lookup: Lookup) -> RequirementProfile:
    """Return the profile asked for in a query or body; no id (or a blank one) means main.

    Raises:
        NotFoundError: If the profile does not exist.
    """
    if profile_id is None or not profile_id.strip():
        return MAIN_PROFILE
    return resolve_profile(profile_id, lookup)


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


def check_can_edit(profile: RequirementProfile, user: User) -> None:
    """Allow creating, editing and deleting a profile's items.

    The main profile's items are reserved to the admin master; the items of a
    profile still being copied wait for the copy (it would write over them).

    Raises:
        ForbiddenError: If the profile is the main one and the user is not the master.
        ConflictError: If the profile is still copying.
    """
    if profile.is_main and not user.is_master:
        raise ForbiddenError(MSG_MAIN_PROFILE_MASTER_ONLY)
    if profile.status is ProfileStatus.COPYING:
        raise ConflictError(MSG_PROFILE_COPYING)


def parse_profile_name(payload: dict[str, Any]) -> str:
    """Return the trimmed ``name`` of a profile body.

    Raises:
        ValidationError: If missing, blank, not a string or longer than ``MAX_PROFILE_NAME``.
    """
    return validation.required_str(payload, "name", "Nome", MAX_PROFILE_NAME)


def parse_new_profile(payload: dict[str, Any]) -> tuple[str, str | None]:
    """Return ``(name, source_profile_id)`` of a ``POST /requirement-profiles`` body.

    ``source_profile_id`` missing or blank means the main profile (None).

    Raises:
        ValidationError: If a field is invalid.
    """
    name = parse_profile_name(payload)
    source = validation.optional_str(
        payload, "source_profile_id", "Perfil de origem", MAX_PROFILE_ID
    )
    return name, source


def check_name_available(
    name: str, profiles: Iterable[RequirementProfile], *, exclude_id: str | None = None
) -> None:
    """Refuse a name already used by another profile, the main one ("Principal") included.

    Names are compared without case and accents (``fold_name``), so
    "principal" and "Perfil Á" collide with "Principal" and "Perfil A".

    Raises:
        ConflictError: If another profile has the same folded name.
    """
    folded = fold_name(name)
    for profile in (MAIN_PROFILE, *profiles):
        if profile.id != exclude_id and fold_name(profile.name) == folded:
            raise ConflictError(MSG_PROFILE_NAME_TAKEN)


def check_profile_limit(stored: Iterable[RequirementProfile]) -> None:
    """Refuse a new profile once ``MAX_PROFILES`` exist, the main one included.

    Every stored profile counts, whatever its status: one still copying (or
    whose copy stalled) already holds its place. The main profile counts once,
    even if ``stored`` happens to carry it.

    Raises:
        ConflictError: If the main profile and the stored ones reach the limit.
    """
    existing = {MAIN_PROFILE_ID, *(profile.id for profile in stored)}
    if len(existing) >= MAX_PROFILES:
        raise ConflictError(MSG_PROFILE_LIMIT)


def plan_new_profile(
    stored: Mapping[str, RequirementProfile],
    *,
    profile_id: str,
    name: str,
    source_profile_id: str | None,
    user_sub: str,
    now_iso: str,
) -> RequirementProfile:
    """Build a new profile, ``COPYING`` from its source, checked against the stored ones.

    Checks, in order: the source exists (404), its copy has finished (409),
    the limit of ``MAX_PROFILES`` (409) and the name is free (409). When the
    limit and a taken name both apply, the limit wins: no other name lets the
    profile be created, only deleting one does (and deleting the namesake also
    frees the name).

    Args:
        stored: Every stored profile by id (the main one is not stored).
        profile_id: New random id.
        name: Validated name.
        source_profile_id: Profile to copy; None means the main profile.
        user_sub: Who creates it.
        now_iso: Creation time, also the copy's first sign of life.

    Raises:
        NotFoundError: If the source does not exist.
        ConflictError: If the source is still copying, the limit is reached
            or the name is taken.
    """
    source_id = source_profile_id or MAIN_PROFILE_ID
    try:
        source = resolve_profile(source_id, stored.get)
    except NotFoundError as exc:
        raise NotFoundError(MSG_SOURCE_PROFILE_NOT_FOUND) from exc
    if source.status is not ProfileStatus.READY:
        raise ConflictError(MSG_SOURCE_PROFILE_COPYING)
    check_profile_limit(stored.values())
    check_name_available(name, stored.values())
    return RequirementProfile(
        id=profile_id,
        name=name,
        is_main=False,
        status=ProfileStatus.COPYING,
        source_profile_id=source.id,
        created_by=user_sub,
        created_at=now_iso,
        copy_updated_at=now_iso,
    )


def check_can_rename(profile_id: str) -> None:
    """Refuse renaming the main profile, for everyone (the master included).

    Raises:
        ForbiddenError: If ``profile_id`` is the main profile's.
    """
    if profile_id == MAIN_PROFILE_ID:
        raise ForbiddenError(MSG_MAIN_PROFILE_RENAME)


def renamed(
    stored: Mapping[str, RequirementProfile], profile_id: str, name: str
) -> RequirementProfile:
    """Return the stored profile with the new name, checked against the others.

    Raises:
        NotFoundError: If the profile does not exist (deleted meanwhile).
        ConflictError: If another profile has the name.
    """
    current = stored.get(profile_id)
    if current is None:
        raise NotFoundError(MSG_PROFILE_NOT_FOUND)
    check_name_available(name, stored.values(), exclude_id=profile_id)
    return replace(current, name=name)


def check_can_resume(profile: RequirementProfile, now_iso: str) -> None:
    """Allow resuming only a stalled copy.

    Raises:
        ConflictError: If the profile is ready (the main one always is) or
            its copy shows signs of life.
    """
    if profile.status is not ProfileStatus.COPYING:
        raise ConflictError(MSG_PROFILE_READY)
    if not profile.is_copy_stalled(now_iso):
        raise ConflictError(MSG_COPY_IN_PROGRESS)


def sorted_profiles(stored: Iterable[RequirementProfile]) -> list[RequirementProfile]:
    """Return the main profile first, then the others by name (accents ignored, pt-BR)."""
    others = sorted(stored, key=lambda profile: name_sort_key(profile.name, profile.id))
    return [MAIN_PROFILE, *others]
