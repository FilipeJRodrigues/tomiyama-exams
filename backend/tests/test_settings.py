"""Academy settings (§ 3.7) and the examiners selector (§ 6.6).

The sensei must be an active examiner (group ``admin``, account enabled):
RN008 relies on it, hence the ``test_rn008_sensei_must_be_active_examiner_*``
names. Only the admin master chooses the sensei (decision of 2026-11-02), so
``PUT`` runs as ``MASTER`` by default; the other examiners are covered by
``test_settings_master.py``.
"""

import os
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, GUARDIAN, MASTER, add_user, api_event, response_json

from domain import dates
from domain.settings import MSG_SENSEI_NOT_ACTIVE_EXAMINER, SETTINGS_ID
from domain.users import GUARDIAN_GROUP
from handlers import settings as handlers
from handlers import users as user_handlers
from repository import settings as settings_repo
from repository import users as user_repo
from repository.requirements import SEED_MARKER_ID

MSG_BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


def _payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "academy_name": "Associação Tomiyama de Judô",
        "sensei_user_id": None,
        "certificate_city": None,
    }
    payload.update(overrides)
    return payload


def _put(body: Any, user: Any = MASTER) -> dict[str, Any]:
    return handlers.update_settings(api_event(user, body=body), None)


def _get(user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.get_settings(api_event(user), None)


def _settings_table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])


def _stored() -> dict[str, Any] | None:
    return _settings_table().get_item(Key={"id": SETTINGS_ID}).get("Item")


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "Operation")


# --- access -------------------------------------------------------------------


@pytest.mark.parametrize(
    "call",
    [
        lambda: handlers.get_settings(api_event(GUARDIAN), None),
        lambda: handlers.update_settings(api_event(GUARDIAN, body=_payload()), None),
        lambda: user_handlers.list_examiners(api_event(GUARDIAN), None),
    ],
    ids=["GET /settings", "PUT /settings", "GET /examiners"],
)
def test_settings_routes_are_examiners_only(user_pool: str, call: Any) -> None:
    response = call()

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": "Esta área é dos examinadores"}
    assert _stored() is None


@pytest.mark.parametrize(
    "call",
    [
        lambda: handlers.get_settings(api_event(None), None),
        lambda: handlers.update_settings(api_event(None, body=_payload()), None),
        lambda: user_handlers.list_examiners(api_event(None), None),
    ],
    ids=["GET /settings", "PUT /settings", "GET /examiners"],
)
def test_settings_routes_without_claims_are_401(user_pool: str, call: Any) -> None:
    assert call()["statusCode"] == 401


# --- GET /settings --------------------------------------------------------------


def test_get_settings_before_the_first_save_is_all_null(user_pool: str) -> None:
    response = _get()

    assert response["statusCode"] == 200
    assert response_json(response) == {
        "academy_name": None,
        "sensei_user_id": None,
        "certificate_city": None,
        "created_at": None,
        "updated_at": None,
        "sensei": None,
    }


def test_get_settings_ignores_the_seed_marker(user_pool: str) -> None:
    _settings_table().put_item(Item={"id": SEED_MARKER_ID})

    assert response_json(_get())["academy_name"] is None


# --- PUT /settings: text fields -----------------------------------------------------


def test_put_settings_trims_and_turns_blank_into_null(user_pool: str) -> None:
    response = _put(
        _payload(
            academy_name="  Tomiyama  ",
            certificate_city="",
            sensei_user_id="  ",
        )
    )

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["academy_name"] == "Tomiyama"
    assert body["certificate_city"] is None
    assert body["sensei_user_id"] is None
    assert body["sensei"] is None
    assert body["created_at"] and body["updated_at"]
    assert response_json(_get()) == body
    stored = _stored()
    assert stored is not None
    assert "sensei_user_id" not in stored
    assert "certificate_city" not in stored


