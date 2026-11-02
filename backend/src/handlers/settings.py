"""Academy settings routes, examiners only (§ 2, § 3.7, § 6.6).

- ``GET /settings``: the text fields plus a summary of the sensei.
- ``PUT /settings``: replace the text fields; only the admin master may change
  the sensei, who must be an active examiner (decision of 2026-11-02). Other
  examiners may save the form as long as they resend the stored sensei, which
  is not revalidated for them (it may have become inactive meanwhile).

Images (logos and certificate signatures) are never part of these bodies (RN012).
"""

import logging
from typing import Any

from domain import dates
from domain import settings as settings_rules
from domain.settings import EMPTY_SETTINGS
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    require_examiner,
)
from repository import settings as settings_repo
from repository import users as user_repo

logger = logging.getLogger(__name__)


@api_handler
def get_settings(event: Event, context: Any) -> Response:
    """Return the settings; every field is null before the first save."""
    require_examiner(current_user(event))
    settings = settings_repo.get_settings() or EMPTY_SETTINGS
    # Cognito is only queried when there is a sensei to summarize.
    examiners = user_repo.list_examiners() if settings.sensei_user_id else []
    return json_response(200, settings_rules.settings_view(settings, examiners))


@api_handler
def update_settings(event: Event, context: Any) -> Response:
    """Replace the text fields of the settings."""
    user = current_user(event)
    require_examiner(user)
    settings = settings_rules.parse_settings(json_body(event), now_iso=dates.utc_now_iso())
    # The examiners are listed for the response summary; only the master's
    # choice is validated against them. Anyone else can only keep the stored
    # sensei (checked atomically by the write), even if it became inactive, so
    # an inactive sensei never blocks them from saving the other fields.
    examiners = user_repo.list_examiners() if settings.sensei_user_id else []
    if user.is_master:
        settings_rules.check_sensei(settings, examiners)
    stored = settings_repo.save_settings(settings, keep_sensei=not user.is_master)
    logger.info("Settings updated by %s (sensei %s)", user.sub, stored.sensei_user_id)
    return json_response(200, settings_rules.settings_view(stored, examiners))
