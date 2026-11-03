"""Certificate signature routes (§ 3.7, § 6.6, RN012): the master and the sensei only.

- ``GET /settings/signatures``: the ordered list (no image bytes) and ``has_complete``.
- ``POST /settings/signatures``: create one at the last position (at most 3).
- ``PUT /settings/signatures/order``: reorder (``{"ids": [...]}``).
- ``PUT /settings/signatures/{id}``: replace the name and graduation.
- ``DELETE /settings/signatures/{id}``: remove it and its image (idempotent).
- ``PUT /settings/signatures/{id}/image``: send or replace the image (JSON with base64).
- ``DELETE /settings/signatures/{id}/image``: remove the image (idempotent).
- ``GET /settings/signatures/{id}/image``: presigned GET URL valid for 5 minutes.

Who may call them is checked on every request against the sensei stored in the
settings (never cached), before the body or the id is looked at; every write
checks it again in its own transaction.

Order of the image writes, as for the logos: the upload writes S3 first and
the metadata after; the removals delete the metadata first and the object
after. A failure halfway leaves at most an object without metadata, invisible
to the API and overwritten or deleted by the next upload or removal.
"""

import logging
from typing import Any

from domain import dates
from domain import images as image_rules
from domain import signatures as rules
from domain.errors import NotFoundError
from domain.images import PRESIGNED_URL_SECONDS, ImageMeta
from domain.users import User
from handlers.http import (
    Event,
    Response,
    api_handler,
    current_user,
    json_body,
    json_response,
    no_content,
)
from repository import images as image_repo
from repository import settings as settings_repo
from repository import signatures as signature_repo

logger = logging.getLogger(__name__)


def _authorize(event: Event) -> tuple[User, str | None]:
    """Return the caller and the sensei check for the writes (None for the master).

    Raises:
        UnauthorizedError: Without login.
        ForbiddenError: For anyone but the master and the current sensei.
    """
    user = current_user(event)
    if not user.is_examiner:
        # Guardians are refused without reading the settings.
        rules.manager_check(user, None)
    sensei = None if user.is_master else settings_repo.get_sensei_user_id()
    return user, rules.manager_check(user, sensei)


def _signature_id(event: Event) -> str:
    return rules.parse_signature_id((event.get("pathParameters") or {}).get("id"))


def _view_of(signatures: rules.Signatures, signature_id: str) -> dict[str, Any]:
    signature = rules.find(signatures, signature_id)
    return rules.signature_view(signature, rules.position_of(signatures, signature_id))


@api_handler
def list_signatures(event: Event, context: Any) -> Response:
    """Return the signatures in certificate order."""
    _authorize(event)
    return json_response(200, rules.list_view(signature_repo.get_signatures().signatures))


@api_handler
def create_signature(event: Event, context: Any) -> Response:
    """Add a signature (name and graduation) at the last position; the image comes after."""
    user, sensei_check = _authorize(event)
    name, graduation = rules.parse_fields(json_body(event))
    now = dates.utc_now_iso()
    new = rules.Signature(
        id=rules.new_signature_id(),
        name=name,
        graduation=graduation,
        image=None,
        updated_at=now,
        updated_by=user.sub,
    )
    stored = signature_repo.update_signatures(
        lambda current: rules.add(current, new),
        sensei_check=sensei_check,
        now_iso=now,
        user_sub=user.sub,
    )
    logger.info("Signature %s created by %s", new.id, user.sub)
    return json_response(201, _view_of(stored, new.id))


@api_handler
def update_signature(event: Event, context: Any) -> Response:
    """Replace the name and graduation, keeping the image and the position."""
    user, sensei_check = _authorize(event)
    signature_id = _signature_id(event)
    name, graduation = rules.parse_fields(json_body(event))
    now = dates.utc_now_iso()
    stored = signature_repo.update_signatures(
        lambda current: rules.edit(
            current,
            signature_id,
            name=name,
            graduation=graduation,
            now_iso=now,
            user_sub=user.sub,
        ),
        sensei_check=sensei_check,
        now_iso=now,
        user_sub=user.sub,
    )
    logger.info("Signature %s edited by %s", signature_id, user.sub)
    return json_response(200, _view_of(stored, signature_id))


