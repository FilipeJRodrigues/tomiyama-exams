"""Admin master (decision of 2026-11-02): only the master chooses the sensei.

``PUT /settings`` stays open to every examiner, but changing ``sensei_user_id``
(including setting the first one or removing it) needs the groups ``admin``
and ``master``. Resending the stored value is accepted, checked atomically by
a DynamoDB condition. The master does not decide exams: RN008 stays "only the
sensei", hence the ``test_rn008_only_master_chooses_sensei_*`` names.
"""

import os
from typing import Any

import boto3
import pytest
from conftest import EXAMINER, MASTER, add_user, api_event, response_json

from domain.errors import ForbiddenError
from domain.settings import (
    MSG_ONLY_MASTER_CHOOSES_SENSEI,
    MSG_SENSEI_NOT_ACTIVE_EXAMINER,
    SETTINGS_ID,
)
from domain.users import ADMIN_GROUP, MASTER_GROUP, User
from handlers import settings as handlers
from handlers import users as user_handlers
from handlers.http import MSG_MASTER_ONLY, current_user, require_master
from repository import users as user_repo

FORBIDDEN_SENSEI = {"message": MSG_ONLY_MASTER_CHOOSES_SENSEI}


def _payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "academy_name": "Associação Tomiyama de Judô",
        "sensei_user_id": None,
        "certificate_city": "Araraquara",
    }
    payload.update(overrides)
    return payload


def _put(body: Any, user: User) -> dict[str, Any]:
    return handlers.update_settings(api_event(user, body=body), None)


def _table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])


def _stored() -> dict[str, Any] | None:
    return _table().get_item(Key={"id": SETTINGS_ID}).get("Item")


def _claims_event(groups: Any) -> dict[str, Any]:
    claims: dict[str, Any] = {"sub": "abc"}
    if groups is not None:
        claims["cognito:groups"] = groups
    return {"requestContext": {"authorizer": {"jwt": {"claims": claims}}}}


# --- current_user / require_master ----------------------------------------------


@pytest.mark.parametrize(
    ("groups", "examiner", "master"),
    [
        ("[admin master]", True, True),
        ("[master admin]", True, True),
        (["admin", "master"], True, True),
        ('["admin","master"]', True, True),
        ("[admin]", True, False),
        # A member of ``master`` alone is a misconfiguration, not a master.
        ("[master]", False, False),
        ("[master responsavel]", False, False),
        ("[responsavel]", False, False),
        (None, False, False),
    ],
)
def test_current_user_exposes_master(groups: Any, examiner: bool, master: bool) -> None:
    user = current_user(_claims_event(groups))

    assert user.is_examiner is examiner
    assert user.is_master is master


def test_require_master_allows_only_the_master() -> None:
    require_master(MASTER)

    with pytest.raises(ForbiddenError) as default:
        require_master(EXAMINER)
    with pytest.raises(ForbiddenError) as custom:
        require_master(User("x", None, frozenset({MASTER_GROUP})), "Outra mensagem")

    assert default.value.message == MSG_MASTER_ONLY
    assert default.value.status_code == 403
    assert custom.value.message == "Outra mensagem"


def test_master_without_admin_cannot_reach_settings(user_pool: str) -> None:
    only_master = User("m2", "m2@example.com", frozenset({MASTER_GROUP}))

    response = _put(_payload(), only_master)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": "Esta área é dos examinadores"}
    assert _stored() is None


# --- rule B: the master chooses the sensei ------------------------------------------


def test_rn008_only_master_chooses_sensei_master_sets_changes_and_removes(user_pool: str) -> None:
    first = add_user(user_pool, "a@example.com", name="A")
    second = add_user(user_pool, "b@example.com", name="B")

    for sensei in (first, second, None):
        response = _put(_payload(sensei_user_id=sensei), MASTER)
        assert response["statusCode"] == 200, response["body"]
        assert response_json(response)["sensei_user_id"] == sensei
        assert (_stored() or {}).get("sensei_user_id") == sensei


@pytest.mark.parametrize("previous", ["none", "other"], ids=["first-sensei", "change"])
def test_rn008_only_master_chooses_sensei_examiner_cannot_set(
    user_pool: str, previous: str
) -> None:
    current = add_user(user_pool, "atual@example.com")
    wanted = add_user(user_pool, "novo@example.com")
    initial = _payload(sensei_user_id=current if previous == "other" else None)
    assert _put(initial, MASTER)["statusCode"] == 200
    before = _stored()

    response = _put(_payload(academy_name="Mudou", sensei_user_id=wanted), EXAMINER)

    assert response["statusCode"] == 403
    assert response_json(response) == FORBIDDEN_SENSEI
    assert _stored() == before


