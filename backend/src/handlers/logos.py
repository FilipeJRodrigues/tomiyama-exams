"""Academy logo routes (§ 3.7, § 6.6, RN012), examiners only.

- ``PUT /settings/logos/{slot}``: send or replace the logo (JSON with base64).
- ``DELETE /settings/logos/{slot}``: remove it (idempotent).
- ``GET /settings/logos/{slot}``: presigned GET URL valid for 5 minutes.

The object is stored, and the URL serves it, with the type read from the bytes
(never the client's) and ``Content-Disposition: inline; filename="logo.png"``
(or ``.jpg``).

Order of the writes, so a failure halfway never shows a logo that is not there:
the upload writes S3 first and the metadata after; the removal deletes the
metadata first and the object after. A failure between the two leaves at most
an object without metadata, invisible to the API and overwritten or deleted by
the next ``PUT``/``DELETE`` of the slot (the removal always deletes the object).
"""

import logging
from typing import Any

from domain import dates
from domain import images as image_rules
from domain import logos as logo_rules
from domain.errors import NotFoundError
from domain.images import PRESIGNED_URL_SECONDS, ImageMeta
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    no_content,
    require_examiner,
)
from repository import images as image_repo
from repository import settings as settings_repo

logger = logging.getLogger(__name__)


def _slot(event: Event) -> str:
    return logo_rules.parse_slot((event.get("pathParameters") or {}).get("slot"))


def _view(slot: str, meta: ImageMeta) -> dict[str, Any]:
    return {"slot": slot, **meta.to_dict()}


@api_handler
def put_logo(event: Event, context: Any) -> Response:
    """Validate the image (type from its bytes, at most 2 MB) and store it in the slot."""
    user = current_user(event)
    require_examiner(user)
    slot = _slot(event)
    image = image_rules.parse_image_upload(json_body(event))
    disposition = image_rules.content_disposition(image.content_type, logo_rules.LOGO_FILENAME)
    image_repo.put_image(logo_rules.logo_key(slot), image, disposition)
    meta = ImageMeta(
        content_type=image.content_type,
        size=image.size,
        updated_at=dates.utc_now_iso(),
        updated_by=user.sub,
    )
    settings_repo.set_image_meta(logo_rules.logo_attribute(slot), meta)
    logger.info("Logo %s replaced by %s (%d bytes)", slot, user.sub, image.size)
    return json_response(200, _view(slot, meta))


@api_handler
def delete_logo(event: Event, context: Any) -> Response:
    """Remove the slot's logo; removing an empty slot also answers 204."""
    user = current_user(event)
    require_examiner(user)
    slot = _slot(event)
    settings_repo.remove_image_meta(logo_rules.logo_attribute(slot))
    image_repo.delete_image(logo_rules.logo_key(slot))
    logger.info("Logo %s removed by %s", slot, user.sub)
    return no_content()


@api_handler
def get_logo(event: Event, context: Any) -> Response:
    """Return a short-lived URL to the slot's logo, never the bytes nor a public URL."""
    require_examiner(current_user(event))
    slot = _slot(event)
    meta = settings_repo.get_image_meta(logo_rules.logo_attribute(slot))
    if meta is None:
        raise NotFoundError(logo_rules.MSG_LOGO_NOT_FOUND)
    url = image_repo.presigned_get_url(
        logo_rules.logo_key(slot),
        PRESIGNED_URL_SECONDS,
        meta.content_type,
        image_rules.content_disposition(meta.content_type, logo_rules.LOGO_FILENAME),
    )
    return json_response(
        200, {**_view(slot, meta), "url": url, "expires_in": PRESIGNED_URL_SECONDS}
    )