@api_handler
def reorder_signatures(event: Event, context: Any) -> Response:
    """Set the certificate order; ``ids`` must list every stored signature once."""
    user, sensei_check = _authorize(event)
    ids = rules.parse_order(json_body(event))
    stored = signature_repo.update_signatures(
        lambda current: rules.reorder(current, ids),
        sensei_check=sensei_check,
        now_iso=dates.utc_now_iso(),
        user_sub=user.sub,
    )
    logger.info("Signatures reordered by %s", user.sub)
    return json_response(200, rules.list_view(stored))


@api_handler
def delete_signature(event: Event, context: Any) -> Response:
    """Remove a signature and its image; an id already gone also answers 204."""
    user, sensei_check = _authorize(event)
    signature_id = _signature_id(event)
    signature_repo.update_signatures(
        lambda current: rules.remove(current, signature_id),
        sensei_check=sensei_check,
        now_iso=dates.utc_now_iso(),
        user_sub=user.sub,
    )
    # Always, even when the signature was already gone: a removal whose S3
    # call failed is completed by repeating it.
    image_repo.delete_image(rules.signature_key(signature_id))
    logger.info("Signature %s removed by %s", signature_id, user.sub)
    return no_content()


@api_handler
def put_signature_image(event: Event, context: Any) -> Response:
    """Validate the image (type from its bytes, at most 2 MB) and attach it to the signature."""
    user, sensei_check = _authorize(event)
    signature_id = _signature_id(event)
    image = image_rules.parse_image_upload(json_body(event))
    # Nothing goes to S3 for a signature that does not exist.
    rules.find(signature_repo.get_signatures().signatures, signature_id)
    key = rules.signature_key(signature_id)
    disposition = image_rules.content_disposition(image.content_type, rules.SIGNATURE_FILENAME)
    image_repo.put_image(key, image, disposition)
    now = dates.utc_now_iso()
    meta = ImageMeta(
        content_type=image.content_type, size=image.size, updated_at=now, updated_by=user.sub
    )
    try:
        stored = signature_repo.update_signatures(
            lambda current: rules.set_image(
                current, signature_id, meta, now_iso=now, user_sub=user.sub
            ),
            sensei_check=sensei_check,
            now_iso=now,
            user_sub=user.sub,
        )
    except NotFoundError:
        # Removed between the check and the write: drop the object just sent.
        image_repo.delete_image(key)
        raise
    logger.info("Signature %s image replaced by %s (%d bytes)", signature_id, user.sub, image.size)
    return json_response(200, _view_of(stored, signature_id))


@api_handler
def delete_signature_image(event: Event, context: Any) -> Response:
    """Remove the signature's image; a signature without image also answers 204."""
    user, sensei_check = _authorize(event)
    signature_id = _signature_id(event)
    now = dates.utc_now_iso()
    signature_repo.update_signatures(
        lambda current: rules.set_image(
            current, signature_id, None, now_iso=now, user_sub=user.sub
        ),
        sensei_check=sensei_check,
        now_iso=now,
        user_sub=user.sub,
    )
    image_repo.delete_image(rules.signature_key(signature_id))
    logger.info("Signature %s image removed by %s", signature_id, user.sub)
    return no_content()


@api_handler
def get_signature_image(event: Event, context: Any) -> Response:
    """Return a short-lived URL to the signature's image, never the bytes nor a public URL."""
    _authorize(event)
    signature_id = _signature_id(event)
    signatures = signature_repo.get_signatures().signatures
    signature = rules.find(signatures, signature_id)
    if signature.image is None:
        raise NotFoundError(rules.MSG_SIGNATURE_IMAGE_NOT_FOUND)
    meta = signature.image
    url = image_repo.presigned_get_url(
        rules.signature_key(signature_id),
        PRESIGNED_URL_SECONDS,
        meta.content_type,
        image_rules.content_disposition(meta.content_type, rules.SIGNATURE_FILENAME),
    )
    return json_response(
        200,
        {
            "id": signature_id,
            "position": rules.position_of(signatures, signature_id),
            **meta.to_dict(),
            "url": url,
            "expires_in": PRESIGNED_URL_SECONDS,
        },
    )
