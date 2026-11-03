"""Certificate signatures (§ 3.7, § 7, RN011, RN012): up to 3, in an ordered list.

Each signature has a name, a graduation (free text, e.g. "Fundador, 6º Dan (in
memoriam)"), an optional image (PNG or JPEG of at most 2 MB, validated like the
logos by ``domain.images``) and a position on the certificate, which is its
place in the list (1 to 3). The person may have no login.

A signature is **complete** with name, graduation and image; the certificate
(RN011) needs at least one complete signature.

Only the admin master and the sensei (``sensei_user_id`` of the settings, read
on every request) create, edit, remove, reorder **and read** them (decision of
2026-11-02): never a guardian nor another examiner, so nobody else can copy an
image and forge a certificate.

Every change is a pure function from the current list to the new one; the
repository writes the result only if the list is still the one read (a version
number), so the limit of 3 and the order hold under concurrent requests.
"""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from typing import Any

from domain import validation
from domain.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from domain.images import ImageMeta
from domain.users import User

# Id of the item of the ``Settings`` table that holds the list. Separate from
# the settings record (``academy``), so the routes that read that record (any
# examiner) never load the signatures; the template limits each function to
# the item it needs (``dynamodb:LeadingKeys``).
SIGNATURES_ID = "certificate_signatures"

MAX_SIGNATURES = 3
MAX_NAME = 120
MAX_GRADUATION = 120

# Prefix of every signature image; the functions' IAM policies are limited to it.
# Each upload gets its own key ``signatures/{id}/{uuid}`` (``new_image_key``),
# chosen by the API, never by the client; the list records the current one.
SIGNATURE_KEY_PREFIX = "signatures/"
# Fixed file name the browser sees (``assinatura.png``/``assinatura.jpg``).
SIGNATURE_FILENAME = "assinatura"

MSG_ONLY_MASTER_OR_SENSEI = "Somente o master e o sensei gerem as assinaturas"
MSG_SIGNATURE_NOT_FOUND = "Assinatura não encontrada"
MSG_SIGNATURE_IMAGE_NOT_FOUND = "Assinatura sem imagem"
MSG_SIGNATURE_LIMIT = f"O certificado aceita no máximo {MAX_SIGNATURES} assinaturas"
MSG_INVALID_ORDER = "Ordem inválida: envie ids com a lista de assinaturas"
MSG_ORDER_OUTDATED = "A lista de assinaturas mudou. Recarregue e tente de novo."
MSG_SIGNATURES_BUSY = "As assinaturas estão sendo alteradas por outra pessoa. Tente de novo."


@dataclass(frozen=True)
class Signature:
    """One certificate signature.

    Attributes:
        id: Random UUID; its images live under ``signatures/{id}/``.
        name: Name printed under the line.
        graduation: Graduation printed under the name; None until filled in.
        image: Metadata of the image in S3; None without image.
        updated_at: Last change of the name, graduation or image.
        updated_by: ``sub`` of who made that change.
        image_key: S3 key of the current image (``signatures/{id}/{uuid}``),
            stored as ``key`` in the ``image`` map; None exactly when
            ``image`` is None.
    """

    id: str
    name: str
    graduation: str | None
    image: ImageMeta | None
    updated_at: str
    updated_by: str
    image_key: str | None = None

    def __post_init__(self) -> None:
        if (self.image is None) != (self.image_key is None):
            raise ValueError("image and image_key go together")

    @property
    def complete(self) -> bool:
        """Whether it can go on a certificate: name, graduation and image (RN011)."""
        return bool(self.name and self.graduation and self.image is not None)

    def to_item(self) -> dict[str, Any]:
        """Return the stored map (absent fields are left out)."""
        item: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "updated_at": self.updated_at,
            "updated_by": self.updated_by,
        }
        if self.graduation is not None:
            item["graduation"] = self.graduation
        if self.image is not None:
            item["image"] = {**self.image.to_dict(), "key": self.image_key}
        return item

    @classmethod
    def from_item(cls, item: dict[str, Any]) -> "Signature":
        """Rebuild a signature from its stored map.

        Image metadata without a valid key of this signature counts as no
        image: the API never points at an object it did not register.
        """
        signature_id = str(item["id"])
        raw_image = item.get("image")
        image = ImageMeta.from_dict(raw_image)
        key = raw_image.get("key") if isinstance(raw_image, dict) else None
        if image is None or not is_image_key(signature_id, key):
            image, key = None, None
        return cls(
            id=signature_id,
            name=str(item["name"]),
            graduation=item.get("graduation"),
            image=image,
            updated_at=str(item["updated_at"]),
            updated_by=str(item["updated_by"]),
            image_key=key,
        )