def test_put_settings_missing_optional_fields_become_null(user_pool: str) -> None:
    _put(_payload(certificate_city="Araraquara"))

    response = _put({"academy_name": "Tomiyama"})

    assert response["statusCode"] == 200
    body = response_json(response)
    assert body["certificate_city"] is None


@pytest.mark.parametrize("academy_name", [None, "", "   "], ids=["missing", "empty", "blank"])
def test_put_settings_requires_the_academy_name(user_pool: str, academy_name: Any) -> None:
    body = _payload()
    if academy_name is None:
        del body["academy_name"]
    else:
        body["academy_name"] = academy_name

    response = _put(body)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Campo obrigatório: Nome da academia"}
    assert _stored() is None


@pytest.mark.parametrize(
    ("field", "label", "max_len"),
    [
        ("academy_name", "Nome da academia", 255),
        ("certificate_city", "Cidade do certificado", 80),
    ],
)
def test_put_settings_length_limits(user_pool: str, field: str, label: str, max_len: int) -> None:
    accepted = _put(_payload(**{field: "a" * max_len}))
    assert accepted["statusCode"] == 200, accepted["body"]
    assert response_json(accepted)[field] == "a" * max_len

    rejected = _put(_payload(**{field: "b" * (max_len + 1)}))
    assert rejected["statusCode"] == 400
    assert response_json(rejected) == {"message": f"{label}: máximo de {max_len} caracteres"}
    assert _stored()[field] == "a" * max_len  # type: ignore[index]


@pytest.mark.parametrize("field", ["academy_name", "sensei_user_id", "certificate_city"])
def test_put_settings_rejects_non_string_fields(user_pool: str, field: str) -> None:
    response = _put(_payload(**{field: 123}))

    assert response["statusCode"] == 400
    assert response_json(response)["message"].endswith(": valor inválido")
    assert _stored() is None


@pytest.mark.parametrize("raw", ["not json", "[]", None])
def test_put_settings_requires_a_json_object(user_pool: str, raw: Any) -> None:
    event = api_event(EXAMINER)
    event["body"] = raw

    response = handlers.update_settings(event, None)

    assert response["statusCode"] == 400
    assert response_json(response) == {
        "message": "Corpo da requisição inválido: envie um objeto JSON"
    }


def test_put_settings_keeps_created_at_and_refreshes_updated_at(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2026-11-01T10:00:00+00:00")
    first = response_json(_put(_payload()))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2026-11-02T10:00:00+00:00")
    second = response_json(_put(_payload(academy_name="Outra")))

    assert first["created_at"] == "2026-11-01T10:00:00+00:00"
    assert second["created_at"] == "2026-11-01T10:00:00+00:00"
    assert second["updated_at"] == "2026-11-02T10:00:00+00:00"


def test_put_settings_preserves_images_and_unknown_attributes(user_pool: str) -> None:
    # Attributes written by other routes (images, step 5) must survive a save
    # and never show up in the JSON.
    _settings_table().put_item(
        Item={
            "id": SETTINGS_ID,
            "academy_name": "Antiga",
            "logo_primary": b"\x89PNG...",
            "signature_content_type": "image/png",
            "future_flag": True,
        }
    )
    _settings_table().put_item(Item={"id": SEED_MARKER_ID})

    response = _put(_payload(academy_name="Nova", logo_primary="ignored", signature="ignored"))

    assert response["statusCode"] == 200
    stored = _stored()
    assert stored is not None
    assert stored["academy_name"] == "Nova"
    assert bytes(stored["logo_primary"].value) == b"\x89PNG..."
    assert stored["signature_content_type"] == "image/png"
    assert stored["future_flag"] is True
    assert "signature" not in stored
    assert _settings_table().get_item(Key={"id": SEED_MARKER_ID}).get("Item")
    for body in (response_json(response), response_json(_get())):
        assert not {"logo_primary", "logo_secondary", "signature", "future_flag"} & set(body)


# --- PUT /settings: sensei (RN008 depends on it) ------------------------------------


def test_rn008_sensei_must_be_active_examiner_valid(user_pool: str) -> None:
    sub = add_user(user_pool, "sensei@example.com", name="Tomiyama Sensei")

    response = _put(_payload(sensei_user_id=sub))

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["sensei_user_id"] == sub
    assert body["sensei"] == {
        "id": sub,
        "email": "sensei@example.com",
        "name": "Tomiyama Sensei",
        "active": True,
    }
    assert _stored()["sensei_user_id"] == sub  # type: ignore[index]
    assert response_json(_get()) == body


def test_rn008_sensei_must_be_active_examiner_without_name(user_pool: str) -> None:
    sub = add_user(user_pool, "sensei@example.com")

    body = response_json(_put(_payload(sensei_user_id=sub)))

    assert body["sensei"]["name"] is None


@pytest.mark.parametrize("case", ["unknown", "guardian", "disabled", "guardian_and_disabled"])
def test_rn008_sensei_must_be_active_examiner_rejected(user_pool: str, case: str) -> None:
    previous = add_user(user_pool, "atual@example.com", name="Atual")
    assert _put(_payload(sensei_user_id=previous))["statusCode"] == 200
    if case == "unknown":
        sub = "00000000-0000-0000-0000-000000000000"
    elif case == "guardian":
        sub = add_user(user_pool, "pai@example.com", groups=(GUARDIAN_GROUP,))
    elif case == "disabled":
        sub = add_user(user_pool, "inativo@example.com", enabled=False)
    else:
        sub = add_user(user_pool, "x@example.com", groups=(GUARDIAN_GROUP,), enabled=False)

    response = _put(_payload(academy_name="Mudou", sensei_user_id=sub))

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_SENSEI_NOT_ACTIVE_EXAMINER}
    stored = _stored()
    assert stored is not None
    assert stored["sensei_user_id"] == previous
    assert stored["academy_name"] == "Associação Tomiyama de Judô"


