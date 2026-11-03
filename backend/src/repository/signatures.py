"""Persistence of the certificate signatures (RN012): one item in the ``Settings`` table.

The item ``id = "certificate_signatures"`` holds the ordered list (``signatures``,
a list of maps) and a ``version`` number. Every change reads the item, builds
the new list with a pure function of ``domain.signatures`` and writes it back
only if ``version`` is still the one read; otherwise it reads again and
re-applies the change. So two requests at the same time never lose a write,
never pass the limit of 3 (the second one sees 3 on the re-read) and never mix
two orders.

The same transaction checks, for the sensei, that the settings still name
them as sensei: a sensei replaced between the permission check and the write
writes nothing. The master skips that check.

The images live in S3 (``repository.images``); the list keeps only their
metadata and the key of each one (``image.key``). ``apply_signatures`` also
returns the list it wrote over, so the caller knows which key stopped being
referenced and may delete it.

Every ``TransactWriteItems`` carries a ``ClientRequestToken``, a new UUID per
write attempt (one per version read). botocore resends the same request on its
own retries, so the token is the same there: if DynamoDB committed the
transaction and the answer was lost, the retry is idempotent (DynamoDB answers
success without writing again, for 10 minutes and the same parameters). A new
attempt after a stale version builds a different write, so it gets a new token.

``is_definitive_write_failure`` tells the caller whether a failed write surely
wrote nothing (it may then delete the object it uploaded) or may have been
recorded, now or later (it must keep every object the metadata may point to).
"""

import logging
import random
import time
import uuid
from collections.abc import Callable
from typing import Any

from botocore.exceptions import ClientError

from domain.errors import (
    MSG_SERVICE_BUSY,
    ConflictError,
    DomainError,
    ForbiddenError,
    ServiceUnavailableError,
)
from domain.settings import SETTINGS_ID
from domain.signatures import (
    EMPTY_LIST,
    MSG_ONLY_MASTER_OR_SENSEI,
    MSG_SIGNATURES_BUSY,
    SIGNATURES_ID,
    Signature,
    SignatureList,
    Signatures,
)
from repository.tables import SETTINGS_TABLE_ENV, THROTTLING_ERRORS, get_item_or_busy, table

logger = logging.getLogger(__name__)

# A change is re-applied on a fresh read this many times before giving up.
_MAX_ATTEMPTS = 5
_BACKOFF_SECONDS = 0.05

_CANCELLED = "TransactionCanceledException"
_CONDITION_FAILED = "ConditionalCheckFailed"
_CONFLICT = "TransactionConflict"
_THROTTLED_REASONS = frozenset({"ThrottlingError", "ProvisionedThroughputExceeded"})


class StaleListError(Exception):
    """The list changed between the read and the write (another request won)."""


# Error codes DynamoDB answers only when it did not apply the request.
_REFUSED_CODES = THROTTLING_ERRORS | {"ValidationException"}
# Cancellation reasons of a transaction that was refused as a whole.
_REFUSED_REASONS = frozenset(
    {"None", _CONDITION_FAILED, _CONFLICT, "ValidationError"} | _THROTTLED_REASONS
)


def is_definitive_write_failure(exc: BaseException) -> bool:
    """Tell whether a failed ``apply_signatures`` surely wrote nothing.

    Definitive (True): the domain errors this module raises (403 sensei
    replaced, 404, 409 after the attempts, 503 throttling, 400 validation),
    ``StaleListError``, throttling and ``ValidationException`` answers, and a
    ``TransactionCanceledException`` whose reasons are all known refusals
    (condition failed, conflict, throttling, validation). None of them is
    raised after a send whose outcome is unknown: ambiguous errors propagate
    unchanged.

    Ambiguous (False), the transaction may have been recorded:
    ``InternalServerError``, ``ServiceUnavailable`` and other DynamoDB codes,
    connection errors (closed, read timeout, endpoint unreachable, also after
    botocore's retries) and any other exception.
    """
    if isinstance(exc, DomainError | StaleListError):
        return True
    if not isinstance(exc, ClientError):
        return False
    code = exc.response.get("Error", {}).get("Code")
    if code in _REFUSED_CODES:
        return True
    if code != _CANCELLED:
        return False
    reasons = [reason.get("Code") for reason in exc.response.get("CancellationReasons") or []]
    return bool(reasons) and all(reason in _REFUSED_REASONS for reason in reasons)


def get_signatures() -> SignatureList:
    """Return the stored list, strongly consistent (empty, version 0, before the first write).

    Raises:
        ServiceUnavailableError: If the table kept throttling.
    """
    item = get_item_or_busy(table(SETTINGS_TABLE_ENV), {"id": SIGNATURES_ID}, ConsistentRead=True)
    if not item:
        return EMPTY_LIST
    return SignatureList(
        version=int(item.get("version", 0)),
        signatures=tuple(Signature.from_item(entry) for entry in item.get("signatures", [])),
    )