Signatures = tuple[Signature, ...]


@dataclass(frozen=True)
class SignatureList:
    """The stored list and its version (0 before the first write)."""

    version: int
    signatures: Signatures


EMPTY_LIST = SignatureList(version=0, signatures=())


# --- access -------------------------------------------------------------------------


def manager_check(user: User, sensei_user_id: str | None) -> str | None:
    """Allow only the master and the sensei to manage or read the signatures (RN012).

    Args:
        user: The caller.
        sensei_user_id: The sensei stored in the settings right now.

    Returns:
        None for the master (no further check); for the sensei, their ``sub``,
        which every write checks again against the settings in the same
        transaction (a sensei replaced meanwhile writes nothing).

    Raises:
        ForbiddenError: For guardians, other examiners, and every examiner but
            the master while no sensei is set.
    """
    if user.is_master:
        return None
    if user.is_examiner and sensei_user_id is not None and sensei_user_id == user.sub:
        return user.sub
    raise ForbiddenError(MSG_ONLY_MASTER_OR_SENSEI)


# --- input --------------------------------------------------------------------------


def parse_signature_id(raw: str | None) -> str:
    """Return the id named in the path.

    Raises:
        NotFoundError: If it is not a canonical UUID (no signature has such id).
    """
    try:
        parsed = uuid.UUID(raw or "")
    except ValueError as exc:
        raise NotFoundError(MSG_SIGNATURE_NOT_FOUND) from exc
    if str(parsed) != raw:
        raise NotFoundError(MSG_SIGNATURE_NOT_FOUND)
    return raw


def new_signature_id() -> str:
    """Return a fresh random id for a new signature."""
    return str(uuid.uuid4())


def parse_fields(payload: dict[str, Any]) -> tuple[str, str | None]:
    """Return ``(name, graduation)`` from a create or edit body.

    Both fields are replaced: ``graduation`` missing, null or blank becomes
    None (an incomplete signature). Strings are trimmed; other keys, such as
    an image, are ignored.

    Raises:
        ValidationError: If ``name`` is blank or a field is not text or too long.
    """
    name = validation.required_str(payload, "name", "Nome", MAX_NAME)
    graduation = validation.optional_str(payload, "graduation", "Graduação", MAX_GRADUATION)
    return name, graduation


def parse_order(payload: dict[str, Any]) -> list[str]:
    """Return the ids of a reorder body ``{"ids": [...]}``.

    Raises:
        ValidationError: If ``ids`` is not a list of distinct strings.
    """
    ids = payload.get("ids")
    if not isinstance(ids, list) or not all(isinstance(value, str) for value in ids):
        raise ValidationError(MSG_INVALID_ORDER)
    if len(set(ids)) != len(ids) or len(ids) > MAX_SIGNATURES:
        raise ValidationError(MSG_INVALID_ORDER)
    return ids


# --- changes (pure: current list -> new list) ---------------------------------------


def find(signatures: Iterable[Signature], signature_id: str) -> Signature:
    """Return the signature with ``signature_id``.

    Raises:
        NotFoundError: If there is none.
    """
    found = next((item for item in signatures if item.id == signature_id), None)
    if found is None:
        raise NotFoundError(MSG_SIGNATURE_NOT_FOUND)
    return found


def add(signatures: Signatures, new: Signature) -> Signatures:
    """Append ``new`` at the last position.

    Raises:
        ConflictError: If the list already has MAX_SIGNATURES signatures.
    """
    if len(signatures) >= MAX_SIGNATURES:
        raise ConflictError(MSG_SIGNATURE_LIMIT)
    return (*signatures, new)


def edit(
    signatures: Signatures,
    signature_id: str,
    *,
    name: str,
    graduation: str | None,
    now_iso: str,
    user_sub: str,
) -> Signatures:
    """Replace the name and graduation of a signature, keeping its image and position.

    Raises:
        NotFoundError: If the signature does not exist (anymore).
    """
    find(signatures, signature_id)
    return tuple(
        replace(item, name=name, graduation=graduation, updated_at=now_iso, updated_by=user_sub)
        if item.id == signature_id
        else item
        for item in signatures
    )