def test_rn008_sensei_must_be_active_examiner_null_removes(user_pool: str) -> None:
    sub = add_user(user_pool, "sensei@example.com")
    _put(_payload(sensei_user_id=sub))

    response = _put(_payload(sensei_user_id=None))

    assert response["statusCode"] == 200
    body = response_json(response)
    assert body["sensei_user_id"] is None
    assert body["sensei"] is None
    assert "sensei_user_id" not in _stored()  # type: ignore[operator]


def test_rn008_sensei_must_be_active_examiner_reported_inactive_on_get(user_pool: str) -> None:
    sub = add_user(user_pool, "sensei@example.com", name="Sensei")
    _put(_payload(sensei_user_id=sub))
    client = boto3.client("cognito-idp")

    client.admin_disable_user(UserPoolId=user_pool, Username="sensei@example.com")
    disabled = response_json(_get())["sensei"]
    client.admin_remove_user_from_group(
        UserPoolId=user_pool, Username="sensei@example.com", GroupName="admin"
    )
    removed = response_json(_get())["sensei"]

    assert disabled == {"id": sub, "email": "sensei@example.com", "name": "Sensei", "active": False}
    assert removed == {"id": sub, "email": None, "name": None, "active": False}


def test_rn008_sensei_must_be_active_examiner_found_on_a_later_page(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(user_repo, "PAGE_SIZE", 2)
    subs = [add_user(user_pool, f"examinador{index}@example.com") for index in range(5)]

    response = _put(_payload(sensei_user_id=subs[-1]))

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["sensei"]["active"] is True


# --- GET /examiners -------------------------------------------------------------


def test_list_examiners_only_active_admins_sorted_by_name(user_pool: str) -> None:
    zelia = add_user(user_pool, "zelia@example.com", name="Zélia")
    alvaro = add_user(user_pool, "alvaro@example.com", name="Álvaro")
    no_name = add_user(user_pool, "carla@example.com")
    add_user(user_pool, "inativo@example.com", name="Ana", enabled=False)
    add_user(user_pool, "pai@example.com", name="Bia", groups=(GUARDIAN_GROUP,))

    response = user_handlers.list_examiners(api_event(EXAMINER), None)

    assert response["statusCode"] == 200
    assert response_json(response) == [
        {"id": alvaro, "email": "alvaro@example.com", "name": "Álvaro"},
        {"id": no_name, "email": "carla@example.com", "name": None},
        {"id": zelia, "email": "zelia@example.com", "name": "Zélia"},
    ]


def test_list_examiners_follows_pagination(user_pool: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(user_repo, "PAGE_SIZE", 2)
    subs = {add_user(user_pool, f"examinador{index}@example.com") for index in range(5)}

    body = response_json(user_handlers.list_examiners(api_event(EXAMINER), None))

    assert {item["id"] for item in body} == subs


class _PagedClient:
    """Cognito stub that serves ListUsersInGroup in pages and records the calls."""

    def __init__(self, pages: list[list[dict[str, Any]]]) -> None:
        self.pages = pages
        self.calls: list[dict[str, Any]] = []

    def list_users_in_group(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        index = int(kwargs.get("NextToken", "0"))
        response: dict[str, Any] = {"Users": self.pages[index]}
        if index + 1 < len(self.pages):
            response["NextToken"] = str(index + 1)
        return response


def _cognito_user(sub: str, email: str, enabled: bool = True) -> dict[str, Any]:
    return {
        "Username": f"user-{sub}",
        "Enabled": enabled,
        "Attributes": [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": email}],
    }


def test_list_examiners_sends_the_next_token(user_pool: str) -> None:
    client = _PagedClient(
        [
            [_cognito_user("a", "a@example.com")],
            [_cognito_user("b", "b@example.com", enabled=False)],
            [_cognito_user("c", "c@example.com")],
        ]
    )

    examiners = user_repo.list_examiners(client)

    assert [examiner.id for examiner in examiners] == ["a", "b", "c"]
    assert [examiner.enabled for examiner in examiners] == [True, False, True]
    assert [call.get("NextToken") for call in client.calls] == [None, "1", "2"]
    assert all(
        call["UserPoolId"] == user_pool and call["GroupName"] == "admin" for call in client.calls
    )


# --- Cognito and DynamoDB temporarily unavailable -------------------------------------


class _FailingClient:
    def __init__(self, code: str) -> None:
        self.code = code

    def list_users_in_group(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error(self.code)


@pytest.mark.parametrize("code", ["TooManyRequestsException", "InternalErrorException"])
def test_cognito_throttling_is_503(
    user_pool: str, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    sub = add_user(user_pool, "sensei@example.com")
    assert _put(_payload(sensei_user_id=sub))["statusCode"] == 200
    monkeypatch.setattr(user_repo, "_client", lambda: _FailingClient(code))

    responses = [
        user_handlers.list_examiners(api_event(EXAMINER), None),
        _get(),
        _put(_payload(academy_name="Mudou", sensei_user_id=sub)),
    ]

    for response in responses:
        assert response["statusCode"] == 503
        assert response_json(response) == {"message": MSG_BUSY}
    assert _stored()["academy_name"] == "Associação Tomiyama de Judô"  # type: ignore[index]


def test_cognito_other_errors_are_not_reported_as_busy(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(user_repo, "_client", lambda: _FailingClient("ResourceNotFoundException"))

    response = user_handlers.list_examiners(api_event(EXAMINER), None)

    assert response["statusCode"] == 500


def test_settings_without_sensei_do_not_call_cognito(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(user_repo, "_client", lambda: _FailingClient("TooManyRequestsException"))

    assert _put(_payload())["statusCode"] == 200
    assert _get()["statusCode"] == 200


class _ThrottledTable:
    name = "test-settings"

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error("ProvisionedThroughputExceededException")

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error("ProvisionedThroughputExceededException")


def test_settings_table_throttling_is_503(user_pool: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings_repo, "table", lambda env_var: _ThrottledTable())

    for response in (_get(), _put(_payload())):
        assert response["statusCode"] == 503
        assert response_json(response) == {"message": MSG_BUSY}
