"""User routes, examiners only.

- ``GET /examiners``: active examiners (group ``admin``, account enabled), for
  the sensei selector of the settings screen (§ 6.6).
"""

from typing import Any

from domain.users import active_examiners
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_response,
    require_examiner,
)
from repository import users as user_repo


@api_handler
def list_examiners(event: Event, context: Any) -> Response:
    """List the active examiners by name (or e-mail without a name)."""
    require_examiner(current_user(event))
    examiners = active_examiners(user_repo.list_examiners())
    return json_response(200, [examiner.to_dict() for examiner in examiners])