def set_image(
    signatures: Signatures,
    signature_id: str,
    image: ImageMeta | None,
    *,
    image_key: str | None,
    now_iso: str,
    user_sub: str,
) -> Signatures:
    """Set (or, with None and None, clear) the image metadata and key of a signature.

    Clearing a signature that has no image returns the list unchanged.

    Raises:
        NotFoundError: If the signature does not exist (anymore).
        ValueError: If only one of ``image`` and ``image_key`` is given, or the
            key is not one of this signature (a programming error).
    """
    current = find(signatures, signature_id)
    if image_key is not None and not is_image_key(signature_id, image_key):
        raise ValueError(f"unexpected image key: {image_key!r}")
    if image is None and current.image is None:
        return signatures
    return tuple(
        replace(item, image=image, image_key=image_key, updated_at=now_iso, updated_by=user_sub)
        if item.id == signature_id
        else item
        for item in signatures
    )


def remove(signatures: Signatures, signature_id: str) -> Signatures:
    """Drop a signature; the next ones move up one position.

    Removing a signature that is not in the list returns it unchanged
    (idempotent: a repeated ``DELETE`` still cleans the image left behind).
    """
    return tuple(item for item in signatures if item.id != signature_id)


def reorder(signatures: Signatures, ids: Sequence[str]) -> Signatures:
    """Put the signatures in the order of ``ids`` (position 1 first).

    Raises:
        ConflictError: If ``ids`` is not exactly the set of stored ids (the
            screen is showing an outdated list).
    """
    by_id = {item.id: item for item in signatures}
    if len(ids) != len(by_id) or set(ids) != set(by_id):
        raise ConflictError(MSG_ORDER_OUTDATED)
    return tuple(by_id[signature_id] for signature_id in ids)


# --- output -------------------------------------------------------------------------


def has_complete(signatures: Iterable[Signature]) -> bool:
    """Whether at least one signature is complete (needed to issue a certificate, RN011)."""
    return any(item.complete for item in signatures)


def position_of(signatures: Sequence[Signature], signature_id: str) -> int:
    """Return the 1-based position of a signature on the certificate.

    Raises:
        NotFoundError: If the signature is not in the list.
    """
    for index, item in enumerate(signatures, start=1):
        if item.id == signature_id:
            return index
    raise NotFoundError(MSG_SIGNATURE_NOT_FOUND)


def signature_view(signature: Signature, position: int) -> dict[str, Any]:
    """Return one signature as the API shows it (image metadata, never the bytes)."""
    return {
        "id": signature.id,
        "position": position,
        "name": signature.name,
        "graduation": signature.graduation,
        "image": signature.image.to_dict() if signature.image is not None else None,
        "complete": signature.complete,
        "updated_at": signature.updated_at,
        "updated_by": signature.updated_by,
    }


def list_view(signatures: Sequence[Signature]) -> dict[str, Any]:
    """Return the ``GET /settings/signatures`` body."""
    return {
        "signatures": [
            signature_view(item, position) for position, item in enumerate(signatures, start=1)
        ],
        "max_signatures": MAX_SIGNATURES,
        "has_complete": has_complete(signatures),
    }


# --- image keys -------------------------------------------------------------------------


def _image_prefix(signature_id: str) -> str:
    return f"{SIGNATURE_KEY_PREFIX}{signature_id}/"


def new_image_key(signature_id: str) -> str:
    """Return a fresh S3 key for one upload, ``signatures/{id}/{uuid}``.

    A new key on every upload: two uploads (or an upload and a removal) at the
    same time never write over each other's object, so the key recorded in
    the list always names the bytes its metadata describes.
    """
    return f"{_image_prefix(signature_id)}{uuid.uuid4()}"


def is_image_key(signature_id: str, key: Any) -> bool:
    """Whether ``key`` is an image key of this signature (``signatures/{id}/{uuid}``)."""
    if not isinstance(key, str) or not key.startswith(_image_prefix(signature_id)):
        return False
    suffix = key[len(_image_prefix(signature_id)) :]
    try:
        return str(uuid.UUID(suffix)) == suffix
    except ValueError:
        return False


def image_key_of(signatures: Iterable[Signature], signature_id: str) -> str | None:
    """Return the key recorded for the signature's image (None without image or signature)."""
    found = next((item for item in signatures if item.id == signature_id), None)
    return found.image_key if found is not None else None


def references_key(signatures: Iterable[Signature], key: str) -> bool:
    """Whether any signature's image metadata point to ``key`` (it must not be deleted)."""
    return any(item.image_key == key for item in signatures)
