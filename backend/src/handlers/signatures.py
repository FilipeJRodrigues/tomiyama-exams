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

Image writes. Every upload goes to a new key ``signatures/{id}/{uuid}`` chosen
here (never by the client), so no request ever writes over the object another
one registered:

1. the upload writes the object at the new key;
2. then the metadata, with that key, in the transaction that checks the list
   version and the sensei;
3. if the transaction succeeds, the key it replaced is deleted. If the call
   fails, ``signature_repo.is_definitive_write_failure`` decides: a definitive
   failure (403, 404, 409, 503 throttling, validation: nothing was written)
   deletes the new key; an ambiguous one (``InternalServerError``, 5xx,
   connection lost after sending, anything unknown) never deletes it, not even
   after a re-read, because a transaction still in flight may commit later.
   The key is only logged as a possible orphan.

The removals (of the image or of the signature) delete the metadata in the
transaction first and the recorded key after. If the removal fails
definitively, the metadata still point to the key read before it, so nothing
is deleted. If it fails ambiguously, that key is deleted only if a strong
re-read shows the metadata no longer point to it (the transaction committed
and the answer was lost); if the re-read fails too, nothing is deleted.

The cleanups never change the response: a failure is logged and leaves an
object without metadata (invisible to the API). Orphans may be left; metadata
never point to a missing object.
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


def _discard(key: str | None, reason: str) -> None:
    """Delete an object no longer (or never) referenced; a failure is only logged.

    The object left behind has no metadata, so the API never shows it.
    """
    if key is None:
        return
    try:
        image_repo.delete_image(key)
    except Exception:
        logger.exception("Signature image %s left behind (%s)", key, reason)


def _keep_possible_orphan(key: str, reason: str) -> None:
    """Log a key kept after an ambiguous failure: it may be recorded, or an orphan."""
    logger.error(
        "Signature image %s kept, possible orphan: the write may be recorded (%s)", key, reason
    )


def _discard_unless_referenced(key: str | None, reason: str) -> None:
    """After an ambiguous removal failure, delete ``key`` only if no metadata point to it.

    The failed call may have committed, so the list is re-read (strongly
    consistent) first. If the re-read fails too, the object is kept: an orphan
    is acceptable, metadata pointing to a deleted object are not. A removal
    cannot make metadata point to ``key`` later, so a commit still in flight
    is harmless here.
    """
    if key is None:
        return
    try:
        current = signature_repo.get_signatures().signatures
    except Exception:
        logger.exception(
            "Signature image %s kept: list not re-read after a failure (%s)", key, reason
        )
        return
    if rules.references_key(current, key):
        logger.warning("Signature image %s kept: still referenced (%s)", key, reason)
        return
    _discard(key, reason)


def _after_failed_removal(exc: Exception, seen: str | None, reason: str) -> None:
    """Clean up after a removal that raised: never the key metadata may still point to."""
    if signature_repo.is_definitive_write_failure(exc):
        return  # nothing written: the metadata still point to ``seen``
    _discard_unless_referenced(seen, f"{reason}: {type(exc).__name__}")


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
    # The key as read now, to clean up if the call fails after committing.
    seen = rules.image_key_of(signature_repo.get_signatures().signatures, signature_id)
    try:
        before, _ = signature_repo.apply_signatures(
            lambda current: rules.remove(current, signature_id),
            sensei_check=sensei_check,
            now_iso=dates.utc_now_iso(),
            user_sub=user.sub,
        )
    except Exception as exc:
        _after_failed_removal(exc, seen, "signature removal failed")
        raise
    # Metadata first, then the key they recorded (None if already gone).
    _discard(rules.image_key_of(before, signature_id), "signature removed")
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
    key = rules.new_image_key(signature_id)
    disposition = image_rules.content_disposition(image.content_type, rules.SIGNATURE_FILENAME)
    image_repo.put_image(key, image, disposition)
    now = dates.utc_now_iso()
    meta = ImageMeta(
        content_type=image.content_type, size=image.size, updated_at=now, updated_by=user.sub
    )
    try:
        before, stored = signature_repo.apply_signatures(
            lambda current: rules.set_image(
                current, signature_id, meta, image_key=key, now_iso=now, user_sub=user.sub
            ),
            sensei_check=sensei_check,
            now_iso=now,
            user_sub=user.sub,
        )
    except Exception as exc:
        # Refused for sure (signature removed, sensei replaced, list busy,
        # throttled...): nothing points to the object just sent. Otherwise the
        # transaction may be recorded, now or later: keep it. Keep the error.
        if signature_repo.is_definitive_write_failure(exc):
            _discard(key, "upload refused")
        else:
            _keep_possible_orphan(key, f"upload failed: {type(exc).__name__}")
        raise
    previous = rules.image_key_of(before, signature_id)
    if previous != key:
        _discard(previous, "image replaced")
    logger.info("Signature %s image replaced by %s (%d bytes)", signature_id, user.sub, image.size)
    return json_response(200, _view_of(stored, signature_id))


@api_handler
def delete_signature_image(event: Event, context: Any) -> Response:
    """Remove the signature's image; a signature without image also answers 204."""
    user, sensei_check = _authorize(event)
    signature_id = _signature_id(event)
    now = dates.utc_now_iso()
    # The key as read now, to clean up if the call fails after committing.
    seen = rules.image_key_of(signature_repo.get_signatures().signatures, signature_id)
    try:
        before, _ = signature_repo.apply_signatures(
            lambda current: rules.set_image(
                current, signature_id, None, image_key=None, now_iso=now, user_sub=user.sub
            ),
            sensei_check=sensei_check,
            now_iso=now,
            user_sub=user.sub,
        )
    except Exception as exc:
        _after_failed_removal(exc, seen, "image removal failed")
        raise
    # Metadata first, then the key they recorded (None if there was no image).
    _discard(rules.image_key_of(before, signature_id), "image removed")
    logger.info("Signature %s image removed by %s", signature_id, user.sub)
    return no_content()


@api_handler
def get_signature_image(event: Event, context: Any) -> Response:
    """Return a short-lived URL to the signature's image, never the bytes nor a public URL."""
    _authorize(event)
    signature_id = _signature_id(event)
    signatures = signature_repo.get_signatures().signatures
    signature = rules.find(signatures, signature_id)
    if signature.image is None or signature.image_key is None:
        raise NotFoundError(rules.MSG_SIGNATURE_IMAGE_NOT_FOUND)
    meta = signature.image
    url = image_repo.presigned_get_url(
        signature.image_key,
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
