"""Edge cases of the admin master rule (decision of 2026-11-02).

Complements ``test_settings_master.py``: the master changing the sensei
between null and a value while another examiner's write is in flight, a blank
sensei sent by a non-master, and more shapes of the ``cognito:groups`` claim.
"""

import os
from typing import Any

import boto3
import pytest
from conftest import EXAMINER, MASTER, add_user, api_event, response_json

from domain.settings import MSG_ONLY_MASTER_CHOOSES_SENSEI, SETTINGS_ID
from handlers import settings as handlers
from handlers.http import current_user
from repository import settings as settings_repo

FORBIDDEN_SENSEI = {"message": MSG_ONLY_MASTER_CHOOSES_SENSEI}


def _payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"academy_name": "Tomiyama", "sensei_user_id": None}
    payload.update(overrides)
    return payload


def _put(body: Any, user: Any) -> dict[str, Any]:
    return handlers.update_settings(api_event(user, body=body), None)


def _stored() -> dict[str, Any] | None:
    table = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    return table.get_item(Key={"id": SETTINGS_ID}).get("Item")


@pytest.mark.parametrize("direction", ["null-to-value", "value-to-null", "empty-to-value"])
def test_rn008_only_master_chooses_sensei_race_between_null_and_value(
    user_pool: str, monkeypatch: pytest.MonkeyPatch, direction: str
) -> None:
    # The master writes right before the examiner's conditional write.
    sensei = add_user(user_pool, "s@example.com")
    if direction == "value-to-null":
        assert _put(_payload(sensei_user_id=sensei), MASTER)["statusCode"] == 200
        examiner_sends, master_sets = sensei, None
    else:
        if direction == "null-to-value":
            assert _put(_payload(), MASTER)["statusCode"] == 200
        examiner_sends, master_sets = None, sensei
    real_save = settings_repo.save_settings

    def master_writes_first(settings: Any, *, keep_sensei: bool = False) -> Any:
        monkeypatch.setattr(settings_repo, "save_settings", real_save)
        master = _put(_payload(academy_name="Master", sensei_user_id=master_sets), MASTER)
        assert master["statusCode"] == 200
        return real_save(settings, keep_sensei=keep_sensei)

    monkeypatch.setattr(settings_repo, "save_settings", master_writes_first)

    response = _put(_payload(academy_name="Examinador", sensei_user_id=examiner_sends), EXAMINER)

    assert response["statusCode"] == 403, response["body"]
    assert response_json(response) == FORBIDDEN_SENSEI
    stored = _stored()
    assert stored is not None
    assert stored.get("sensei_user_id") == master_sets
    assert stored["academy_name"] == "Master"


def test_rn008_only_master_chooses_sensei_blank_from_examiner_is_null(user_pool: str) -> None:
    sensei = add_user(user_pool, "s@example.com")
    assert _put(_payload(), MASTER)["statusCode"] == 200
    assert _put(_payload(sensei_user_id="   "), EXAMINER)["statusCode"] == 200

    assert _put(_payload(sensei_user_id=sensei), MASTER)["statusCode"] == 200
    response = _put(_payload(sensei_user_id="  "), EXAMINER)

    assert response["statusCode"] == 403
    assert response_json(response) == FORBIDDEN_SENSEI
    assert _stored()["sensei_user_id"] == sensei  # type: ignore[index]


@pytest.mark.parametrize(
    ("raw", "master"),
    [
        ("admin,master", True),
        ("[admin, master]", True),
        ("  [ admin   master ]  ", True),
        ("admin master", True),
        ("[adminmaster]", False),
        ("[Admin Master]", False),
        ("[admin masterx]", False),
        ("[xadmin master]", False),
        (["master"], False),
        (["admin master"], False),
        ("", False),
        ("[]", False),
        ([], False),
    ],
)
def test_current_user_master_claim_shapes(raw: Any, master: bool) -> None:
    claims = {"sub": "x", "cognito:groups": raw}
    event = {"requestContext": {"authorizer": {"jwt": {"claims": claims}}}}

    assert current_user(event).is_master is master
