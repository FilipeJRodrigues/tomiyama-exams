"""Users: the caller (from the Cognito JWT claims) and the examiners of the pool."""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from domain.names import name_sort_key

ADMIN_GROUP = "admin"
GUARDIAN_GROUP = "responsavel"
# "Admin master" (decision of 2026-11-02): an examiner who also chooses the
# sensei. Granted only through the Console/CLI (the first examiner comes with
# it from the template); no API route adds anyone to this group.
MASTER_GROUP = "master"


@dataclass(frozen=True)
class User:
    """The caller of an API request.

    Attributes:
        sub: Cognito user id; the owner id of the students the user registers.
        email: E-mail from the token, when present.
        groups: Cognito groups of the user.
    """

    sub: str
    email: str | None
    groups: frozenset[str]

    @property
    def is_examiner(self) -> bool:
        """Whether the user belongs to the examiners (Cognito group ``admin``)."""
        return ADMIN_GROUP in self.groups

    @property
    def is_master(self) -> bool:
        """Whether the user is the admin master (groups ``master`` and ``admin``).

        A master is always an examiner too; a member of ``master`` alone (a
        misconfigured account) is not treated as master.
        """
        return MASTER_GROUP in self.groups and self.is_examiner


@dataclass(frozen=True)
class Examiner:
    """A member of the Cognito group ``admin``, as listed by the user pool.

    Attributes:
        id: Cognito ``sub``; the value stored in ``sensei_user_id``.
        email: E-mail attribute, when present.
        name: ``name`` attribute, when present (the pool does not require it).
        enabled: False when the account was disabled in Cognito.
    """

    id: str
    email: str | None
    name: str | None
    enabled: bool

    def to_dict(self) -> dict[str, Any]:
        """Return the public summary (no Cognito status or other attributes)."""
        return {"id": self.id, "email": self.email, "name": self.name}


def active_examiners(examiners: Iterable[Examiner]) -> list[Examiner]:
    """Return the enabled examiners sorted by name, or by e-mail without a name (§ 6.6).

    Accents and case are ignored ("Álvaro" before "Bruno"); the id breaks ties.
    """
    enabled = [examiner for examiner in examiners if examiner.enabled]
    return sorted(enabled, key=lambda ex: name_sort_key(ex.name or ex.email, ex.id))