def _transaction(
    current: SignatureList,
    signatures: Signatures,
    *,
    sensei_check: str | None,
    now_iso: str,
    user_sub: str,
) -> list[dict[str, Any]]:
    """Build the write: optional sensei check, then the list with its version condition."""
    name = table(SETTINGS_TABLE_ENV).name
    items: list[dict[str, Any]] = []
    if sensei_check is not None:
        items.append(
            {
                "ConditionCheck": {
                    "TableName": name,
                    "Key": {"id": SETTINGS_ID},
                    "ConditionExpression": "#sensei = :me",
                    "ExpressionAttributeNames": {"#sensei": "sensei_user_id"},
                    "ExpressionAttributeValues": {":me": sensei_check},
                }
            }
        )
    put: dict[str, Any] = {
        "TableName": name,
        "Item": {
            "id": SIGNATURES_ID,
            "version": current.version + 1,
            "signatures": [item.to_item() for item in signatures],
            "updated_at": now_iso,
            "updated_by": user_sub,
        },
    }
    if current.version == 0:
        put["ConditionExpression"] = "attribute_not_exists(id)"
    else:
        put["ConditionExpression"] = "#version = :version"
        put["ExpressionAttributeNames"] = {"#version": "version"}
        put["ExpressionAttributeValues"] = {":version": current.version}
    items.append({"Put": put})
    return items


def _write(
    current: SignatureList,
    signatures: Signatures,
    *,
    sensei_check: str | None,
    now_iso: str,
    user_sub: str,
) -> None:
    """Write the new list if it is still at ``current.version``.

    Raises:
        StaleListError: If the version changed (or the transaction conflicted).
        ForbiddenError: If ``sensei_check`` is no longer the sensei.
        ServiceUnavailableError: If the table kept throttling.
    """
    items = _transaction(
        current, signatures, sensei_check=sensei_check, now_iso=now_iso, user_sub=user_sub
    )
    # One token per logical write: botocore's retries reuse it (idempotent if
    # the first try committed); the next version attempt builds a new one.
    token = str(uuid.uuid4())
    try:
        table(SETTINGS_TABLE_ENV).meta.client.transact_write_items(
            TransactItems=items, ClientRequestToken=token
        )
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        if code in THROTTLING_ERRORS:
            logger.warning("Signatures transaction throttled after botocore retries: %s", code)
            raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc
        if code != _CANCELLED:
            raise
        reasons = [reason.get("Code") for reason in exc.response.get("CancellationReasons", [])]
        if sensei_check is not None and reasons and reasons[0] == _CONDITION_FAILED:
            raise ForbiddenError(MSG_ONLY_MASTER_OR_SENSEI) from exc
        if _THROTTLED_REASONS.intersection(reasons):
            raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc
        if _CONDITION_FAILED in reasons or _CONFLICT in reasons:
            raise StaleListError from exc
        raise


def update_signatures(
    change: Callable[[Signatures], Signatures],
    *,
    sensei_check: str | None,
    now_iso: str,
    user_sub: str,
) -> Signatures:
    """Apply ``change`` to the stored list and write the result atomically.

    Same as ``apply_signatures``, returning only the list as written.
    """
    _, written = apply_signatures(
        change, sensei_check=sensei_check, now_iso=now_iso, user_sub=user_sub
    )
    return written


def apply_signatures(
    change: Callable[[Signatures], Signatures],
    *,
    sensei_check: str | None,
    now_iso: str,
    user_sub: str,
) -> tuple[Signatures, Signatures]:
    """Apply ``change`` to the stored list and write the result atomically.

    ``change`` runs on a fresh read on every attempt, so its rules (limit of 3,
    signature exists, order matches the stored ids) are always checked against
    the list that is actually written over. A change that returns the list
    unchanged writes nothing.

    Args:
        change: Pure function from the current list to the new one; may raise
            a DomainError, which is propagated as is.
        sensei_check: ``sub`` of the sensei to re-check in the transaction, or
            None for the master.
        now_iso: Time of the write.
        user_sub: Who writes.

    Returns:
        ``(before, after)``: the list the write replaced (read in the attempt
        that succeeded) and the list as written; equal when nothing changed.

    Raises:
        DomainError: Whatever ``change`` raised on the fresh list.
        ForbiddenError: If the caller stopped being the sensei meanwhile.
        ConflictError: If other writes kept winning on every attempt.
        ServiceUnavailableError: If the table kept throttling.
    """
    for attempt in range(_MAX_ATTEMPTS):
        current = get_signatures()
        signatures = change(current.signatures)
        if signatures == current.signatures:
            return current.signatures, signatures
        try:
            _write(
                current, signatures, sensei_check=sensei_check, now_iso=now_iso, user_sub=user_sub
            )
            return current.signatures, signatures
        except StaleListError:
            logger.info("Signatures changed meanwhile; retry %d", attempt + 1)
            if attempt + 1 < _MAX_ATTEMPTS:
                time.sleep(_BACKOFF_SECONDS * 2**attempt * (1 + random.random()))
    raise ConflictError(MSG_SIGNATURES_BUSY)