def test_rn008_only_master_chooses_sensei_examiner_cannot_set_on_empty_table(
    user_pool: str,
) -> None:
    wanted = add_user(user_pool, "novo@example.com")

    response = _put(_payload(sensei_user_id=wanted), EXAMINER)

    assert response["statusCode"] == 403
    assert response_json(response) == FORBIDDEN_SENSEI
    assert _stored() is None


def test_rn008_only_master_chooses_sensei_examiner_cannot_remove(user_pool: str) -> None:
    current = add_user(user_pool, "atual@example.com")
    assert _put(_payload(sensei_user_id=current), MASTER)["statusCode"] == 200
    before = _stored()

    response = _put(_payload(academy_name="Mudou", sensei_user_id=None), EXAMINER)

    assert response["statusCode"] == 403
    assert response_json(response) == FORBIDDEN_SENSEI
    assert _stored() == before


def test_rn008_only_master_chooses_sensei_examiner_resends_same_sensei(user_pool: str) -> None:
    current = add_user(user_pool, "atual@example.com", name="Atual")
    assert _put(_payload(sensei_user_id=current), MASTER)["statusCode"] == 200

    # The form sends every field, padded or not.
    response = _put(_payload(academy_name="Mudou", sensei_user_id=f" {current} "), EXAMINER)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["academy_name"] == "Mudou"
    assert body["sensei"]["id"] == current
    assert _stored()["academy_name"] == "Mudou"  # type: ignore[index]


def test_rn008_only_master_chooses_sensei_examiner_resends_inactive_sensei(
    user_pool: str,
) -> None:
    # The stored sensei was disabled after the choice: the other examiners
    # must still be able to save the rest of the form, which resends it.
    current = add_user(user_pool, "atual@example.com", name="Atual")
    assert _put(_payload(sensei_user_id=current), MASTER)["statusCode"] == 200
    boto3.client("cognito-idp").admin_disable_user(
        UserPoolId=user_pool, Username="atual@example.com"
    )

    response = _put(_payload(certificate_city="São Carlos", sensei_user_id=current), EXAMINER)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["certificate_city"] == "São Carlos"
    assert body["sensei"] == {
        "id": current,
        "email": "atual@example.com",
        "name": "Atual",
        "active": False,
    }
    stored = _stored()
    assert stored is not None
    assert stored["certificate_city"] == "São Carlos"
    assert stored["sensei_user_id"] == current


@pytest.mark.parametrize("case", ["unknown", "disabled"])
def test_rn008_only_master_chooses_sensei_examiner_sends_other_invalid_sensei(
    user_pool: str, case: str
) -> None:
    # Without the master's validation, a different sensei is refused by the
    # ownership rule (403), whether or not it would be a valid examiner.
    current = add_user(user_pool, "atual@example.com")
    assert _put(_payload(sensei_user_id=current), MASTER)["statusCode"] == 200
    before = _stored()
    if case == "unknown":
        wanted = "00000000-0000-0000-0000-000000000000"
    else:
        wanted = add_user(user_pool, "inativo@example.com", enabled=False)

    response = _put(_payload(academy_name="Mudou", sensei_user_id=wanted), EXAMINER)

    assert response["statusCode"] == 403
    assert response_json(response) == FORBIDDEN_SENSEI
    assert _stored() == before


def test_rn008_only_master_chooses_sensei_master_resending_inactive_sensei_is_rejected(
    user_pool: str,
) -> None:
    # The master's choice is always validated, even when it is the stored one.
    current = add_user(user_pool, "atual@example.com")
    assert _put(_payload(sensei_user_id=current), MASTER)["statusCode"] == 200
    before = _stored()
    boto3.client("cognito-idp").admin_disable_user(
        UserPoolId=user_pool, Username="atual@example.com"
    )

    response = _put(_payload(academy_name="Mudou", sensei_user_id=current), MASTER)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_SENSEI_NOT_ACTIVE_EXAMINER}
    assert _stored() == before


@pytest.mark.parametrize("existing", [False, True], ids=["empty-table", "saved-without-sensei"])
def test_rn008_only_master_chooses_sensei_examiner_null_to_null(
    user_pool: str, existing: bool
) -> None:
    if existing:
        assert _put(_payload(), MASTER)["statusCode"] == 200

    for body in (_payload(academy_name="Mudou"), {"academy_name": "Mudou"}):
        response = _put(body, EXAMINER)
        assert response["statusCode"] == 200, response["body"]
        assert response_json(response)["sensei"] is None
    assert _stored()["academy_name"] == "Mudou"  # type: ignore[index]


