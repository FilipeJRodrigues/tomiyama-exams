"""Authenticated user, built from the Cognito JWT claims."""

from dataclasses import dataclass

ADMIN_GROUP = "admin"
GUARDIAN_GROUP = "responsavel"


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
