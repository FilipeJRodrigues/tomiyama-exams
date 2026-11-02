"""Persistence of the academy settings: one item (``id = "academy"``) in ``Settings``.

The same table keeps markers such as the initial-data load
(``repository.requirements.SEED_MARKER_ID``) under other ids.

Saving uses ``UpdateItem`` only on the model's text fields, so attributes kept
by other writers (the images of the next step) are never lost.

Only the admin master changes the sensei: for anyone else the write carries a
condition that the stored ``sensei_user_id`` equals the one sent, so a change
made between any earlier read and this write is still caught.
"""

import logging
from typing import Any

from botocore.exceptions import ClientError

from domain.errors import MSG_SERVICE_BUSY, ForbiddenError, ServiceUnavailableError
from domain.settings import MSG_ONLY_MASTER_CHOOSES_SENSEI, SETTINGS_ID, AcademySettings
from repository.tables import SETTINGS_TABLE_ENV, THROTTLING_ERRORS, replace_fields, table

logger = logging.getLogger(__name__)

_CREATED_AT = "created_at"
_SENSEI = "sensei_user_id"


def _from_item(item: dict[str, Any]) -> AcademySettings:
    return AcademySettings(
        academy_name=item.get("academy_name"),
        sensei_user_id=item.get("sensei_user_id"),
        certificate_city=item.get("certificate_city"),
        created_at=item.get(_CREATED_AT),
        updated_at=item.get("updated_at"),
    )


def _raise_busy(exc: ClientError) -> None:
    """Turn throttling that outlasted botocore's retries into a 503; ignore other errors."""
    code = exc.response["Error"]["Code"]
    if code in THROTTLING_ERRORS:
        logger.warning("Settings table throttled after botocore retries: %s", code)
        raise ServiceUnavailableError(MSG_SERVICE_BUSY) from exc


def get_settings() -> AcademySettings | None:
    """Return the settings, or None before the first save.

    Raises:
        ServiceUnavailableError: If the table kept throttling.
    """
    try:
        item = table(SETTINGS_TABLE_ENV).get_item(Key={"id": SETTINGS_ID}).get("Item")
    except ClientError as exc:
        _raise_busy(exc)
        raise
    return _from_item(item) if item else None


def save_settings(settings: AcademySettings, *, keep_sensei: bool = False) -> AcademySettings:
    """Replace the text fields, creating the record on the first save.

    Fields set to None are removed. ``created_at`` is written only once
    (``if_not_exists``); unknown attributes of the item are kept.

    Args:
        settings: New text fields.
        keep_sensei: True for callers who may not change the sensei (anyone
            but the master): the write only happens if the stored
            ``sensei_user_id`` equals ``settings.sensei_user_id`` (both absent
            counts as equal), checked atomically by DynamoDB.

    Returns:
        The stored settings.

    Raises:
        ForbiddenError: If ``keep_sensei`` and the stored sensei differs.
        ServiceUnavailableError: If the table kept throttling.
    """
    fields = {key: value for key, value in settings.to_dict().items() if key != _CREATED_AT}
    update = replace_fields({"id": SETTINGS_ID, **fields})
    update["UpdateExpression"] = update["UpdateExpression"].replace(
        "SET ", "SET #created = if_not_exists(#created, :created), ", 1
    )
    update["ExpressionAttributeNames"]["#created"] = _CREATED_AT
    update["ExpressionAttributeValues"][":created"] = settings.updated_at
    if keep_sensei:
        update["ExpressionAttributeNames"]["#sensei"] = _SENSEI
        if settings.sensei_user_id is None:
            update["ConditionExpression"] = "attribute_not_exists(#sensei)"
        else:
            update["ConditionExpression"] = "#sensei = :same_sensei"
            update["ExpressionAttributeValues"][":same_sensei"] = settings.sensei_user_id
    try:
        response = table(SETTINGS_TABLE_ENV).update_item(**update, ReturnValues="ALL_NEW")
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # The condition only covers the sensei, so it is the difference.
            raise ForbiddenError(MSG_ONLY_MASTER_CHOOSES_SENSEI) from exc
        _raise_busy(exc)
        raise
    return _from_item(response["Attributes"])