def test_rn008_only_master_chooses_sensei_race_with_the_master(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The examiner's form still shows the old sensei; the master changes it
    # while the request is between validation and the write.
    old = add_user(user_pool, "antigo@example.com")
    new = add_user(user_pool, "novo@example.com")
    assert _put(_payload(sensei_user_id=old), MASTER)["statusCode"] == 200
    real_list = user_repo.list_examiners
    calls = {"count": 0}

    def list_and_race(client: Any = None) -> Any:
        examiners = real_list(client)
        calls["count"] += 1
        if calls["count"] == 1:
            monkeypatch.setattr(user_repo, "list_examiners", real_list)
            assert _put(_payload(sensei_user_id=new), MASTER)["statusCode"] == 200
        return examiners

    monkeypatch.setattr(user_repo, "list_examiners", list_and_race)

    response = _put(_payload(academy_name="Do examinador", sensei_user_id=old), EXAMINER)

    assert calls["count"] == 1
    assert response["statusCode"] == 403
    assert response_json(response) == FORBIDDEN_SENSEI
    stored = _stored()
    assert stored is not None
    assert stored["sensei_user_id"] == new
    assert stored["academy_name"] == "Associação Tomiyama de Judô"


def test_rn008_only_master_chooses_sensei_master_ignores_the_stored_value(
    user_pool: str,
) -> None:
    # The master's write has no condition: the sensei may change under it.
    stale = add_user(user_pool, "a@example.com")
    current = add_user(user_pool, "b@example.com")
    _table().put_item(Item={"id": SETTINGS_ID, "academy_name": "X", "sensei_user_id": current})

    response = _put(_payload(sensei_user_id=stale), MASTER)

    assert response["statusCode"] == 200
    assert _stored()["sensei_user_id"] == stale  # type: ignore[index]


def test_rn008_only_master_chooses_sensei_active_check_still_applies(user_pool: str) -> None:
    disabled = add_user(user_pool, "inativo@example.com", enabled=False)

    response = _put(_payload(sensei_user_id=disabled), MASTER)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_SENSEI_NOT_ACTIVE_EXAMINER}
    assert _stored() is None


def test_rn008_only_master_chooses_sensei_master_is_listed_as_examiner(user_pool: str) -> None:
    sub = add_user(
        user_pool, "master@example.com", name="Master", groups=(ADMIN_GROUP, MASTER_GROUP)
    )

    body = response_json(user_handlers.list_examiners(api_event(EXAMINER), None))
    response = _put(_payload(sensei_user_id=sub), MASTER)

    assert [examiner["id"] for examiner in body] == [sub]
    assert response["statusCode"] == 200, response["body"]


# --- other documented behavior --------------------------------------------------------


def test_sensei_id_length_limit(user_pool: str) -> None:
    response = _put(_payload(sensei_user_id="x" * 129), MASTER)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Sensei: máximo de 128 caracteres"}


def test_examiner_before_first_login_is_listed_as_active(user_pool: str) -> None:
    # admin_create_user leaves the account in FORCE_CHANGE_PASSWORD, as the
    # template does with the first examiner; it is enabled, hence active.
    sub = add_user(user_pool, "novo@example.com", name="Novo")
    status = boto3.client("cognito-idp").admin_get_user(
        UserPoolId=user_pool, Username="novo@example.com"
    )["UserStatus"]

    body = response_json(user_handlers.list_examiners(api_event(EXAMINER), None))

    assert status == "FORCE_CHANGE_PASSWORD"
    assert [examiner["id"] for examiner in body] == [sub]
    assert _put(_payload(sensei_user_id=sub), MASTER)["statusCode"] == 200


@pytest.mark.parametrize(
    "field", ["sensei_display_name", "sensei_title", "sensei_certificate_name", "signature"]
)
def test_removed_settings_fields_are_ignored_and_never_returned(user_pool: str, field: str) -> None:
    response = _put(_payload(**{field: "Sensei Tomiyama"}), MASTER)

    assert response["statusCode"] == 200
    stored = _stored()
    assert stored is not None
    assert field not in stored
    for body in (
        response_json(response),
        response_json(handlers.get_settings(api_event(EXAMINER), None)),
    ):
        assert set(body) == {
            "academy_name",
            "sensei_user_id",
            "certificate_city",
            "created_at",
            "updated_at",
            "sensei",
        }
