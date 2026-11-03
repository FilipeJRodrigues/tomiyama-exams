"""Academy logos (§ 3.7, RN012): two fixed slots, ``primary`` and ``secondary``.

Each slot has a fixed S3 key (sending again overwrites it) and a metadata
attribute in the settings record (``logo_primary``/``logo_secondary``). Upload,
removal and reading are open to every examiner.
"""

from domain.errors import NotFoundError

LOGO_SLOTS = ("primary", "secondary")
# Prefix of every logo object; the functions' IAM policies are limited to it.
LOGO_KEY_PREFIX = "logos/"
# Fixed file name the browser sees (``logo.png``/``logo.jpg``), whatever the
# name of the file the examiner sent.
LOGO_FILENAME = "logo"

MSG_LOGO_NOT_FOUND = "Logo não encontrado"


def parse_slot(raw: str | None) -> str:
    """Return the slot named in the path.

    Raises:
        NotFoundError: If the slot is not ``primary`` or ``secondary`` (a path
            outside the closed set is a resource that does not exist).
    """
    if raw not in LOGO_SLOTS:
        raise NotFoundError(MSG_LOGO_NOT_FOUND)
    return raw


def logo_key(slot: str) -> str:
    """Return the S3 key of the slot, e.g. ``logos/primary``."""
    return f"{LOGO_KEY_PREFIX}{slot}"


def logo_attribute(slot: str) -> str:
    """Return the settings attribute holding the slot's metadata, e.g. ``logo_primary``."""
    return f"logo_{slot}"
