"""Edge cases of the academy settings and the examiners selector (§ 3.7, § 6.6).

Complements ``test_settings.py``: Unicode at the exact limits, every non-string
type on every field, sensei ids that are not a ``sub``, the seed sharing the
table, and the public fields of ``GET /examiners``. ``PUT`` runs as ``MASTER``
by default: only the master chooses the sensei (decision of 2026-11-02).
"""

import os
from typing import Any

import boto3
import pytest
from conftest import EXAMINER, GUARDIAN, MASTER, add_user, api_event, response_json

from domain.settings import MSG_SENSEI_NOT_ACTIVE_EXAMINER, SETTINGS_ID
from domain.users import ADMIN_GROUP, GUARDIAN_GROUP
from handlers import seed as seed_handler
from handlers import settings as handlers
from handlers import users as user_handlers
from repository.requirements import SEED_MARKER_ID

TEXT_FIELDS = [
    ("academy_name", 255),
    ("certificate_city", 80),
]


def _payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"academy_name": "Tomiyama"}
    payload.update(overrides)
    return payload


def _put(body: Any, user: Any = MASTER) -> dict[str, Any]:
    return handlers.update_settings(api_event(user, body=body), None)


def _table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])


def _item(item_id: str) -> dict[str, Any] | None:
    return _table().get_item(Key={"id": item_id}).get("Item")


@pytest.mark.parametrize(("field", "max_len"), TEXT_FIELDS)
@pytest.mark.parametrize("char", ["Ç", "日", "\U0001f94b"], ids=["accent", "cjk", "emoji"])
def test_put_settings_unicode_at_the_exact_limit(
    user_pool: str, field: str, max_len: int, char: str
) -> None:
    accepted = _put(_payload(**{field: char * max_len}))
    assert accepted["statusCode"] == 200, accepted["body"]
    assert response_json(accepted)[field] == char * max_len

    rejected = _put(_payload(**{field: char * (max_len + 1)}))
    assert rejected["statusCode"] == 400
    assert response_json(rejected)["message"].endswith(f"máximo de {max_len} caracteres")


def test_put_settings_limit_is_counted_after_the_trim(user_pool: str) -> None:
    response = _put(_payload(academy_name="   " + "a" * 255 + "\t\n "))

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["academy_name"] == "a" * 255


@pytest.mark.parametrize("value", [123, 1.5, True, False, [], ["x"], {}, {"a": 1}])
@pytest.mark.parametrize(
    "field",
    ["academy_name", "sensei_user_id", "certificate_city"],
)
def test_put_settings_rejects_every_non_string_type(user_pool: str, field: str, value: Any) -> None:
    response = _put(_payload(**{field: value}))

    assert response["statusCode"] == 400, response["body"]
    assert response_json(response)["message"].endswith(": valor inválido")
    assert _item(SETTINGS_ID) is None


def test_put_settings_by_guardian_writes_nothing(user_pool: str) -> None:
    response = _put(_payload(), user=GUARDIAN)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": "Esta área é dos examinadores"}
    assert _item(SETTINGS_ID) is None


def test_rn008_sensei_must_be_active_examiner_padded_id_is_trimmed(user_pool: str) -> None:
    sub = add_user(user_pool, "sensei@example.com", name="Sensei")

    response = _put(_payload(sensei_user_id=f"  {sub}  "))

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["sensei_user_id"] == sub


def test_rn008_sensei_must_be_active_examiner_email_is_not_an_id(user_pool: str) -> None:
    add_user(user_pool, "sensei@example.com", name="Sensei")

    response = _put(_payload(sensei_user_id="sensei@example.com"))

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_SENSEI_NOT_ACTIVE_EXAMINER}
    assert _item(SETTINGS_ID) is None


def test_rn008_sensei_must_be_active_examiner_also_guardian_is_accepted(user_pool: str) -> None:
    sub = add_user(user_pool, "duplo@example.com", groups=(ADMIN_GROUP, GUARDIAN_GROUP))

    assert _put(_payload(sensei_user_id=sub))["statusCode"] == 200


def test_seed_and_settings_share_the_table_without_interfering(user_pool: str) -> None:
    assert _put(_payload(certificate_city="Araraquara"))["statusCode"] == 200

    seed_handler.seed_all()
    assert _item(SEED_MARKER_ID)
    assert _item(SETTINGS_ID)["certificate_city"] == "Araraquara"  # type: ignore[index]

    assert _put(_payload(academy_name="Nova"))["statusCode"] == 200
    assert _item(SEED_MARKER_ID)
    assert response_json(handlers.get_settings(api_event(EXAMINER), None))["academy_name"] == "Nova"


def test_list_examiners_exposes_only_public_fields(user_pool: str) -> None:
    add_user(user_pool, "ana@example.com", name="Ana")
    add_user(user_pool, "pai@example.com", groups=(GUARDIAN_GROUP,))

    body = response_json(user_handlers.list_examiners(api_event(EXAMINER), None))

    assert [set(examiner) for examiner in body] == [{"id", "email", "name"}]


def test_list_examiners_empty_group(user_pool: str) -> None:
    response = user_handlers.list_examiners(api_event(EXAMINER), None)

    assert response["statusCode"] == 200
    assert response_json(response) == []


def test_list_examiners_homonyms_and_missing_name(user_pool: str) -> None:
    add_user(user_pool, "b@example.com", name="Érica")
    add_user(user_pool, "a@example.com", name="Erica")
    add_user(user_pool, "z@example.com")
    add_user(user_pool, "c@example.com", name="carla")

    body = response_json(user_handlers.list_examiners(api_event(EXAMINER), None))

    assert [examiner["name"] for examiner in body] == ["carla", "Erica", "Érica", None]
