"""Certificate signatures (§ 3.7, § 6.6, RN011, RN012): master and sensei only.

Up to 3 in an ordered list; each with name, graduation, image (PNG or JPEG of
at most 2 MB, validated like the logos) and position. "Complete" = name,
graduation and image. Images in the private bucket under ``signatures/``, one
key per upload (``signatures/{id}/{uuid}``) recorded in the metadata.
"""

import base64
import json
import logging
import os
import re
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs, urlparse

import boto3
import pytest
from botocore.awsrequest import AWSResponse
from botocore.exceptions import (
    ClientError,
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)
from conftest import (
    EXAMINER,
    GUARDIAN,
    MASTER,
    api_event,
    read_signature_image,
    response_json,
    signature_object_keys,
)

from domain import dates
from domain import signatures as rules
from domain.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from domain.images import MAX_IMAGE_BYTES, MSG_INVALID_IMAGE, ImageMeta
from domain.settings import SETTINGS_ID
from domain.signatures import SIGNATURES_ID
from domain.users import ADMIN_GROUP, User
from handlers import settings as settings_handlers
from handlers import signatures as handlers
from repository import images as image_repo
from repository import settings as settings_repo
from repository import signatures as signature_repo

MSG_FORBIDDEN = "Somente o master e o sensei gerem as assinaturas"
MSG_NOT_FOUND = "Assinatura não encontrada"
MSG_NO_IMAGE = "Assinatura sem imagem"
MSG_LIMIT = "O certificado aceita no máximo 3 assinaturas"
MSG_OUTDATED = "A lista de assinaturas mudou. Recarregue e tente de novo."
MSG_BUSY = "Sistema ocupado no momento. Tente de novo em instantes."
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
OTHER_EXAMINER = EXAMINER
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
JPEG_BYTES = b"\xff\xd8\xff" + b"\xe0\x00\x10JFIF" + b"\x02" * 40
GIF_BYTES = b"GIF89a" + b"\x00" * 40
NOW = "2026-11-03T12:00:00+00:00"
UNKNOWN_ID = "00000000-0000-4000-8000-000000000000"


# --- helpers ----------------------------------------------------------------------------


def _image(data: bytes = PNG_BYTES, content_type: str = "image/png") -> dict[str, Any]:
    return {"content_type": content_type, "data": base64.b64encode(data).decode("ascii")}


def _list(user: User | None = MASTER) -> dict[str, Any]:
    return handlers.list_signatures(api_event(user), None)


def _create(
    name: str = "Jigoro Kano", graduation: str | None = "Fundador", user: User | None = MASTER
) -> dict[str, Any]:
    body = {"name": name, "graduation": graduation}
    return handlers.create_signature(api_event(user, body=body), None)


def _update(signature_id: str, body: Any, user: User | None = MASTER) -> dict[str, Any]:
    return handlers.update_signature(api_event(user, body=body, path={"id": signature_id}), None)


def _reorder(ids: Any, user: User | None = MASTER) -> dict[str, Any]:
    return handlers.reorder_signatures(api_event(user, body={"ids": ids}), None)


def _delete(signature_id: str, user: User | None = MASTER) -> dict[str, Any]:
    return handlers.delete_signature(api_event(user, path={"id": signature_id}), None)


def _put_image(signature_id: str, body: Any = None, user: User | None = MASTER) -> dict[str, Any]:
    event = api_event(user, body=body or _image(), path={"id": signature_id})
    return handlers.put_signature_image(event, None)


def _delete_image(signature_id: str, user: User | None = MASTER) -> dict[str, Any]:
    return handlers.delete_signature_image(api_event(user, path={"id": signature_id}), None)


def _get_image(signature_id: str, user: User | None = MASTER) -> dict[str, Any]:
    return handlers.get_signature_image(api_event(user, path={"id": signature_id}), None)


def _created_id(**kwargs: Any) -> str:
    response = _create(**kwargs)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)["id"]


def _settings_table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])


def _stored_list() -> dict[str, Any] | None:
    return _settings_table().get_item(Key={"id": SIGNATURES_ID}).get("Item")


def _names() -> list[str]:
    return [item["name"] for item in response_json(_list())["signatures"]]


def _set_sensei(sub: str | None) -> None:
    item: dict[str, Any] = {"id": SETTINGS_ID, "academy_name": "Tomiyama"}
    if sub is not None:
        item["sensei_user_id"] = sub
    _settings_table().put_item(Item=item)


def _s3_object(key: str) -> dict[str, Any] | None:
    try:
        response = boto3.client("s3").get_object(Bucket=os.environ["IMAGES_BUCKET"], Key=key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "NoSuchKey":
            return None
        raise
    return {
        "body": response["Body"].read(),
        "content_type": response["ContentType"],
        "disposition": response.get("ContentDisposition"),
    }


def _image_key(signature_id: str) -> str | None:
    """Return the key recorded in the stored ``image`` map (None without image)."""
    for entry in (_stored_list() or {}).get("signatures", []):
        if entry["id"] == signature_id:
            image = entry.get("image")
            return image["key"] if image else None
    return None


def _assert_upload_key(signature_id: str, key: str | None) -> str:
    assert key is not None
    match = re.fullmatch(rf"signatures/{signature_id}/([0-9a-f-]{{36}})", key)
    assert match is not None, key
    assert str(uuid.UUID(match.group(1))) == match.group(1)
    return key


def _bucket_keys() -> list[str]:
    listed = boto3.client("s3").list_objects_v2(Bucket=os.environ["IMAGES_BUCKET"])
    return [item["Key"] for item in listed.get("Contents", [])]


def _client_error(code: str, reasons: list[str] | None = None) -> ClientError:
    response: dict[str, Any] = {"Error": {"Code": code, "Message": code}}
    if reasons is not None:
        response["CancellationReasons"] = [{"Code": reason} for reason in reasons]
    return ClientError(response, "TransactWriteItems")  # type: ignore[arg-type]


def _assert_status(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response.get("body")
    assert response_json(response) == {"message": message}


@pytest.fixture
def academy(images_bucket: str) -> str:
    """Bucket, tables and settings whose sensei is ``SENSEI``."""
    _set_sensei(SENSEI.sub)
    return images_bucket


@pytest.fixture
def frozen_now(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)
    return NOW


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(signature_repo.time, "sleep", lambda seconds: None)


# Every route, called with an id that exists when it needs one.
ROUTES: dict[str, Callable[[User | None, str], dict[str, Any]]] = {
    "list": lambda user, sid: _list(user),
    "create": lambda user, sid: _create(user=user),
    "update": lambda user, sid: _update(sid, {"name": "Outro", "graduation": "x"}, user),
    "reorder": lambda user, sid: _reorder([sid], user),
    "delete": lambda user, sid: _delete(sid, user),
    "put-image": lambda user, sid: _put_image(sid, user=user),
    "delete-image": lambda user, sid: _delete_image(sid, user),
    "get-image": lambda user, sid: _get_image(sid, user),
}


def _with_image() -> str:
    signature_id = _created_id()
    assert _put_image(signature_id)["statusCode"] == 200
    return signature_id


# --- access (RN012) -----------------------------------------------------------------------


@pytest.mark.parametrize("route", list(ROUTES))
def test_rn012_master_manages_the_signatures(academy: str, route: str) -> None:
    signature_id = _with_image()

    response = ROUTES[route](MASTER, signature_id)

    assert response["statusCode"] in (200, 201, 204), response.get("body")


@pytest.mark.parametrize("route", list(ROUTES))
def test_rn012_sensei_manages_the_signatures(academy: str, route: str) -> None:
    signature_id = _with_image()

    response = ROUTES[route](SENSEI, signature_id)

    assert response["statusCode"] in (200, 201, 204), response.get("body")


@pytest.mark.parametrize("user", [OTHER_EXAMINER, GUARDIAN], ids=["other-examiner", "guardian"])
@pytest.mark.parametrize("route", list(ROUTES))
def test_rn012_others_get_403_and_nothing_changes(academy: str, route: str, user: User) -> None:
    signature_id = _with_image()
    before_item = _stored_list()
    before_keys = _bucket_keys()

    _assert_status(ROUTES[route](user, signature_id), 403, MSG_FORBIDDEN)

    assert _stored_list() == before_item
    assert _bucket_keys() == before_keys


@pytest.mark.parametrize("route", list(ROUTES))
def test_rn012_signature_routes_without_login_are_401(academy: str, route: str) -> None:
    _assert_status(ROUTES[route](None, UNKNOWN_ID), 401, "Faça login para continuar")


@pytest.mark.parametrize("route", list(ROUTES))
def test_rn012_without_sensei_only_the_master_manages(images_bucket: str, route: str) -> None:
    _set_sensei(None)
    signature_id = _with_image()

    _assert_status(ROUTES[route](OTHER_EXAMINER, signature_id), 403, MSG_FORBIDDEN)
    assert ROUTES[route](MASTER, signature_id)["statusCode"] in (200, 201, 204)


def test_rn012_without_settings_only_the_master_manages(images_bucket: str) -> None:
    _assert_status(_list(OTHER_EXAMINER), 403, MSG_FORBIDDEN)
    assert _create()["statusCode"] == 201


def test_rn012_sensei_is_read_on_every_request(academy: str) -> None:
    assert _list(SENSEI)["statusCode"] == 200

    _set_sensei(OTHER_EXAMINER.sub)

    _assert_status(_list(SENSEI), 403, MSG_FORBIDDEN)
    _assert_status(_create(user=SENSEI), 403, MSG_FORBIDDEN)
    assert _list(OTHER_EXAMINER)["statusCode"] == 200


def test_rn012_master_in_master_group_only_is_not_master(academy: str) -> None:
    # A member of ``master`` without ``admin`` (misconfigured) is not the master.
    lone = User(sub="lone", email=None, groups=frozenset({"master"}))

    _assert_status(_list(lone), 403, MSG_FORBIDDEN)


def test_rn012_sensei_replaced_before_the_write_writes_nothing(
    academy: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The handler's check sees the old sensei; the transaction sees the new one.
    _set_sensei(OTHER_EXAMINER.sub)
    monkeypatch.setattr(settings_repo, "get_sensei_user_id", lambda: SENSEI.sub)

    _assert_status(_create(user=SENSEI), 403, MSG_FORBIDDEN)

    assert _stored_list() is None


def test_rn012_guardian_gets_403_before_the_id_is_checked(academy: str) -> None:
    _assert_status(_get_image("não-é-uuid", GUARDIAN), 403, MSG_FORBIDDEN)
    _assert_status(_put_image("não-é-uuid", {"x": 1}, OTHER_EXAMINER), 403, MSG_FORBIDDEN)


def test_rn012_signatures_never_appear_in_get_settings(user_pool: str, academy: str) -> None:
    _with_image()

    body = response_json(settings_handlers.get_settings(api_event(MASTER), None))
    payload = {"academy_name": "Tomiyama", "sensei_user_id": None, "certificate_city": None}
    saved = response_json(settings_handlers.update_settings(api_event(MASTER, body=payload), None))

    for view in (body, saved):
        assert not any("signature" in key for key in view), view
        assert "Jigoro" not in str(view)
    # Saving the settings keeps the list.
    assert _names() == ["Jigoro Kano"]


# --- create, edit, limit (RN012) ------------------------------------------------------------


def test_rn012_create_returns_201_at_the_last_position(academy: str, frozen_now: str) -> None:
    _created_id(name="Primeira")

    response = _create(name="  Segunda  ", graduation="  6º Dan  ", user=SENSEI)

    assert response["statusCode"] == 201
    body = response_json(response)
    assert body == {
        "id": body["id"],
        "position": 2,
        "name": "Segunda",
        "graduation": "6º Dan",
        "image": None,
        "complete": False,
        "updated_at": NOW,
        "updated_by": SENSEI.sub,
    }
    assert rules.parse_signature_id(body["id"]) == body["id"]


def test_rn012_list_starts_empty(academy: str) -> None:
    assert response_json(_list()) == {"signatures": [], "max_signatures": 3, "has_complete": False}


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, "Campo obrigatório: Nome"),
        ({"name": "   "}, "Campo obrigatório: Nome"),
        ({"name": 12}, "Nome: valor inválido"),
        ({"name": "x" * 121}, "Nome: máximo de 120 caracteres"),
        ({"name": "Ok", "graduation": "x" * 121}, "Graduação: máximo de 120 caracteres"),
        ({"name": "Ok", "graduation": ["6º Dan"]}, "Graduação: valor inválido"),
    ],
)
def test_rn012_invalid_fields_are_400(academy: str, body: dict[str, Any], message: str) -> None:
    _assert_status(handlers.create_signature(api_event(MASTER, body=body), None), 400, message)
    assert _stored_list() is None


def test_rn012_blank_graduation_is_kept_as_null(academy: str) -> None:
    body = response_json(_create(graduation="   "))

    assert body["graduation"] is None
    assert body["complete"] is False


def test_rn012_fourth_signature_is_409(academy: str) -> None:
    for name in ("A", "B", "C"):
        _created_id(name=name)

    _assert_status(_create(name="D"), 409, MSG_LIMIT)

    assert _names() == ["A", "B", "C"]


def test_rn012_limit_holds_when_two_creates_race(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    # Request A reads 2 signatures; before it writes, request B creates the
    # 3rd. A's write must fail on the version and, re-read, give 409.
    for name in ("A", "B"):
        _created_id(name=name)
    real_get = signature_repo.get_signatures
    raced: list[dict[str, Any]] = []

    def stale_then_real() -> Any:
        snapshot = real_get()
        if not raced:
            monkeypatch.setattr(signature_repo, "get_signatures", real_get)
            raced.append(_create(name="B2", user=SENSEI))
            monkeypatch.setattr(signature_repo, "get_signatures", stale_then_real)
        return snapshot

    monkeypatch.setattr(signature_repo, "get_signatures", stale_then_real)

    response = _create(name="A2")

    monkeypatch.setattr(signature_repo, "get_signatures", real_get)
    assert raced[0]["statusCode"] == 201
    _assert_status(response, 409, MSG_LIMIT)
    assert _names() == ["A", "B", "B2"]


def test_rn012_two_creates_racing_with_room_both_land(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    # No write is lost: the loser re-reads and appends after the winner.
    _created_id(name="A")
    real_get = signature_repo.get_signatures
    raced: list[dict[str, Any]] = []

    def stale_then_real() -> Any:
        snapshot = real_get()
        if not raced:
            monkeypatch.setattr(signature_repo, "get_signatures", real_get)
            raced.append(_create(name="B", user=SENSEI))
            monkeypatch.setattr(signature_repo, "get_signatures", stale_then_real)
        return snapshot

    monkeypatch.setattr(signature_repo, "get_signatures", stale_then_real)

    response = _create(name="C")

    monkeypatch.setattr(signature_repo, "get_signatures", real_get)
    assert raced[0]["statusCode"] == 201
    assert response["statusCode"] == 201
    assert response_json(response)["position"] == 3
    assert _names() == ["A", "B", "C"]
    assert _stored_list()["version"] == 3  # type: ignore[index]


def test_rn012_stale_write_is_refused_by_the_version(academy: str, frozen_now: str) -> None:
    _created_id(name="A")
    stale = signature_repo.get_signatures()
    _created_id(name="B")

    with pytest.raises(signature_repo.StaleListError):
        signature_repo._write(stale, (), sensei_check=None, now_iso=NOW, user_sub=MASTER.sub)

    assert _names() == ["A", "B"]


def test_rn012_writes_that_keep_losing_give_409(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    def always_stale(*args: Any, **kwargs: Any) -> None:
        raise signature_repo.StaleListError

    monkeypatch.setattr(signature_repo, "_write", always_stale)

    _assert_status(_create(), 409, rules.MSG_SIGNATURES_BUSY)


def test_rn012_edit_replaces_name_and_graduation_keeping_image_and_position(
    academy: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _created_id(name="A")
    signature_id = _with_image()
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)

    response = _update(signature_id, {"name": "Novo", "graduation": None}, SENSEI)

    assert response["statusCode"] == 200
    body = response_json(response)
    assert body["position"] == 2
    assert (body["name"], body["graduation"]) == ("Novo", None)
    assert body["image"]["content_type"] == "image/png"
    assert (body["updated_at"], body["updated_by"]) == (NOW, SENSEI.sub)
    assert body["complete"] is False


@pytest.mark.parametrize("signature_id", [UNKNOWN_ID, "nao-uuid", "../logos/primary", ""])
def test_rn012_unknown_or_malformed_id_is_404(academy: str, signature_id: str) -> None:
    _created_id()

    _assert_status(_update(signature_id, {"name": "x"}), 404, MSG_NOT_FOUND)
    _assert_status(_put_image(signature_id), 404, MSG_NOT_FOUND)
    _assert_status(_get_image(signature_id), 404, MSG_NOT_FOUND)
    _assert_status(_delete_image(signature_id), 404, MSG_NOT_FOUND)
    assert _bucket_keys() == []


def test_rn012_uppercase_uuid_is_not_an_id(academy: str) -> None:
    signature_id = _created_id()

    _assert_status(_get_image(signature_id.upper()), 404, MSG_NOT_FOUND)


# --- order (RN012) --------------------------------------------------------------------------


def test_rn012_reorder_sets_the_positions(academy: str) -> None:
    a, b, c = (_created_id(name=name) for name in ("A", "B", "C"))

    response = _reorder([c, a, b], SENSEI)

    assert response["statusCode"] == 200
    body = response_json(response)
    assert [(item["name"], item["position"]) for item in body["signatures"]] == [
        ("C", 1),
        ("A", 2),
        ("B", 3),
    ]
    assert _names() == ["C", "A", "B"]


@pytest.mark.parametrize(
    "ids",
    [None, "abc", [1, 2], ["x", "x"], ["a", "b", "c", "d"]],
    ids=["missing", "text", "numbers", "duplicate", "too-many"],
)
def test_rn012_invalid_order_is_400(academy: str, ids: Any) -> None:
    _created_id()

    _assert_status(_reorder(ids), 400, rules.MSG_INVALID_ORDER)


def test_rn012_order_that_misses_or_adds_ids_is_409(academy: str) -> None:
    a = _created_id(name="A")
    b = _created_id(name="B")

    _assert_status(_reorder([b]), 409, MSG_OUTDATED)
    _assert_status(_reorder([b, a, UNKNOWN_ID]), 409, MSG_OUTDATED)
    _assert_status(_reorder([b, UNKNOWN_ID]), 409, MSG_OUTDATED)
    assert _names() == ["A", "B"]


def test_rn012_reorder_against_a_list_changed_meanwhile_is_409(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    # The screen sends the order of A and B while someone adds C: the order is
    # re-checked on the fresh list and refused, never mixed.
    a = _created_id(name="A")
    b = _created_id(name="B")
    real_get = signature_repo.get_signatures
    raced: list[dict[str, Any]] = []

    def stale_then_real() -> Any:
        snapshot = real_get()
        if not raced:
            monkeypatch.setattr(signature_repo, "get_signatures", real_get)
            raced.append(_create(name="C", user=SENSEI))
            monkeypatch.setattr(signature_repo, "get_signatures", stale_then_real)
        return snapshot

    monkeypatch.setattr(signature_repo, "get_signatures", stale_then_real)

    response = _reorder([b, a])

    monkeypatch.setattr(signature_repo, "get_signatures", real_get)
    _assert_status(response, 409, MSG_OUTDATED)
    assert _names() == ["A", "B", "C"]


def test_rn012_positions_move_up_after_a_removal(academy: str) -> None:
    _created_id(name="A")
    b = _created_id(name="B")
    _created_id(name="C")

    assert _delete(b)["statusCode"] == 204

    body = response_json(_list())
    assert [(item["name"], item["position"]) for item in body["signatures"]] == [
        ("A", 1),
        ("C", 2),
    ]


# --- complete / incomplete (RN011, RN012) ---------------------------------------------------


def test_rn012_complete_needs_name_graduation_and_image(academy: str) -> None:
    no_image = _created_id(name="Sem imagem", graduation="6º Dan")
    no_graduation = _created_id(name="Sem graduação", graduation=None)
    full = _created_id(name="Completa", graduation="Fundador, 6º Dan (in memoriam)")
    assert _put_image(no_graduation)["statusCode"] == 200

    assert response_json(_list())["has_complete"] is False

    assert _put_image(full, _image(JPEG_BYTES, "image/jpeg"))["statusCode"] == 200

    body = response_json(_list())
    assert {item["id"]: item["complete"] for item in body["signatures"]} == {
        no_image: False,
        no_graduation: False,
        full: True,
    }
    assert body["has_complete"] is True

    assert _delete_image(full)["statusCode"] == 204
    assert response_json(_list())["has_complete"] is False


def test_rn012_complete_rule_is_pure() -> None:
    meta = ImageMeta(content_type="image/png", size=1, updated_at=NOW, updated_by="x")

    def signature(graduation: str | None, image: ImageMeta | None) -> rules.Signature:
        return rules.Signature(
            id=UNKNOWN_ID,
            name="Nome",
            graduation=graduation,
            image=image,
            updated_at=NOW,
            updated_by="x",
            image_key=rules.new_image_key(UNKNOWN_ID) if image is not None else None,
        )

    assert signature("6º Dan", meta).complete is True
    assert signature(None, meta).complete is False
    assert signature("6º Dan", None).complete is False
    assert rules.has_complete([]) is False
    assert rules.has_complete([signature(None, meta), signature("1º Dan", meta)]) is True


def test_rn012_image_keys_are_per_upload_and_of_their_signature() -> None:
    first, second = rules.new_image_key(UNKNOWN_ID), rules.new_image_key(UNKNOWN_ID)

    assert first != second
    assert rules.is_image_key(UNKNOWN_ID, first)
    other = "11111111-1111-4111-8111-111111111111"
    for key in [
        f"signatures/{UNKNOWN_ID}",
        f"signatures/{UNKNOWN_ID}/",
        f"signatures/{UNKNOWN_ID}/nao-uuid",
        f"signatures/{UNKNOWN_ID}/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
        f"signatures/{UNKNOWN_ID}/{other}/x",
        f"signatures/{other}/{other}",
        "logos/primary",
        None,
    ]:
        assert not rules.is_image_key(UNKNOWN_ID, key), key


def test_rn012_image_metadata_without_a_valid_key_count_as_no_image() -> None:
    meta = {"content_type": "image/png", "size": 1, "updated_at": NOW, "updated_by": "x"}
    base = {"id": UNKNOWN_ID, "name": "n", "graduation": "g", "updated_at": NOW, "updated_by": "x"}
    other = "11111111-1111-4111-8111-111111111111"

    for image in [meta, {**meta, "key": f"signatures/{other}/{other}"}, {**meta, "key": 1}]:
        loaded = rules.Signature.from_item({**base, "image": image})
        assert (loaded.image, loaded.image_key, loaded.complete) == (None, None, False)

    key = rules.new_image_key(UNKNOWN_ID)
    loaded = rules.Signature.from_item({**base, "image": {**meta, "key": key}})
    assert loaded.image_key == key and loaded.complete is True
    assert loaded.to_item()["image"]["key"] == key
    with pytest.raises(ValueError, match="go together"):
        rules.Signature(
            id=UNKNOWN_ID,
            name="n",
            graduation="g",
            image=None,
            updated_at=NOW,
            updated_by="x",
            image_key=key,
        )


def test_rn012_adding_to_a_full_list_is_refused_by_the_rule() -> None:
    full = tuple(
        rules.Signature(
            id=str(index), name="n", graduation=None, image=None, updated_at=NOW, updated_by="x"
        )
        for index in range(3)
    )

    with pytest.raises(ConflictError, match=MSG_LIMIT):
        rules.add(full, full[0])


# --- image (RN012) --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("data", "content_type", "filename"),
    [(PNG_BYTES, "image/png", "assinatura.png"), (JPEG_BYTES, "image/jpeg", "assinatura.jpg")],
    ids=["png", "jpeg"],
)
def test_rn012_image_is_stored_under_its_own_key(
    academy: str, frozen_now: str, data: bytes, content_type: str, filename: str
) -> None:
    signature_id = _created_id()

    response = _put_image(signature_id, _image(data, content_type), SENSEI)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert body["image"] == {
        "content_type": content_type,
        "size": len(data),
        "updated_at": NOW,
        "updated_by": SENSEI.sub,
    }
    assert body["complete"] is True
    key = _assert_upload_key(signature_id, _image_key(signature_id))
    assert _s3_object(key) == {
        "body": data,
        "content_type": content_type,
        "disposition": f'inline; filename="{filename}"',
    }
    assert _bucket_keys() == [key]
    # Only metadata in DynamoDB, never the bytes.
    assert base64.b64encode(data).decode() not in str(_stored_list())


def test_rn012_exactly_2_mb_image_is_accepted(academy: str) -> None:
    signature_id = _created_id()
    data = PNG_BYTES[:8] + b"\x00" * (MAX_IMAGE_BYTES - 8)

    assert _put_image(signature_id, _image(data))["statusCode"] == 200


@pytest.mark.parametrize(
    "body",
    [
        _image(GIF_BYTES, "image/png"),
        _image(JPEG_BYTES, "image/png"),
        _image(GIF_BYTES, "image/gif"),
        _image(PNG_BYTES[:8] + b"\x00" * (MAX_IMAGE_BYTES - 7)),
        {"content_type": "image/png", "data": "não é base64"},
        {"content_type": "image/png", "data": ""},
    ],
    ids=["gif-as-png", "jpeg-as-png", "gif", "over-2mb", "bad-base64", "empty"],
)
def test_rn012_invalid_signature_image_is_400_and_keeps_the_current(
    academy: str, body: dict[str, Any]
) -> None:
    signature_id = _with_image()
    before = _stored_list()
    before_keys = _bucket_keys()

    _assert_status(_put_image(signature_id, body), 400, MSG_INVALID_IMAGE)

    assert _stored_list() == before
    assert _bucket_keys() == before_keys
    assert _s3_object(_image_key(signature_id) or "")["body"] == PNG_BYTES  # type: ignore[index]


def test_rn012_image_for_unknown_signature_writes_nothing(academy: str) -> None:
    _assert_status(_put_image(UNKNOWN_ID), 404, MSG_NOT_FOUND)

    assert _bucket_keys() == []
    assert _stored_list() is None


def test_rn012_replacing_the_image_uses_a_new_key_and_removes_the_previous(
    academy: str,
) -> None:
    signature_id = _with_image()
    previous = _image_key(signature_id)

    assert _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"))["statusCode"] == 200

    key = _assert_upload_key(signature_id, _image_key(signature_id))
    assert key != previous
    assert _bucket_keys() == [key]
    assert _s3_object(key) == {
        "body": JPEG_BYTES,
        "content_type": "image/jpeg",
        "disposition": 'inline; filename="assinatura.jpg"',
    }
    item = response_json(_list())["signatures"][0]
    assert item["image"]["content_type"] == "image/jpeg"
    # The S3 key stays inside the API: the screen never sees it.
    assert "key" not in item["image"]


def test_rn012_failed_cleanup_of_the_previous_key_keeps_the_200(
    academy: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    signature_id = _with_image()
    previous = _image_key(signature_id)

    def refuse_delete(key: str) -> None:
        raise signature_repo.ServiceUnavailableError(MSG_BUSY)

    monkeypatch.setattr(image_repo, "delete_image", refuse_delete)
    with caplog.at_level(logging.ERROR):
        response = _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"))

    assert response["statusCode"] == 200, response["body"]
    key = _image_key(signature_id)
    assert key is not None and previous is not None and key != previous
    # The metadata point to the new object; the previous one is an orphan
    # without metadata, logged.
    assert read_signature_image(academy, signature_id) == (JPEG_BYTES, "image/jpeg")
    assert sorted(_bucket_keys()) == sorted([previous, key])
    assert previous in caplog.text


@pytest.mark.parametrize(
    ("error", "status", "message"),
    [
        (ForbiddenError(MSG_FORBIDDEN), 403, MSG_FORBIDDEN),
        (NotFoundError(MSG_NOT_FOUND), 404, MSG_NOT_FOUND),
        (signature_repo.StaleListError(), 409, rules.MSG_SIGNATURES_BUSY),
        (signature_repo.ServiceUnavailableError(MSG_BUSY), 503, MSG_BUSY),
    ],
    ids=["403", "404", "409", "503"],
)
def test_rn012_failed_transaction_deletes_only_the_new_key(
    academy: str,
    monkeypatch: pytest.MonkeyPatch,
    no_backoff: None,
    error: Exception,
    status: int,
    message: str,
) -> None:
    signature_id = _with_image()
    before = _stored_list()
    before_keys = _bucket_keys()

    def fail(*args: Any, **kwargs: Any) -> None:
        raise error

    monkeypatch.setattr(signature_repo, "_write", fail)

    response = _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"), SENSEI)

    _assert_status(response, status, message)
    assert _stored_list() == before
    assert _bucket_keys() == before_keys
    assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")


def test_rn012_two_uploads_at_the_same_time_end_coherent(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    # The JPEG upload runs whole between the PNG upload's S3 write and its
    # transaction: the PNG transaction re-reads the list, wins and deletes the
    # JPEG object it replaced.
    signature_id = _with_image()
    first = _image_key(signature_id)
    real_put = image_repo.put_image
    calls: list[str] = []

    def put_then_other_upload(key: str, *args: Any, **kwargs: Any) -> None:
        real_put(key, *args, **kwargs)
        calls.append(key)
        if len(calls) == 1:
            other = _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"), SENSEI)
            assert other["statusCode"] == 200, other["body"]

    monkeypatch.setattr(image_repo, "put_image", put_then_other_upload)

    response = _put_image(signature_id, _image(PNG_BYTES, "image/png"))

    assert response["statusCode"] == 200, response["body"]
    assert len(calls) == 2 and first not in calls
    winner = _image_key(signature_id)
    assert winner == calls[0]
    listed = response_json(_list())["signatures"][0]
    assert listed["image"]["content_type"] == "image/png"
    assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")
    assert signature_object_keys(academy, signature_id) == [winner]


def test_rn012_get_image_returns_a_presigned_url(academy: str, frozen_now: str) -> None:
    _created_id(name="A")
    signature_id = _with_image()

    response = _get_image(signature_id, SENSEI)

    assert response["statusCode"] == 200
    body = response_json(response)
    url = urlparse(body.pop("url"))
    assert body == {
        "id": signature_id,
        "position": 2,
        "expires_in": 300,
        "content_type": "image/png",
        "size": len(PNG_BYTES),
        "updated_at": NOW,
        "updated_by": MASTER.sub,
    }
    query = parse_qs(url.query)
    assert url.netloc.startswith(f"{os.environ['IMAGES_BUCKET']}.s3.")
    assert url.path == f"/{_assert_upload_key(signature_id, _image_key(signature_id))}"
    assert query["X-Amz-Expires"] == ["300"]
    assert query["response-content-type"] == ["image/png"]
    assert query["response-content-disposition"] == ['inline; filename="assinatura.png"']
    assert base64.b64encode(PNG_BYTES).decode() not in response["body"]


def test_rn012_get_image_without_image_is_404(academy: str) -> None:
    signature_id = _created_id()

    _assert_status(_get_image(signature_id), 404, MSG_NO_IMAGE)


def test_rn012_list_never_carries_urls_nor_bytes(academy: str) -> None:
    _with_image()

    raw = _list()["body"]

    assert "http" not in raw
    assert base64.b64encode(PNG_BYTES).decode() not in raw


def test_rn012_delete_image_removes_metadata_and_object(academy: str) -> None:
    signature_id = _with_image()

    assert _delete_image(signature_id, SENSEI)["statusCode"] == 204

    assert _bucket_keys() == []
    item = response_json(_list())["signatures"][0]
    assert (item["image"], item["complete"]) == (None, False)
    assert _delete_image(signature_id)["statusCode"] == 204


def test_rn012_get_image_points_to_the_registered_key(academy: str) -> None:
    signature_id = _with_image()
    assert _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"))["statusCode"] == 200
    key = _image_key(signature_id)

    body = response_json(_get_image(signature_id))

    assert urlparse(body["url"]).path == f"/{key}"
    assert body["content_type"] == "image/jpeg"
    assert _s3_object(key or "")["body"] == JPEG_BYTES  # type: ignore[index]


def test_rn012_delete_image_deletes_only_the_registered_key(academy: str) -> None:
    # Another object of the signature (an upload not recorded yet) is not touched.
    signature_id = _with_image()
    in_flight = rules.new_image_key(signature_id)
    boto3.client("s3").put_object(Bucket=os.environ["IMAGES_BUCKET"], Key=in_flight, Body=PNG_BYTES)

    assert _delete_image(signature_id)["statusCode"] == 204

    assert _bucket_keys() == [in_flight]
    assert _image_key(signature_id) is None


def test_rn012_image_upload_racing_a_removal_leaves_no_object(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    # The signature is removed after the existence check and the S3 write:
    # the metadata write sees it gone, answers 404 and drops the object.
    signature_id = _created_id()
    real_put = image_repo.put_image

    def put_then_removed(*args: Any, **kwargs: Any) -> None:
        real_put(*args, **kwargs)
        assert _delete(signature_id, SENSEI)["statusCode"] == 204

    monkeypatch.setattr(image_repo, "put_image", put_then_removed)

    _assert_status(_put_image(signature_id), 404, MSG_NOT_FOUND)

    assert _bucket_keys() == []
    assert _names() == []


# --- removal (RN012) ------------------------------------------------------------------------


def test_rn012_removing_a_signature_removes_its_image(academy: str) -> None:
    keep = _with_image()
    gone = _with_image()

    assert _delete(gone, SENSEI)["statusCode"] == 204

    assert _bucket_keys() == [_image_key(keep)]
    assert [item["id"] for item in response_json(_list())["signatures"]] == [keep]
    _assert_status(_get_image(gone), 404, MSG_NOT_FOUND)


def test_rn012_removal_is_idempotent(academy: str) -> None:
    signature_id = _with_image()

    assert _delete(signature_id)["statusCode"] == 204
    assert _delete(signature_id)["statusCode"] == 204
    assert _delete(UNKNOWN_ID)["statusCode"] == 204

    assert _bucket_keys() == []
    assert _names() == []


def test_rn012_malformed_id_on_removal_is_404(academy: str) -> None:
    _assert_status(_delete("../logos/primary"), 404, MSG_NOT_FOUND)


def test_rn012_signatures_and_logos_use_separate_keys(academy: str) -> None:
    from handlers import logos as logo_handlers

    put_logo = api_event(MASTER, body=_image(), path={"slot": "primary"})
    assert logo_handlers.put_logo(put_logo, None)["statusCode"] == 200
    signature_id = _with_image()

    assert _delete(signature_id)["statusCode"] == 204

    assert _bucket_keys() == ["logos/primary"]


# --- 503 (RN012) ----------------------------------------------------------------------------


class _ThrottledTable:
    name = "test-settings"

    def get_item(self, **kwargs: Any) -> dict[str, Any]:
        raise _client_error("ProvisionedThroughputExceededException")


class _ThrottledS3:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        raise self.error

    def delete_object(self, **kwargs: Any) -> dict[str, Any]:
        raise self.error


def test_rn012_settings_throttled_on_the_sensei_read_is_503(
    academy: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings_repo, "table", lambda env_var: _ThrottledTable())

    _assert_status(_list(SENSEI), 503, MSG_BUSY)


def test_rn012_settings_throttled_on_the_list_read_is_503(
    academy: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(signature_repo, "table", lambda env_var: _ThrottledTable())

    _assert_status(_list(), 503, MSG_BUSY)


@pytest.mark.parametrize(
    "error",
    [
        _client_error("ThrottlingException"),
        _client_error("TransactionCanceledException", ["None", "ThrottlingError"]),
        _client_error("TransactionCanceledException", ["ProvisionedThroughputExceeded"]),
    ],
    ids=["request", "reason-sensei", "reason-list"],
)
def test_rn012_throttled_transaction_is_503_and_writes_nothing(
    academy: str, monkeypatch: pytest.MonkeyPatch, error: ClientError
) -> None:
    real_table = signature_repo.table

    class _Client:
        def transact_write_items(self, **kwargs: Any) -> None:
            raise error

    class _Table:
        def __init__(self, env_var: str) -> None:
            self.real = real_table(env_var)
            self.name = self.real.name
            self.meta = type("Meta", (), {"client": _Client()})()

        def get_item(self, **kwargs: Any) -> dict[str, Any]:
            return self.real.get_item(**kwargs)

    monkeypatch.setattr(signature_repo, "table", _Table)

    _assert_status(_create(user=SENSEI), 503, MSG_BUSY)

    monkeypatch.undo()
    assert _stored_list() is None


@pytest.mark.parametrize(
    "error",
    [_client_error("SlowDown"), ConnectTimeoutError(endpoint_url="https://s3")],
    ids=["slowdown", "network"],
)
def test_rn012_s3_failure_on_upload_is_503_and_writes_no_metadata(
    academy: str, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    signature_id = _created_id()
    before = _stored_list()
    monkeypatch.setattr(image_repo, "_client", lambda: _ThrottledS3(error))

    _assert_status(_put_image(signature_id), 503, MSG_BUSY)

    assert _stored_list() == before


@pytest.mark.parametrize("route", ["delete", "delete-image"])
def test_rn012_s3_failure_after_a_removal_keeps_the_204_and_leaves_only_an_orphan(
    academy: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, route: str
) -> None:
    # Metadata first: the image is gone from the API; the object is left
    # behind without metadata (logged), never metadata without the object.
    signature_id = _with_image()
    key = _image_key(signature_id)
    assert key is not None
    real_client = image_repo._client
    monkeypatch.setattr(
        image_repo, "_client", lambda: _ThrottledS3(ConnectTimeoutError(endpoint_url="x"))
    )

    with caplog.at_level(logging.ERROR):
        response = ROUTES[route](MASTER, signature_id)

    assert response["statusCode"] == 204, response.get("body")
    monkeypatch.setattr(image_repo, "_client", real_client)
    assert _image_key(signature_id) is None
    assert _bucket_keys() == [key]
    assert key in caplog.text
    assert ROUTES[route](MASTER, signature_id)["statusCode"] == 204


def test_rn012_settings_throttled_on_image_metadata_is_503_after_the_object(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    # S3 first, metadata after: the transaction fails and the new object is dropped.
    signature_id = _created_id()
    monkeypatch.setattr(
        signature_repo,
        "_write",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            signature_repo.ServiceUnavailableError(MSG_BUSY)
        ),
    )

    _assert_status(_put_image(signature_id), 503, MSG_BUSY)

    monkeypatch.undo()
    assert _bucket_keys() == []
    _assert_status(_get_image(signature_id), 404, MSG_NO_IMAGE)
    assert _put_image(signature_id)["statusCode"] == 200
    assert _get_image(signature_id)["statusCode"] == 200


# --- lost answers: re-read before the cleanup, ClientRequestToken (RN012) -----------------


def _signatures_client() -> Any:
    return signature_repo.table(signature_repo.SETTINGS_TABLE_ENV).meta.client


def _record_transactions(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Record the arguments of every signatures transaction (the real call still runs)."""
    client = _signatures_client()
    real = client.transact_write_items
    calls: list[dict[str, Any]] = []

    def record(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(client, "transact_write_items", record)
    return calls


def _lose_the_answer(monkeypatch: pytest.MonkeyPatch, commit: bool = True) -> list[bool]:
    """The next transactions commit (or not) and answer InternalServerError.

    Returns a list that gets one entry per transaction sent.
    """
    client = _signatures_client()
    real = client.transact_write_items
    sent: list[bool] = []

    def lose(**kwargs: Any) -> Any:
        sent.append(True)
        if commit:
            real(**kwargs)
        raise _client_error("InternalServerError")

    monkeypatch.setattr(client, "transact_write_items", lose)
    return sent


def _fail_rereads(monkeypatch: pytest.MonkeyPatch, sent: list[bool]) -> None:
    """``get_signatures`` fails once a transaction was sent (the re-read fails)."""
    real_get = signature_repo.get_signatures

    def get() -> Any:
        if sent:
            raise signature_repo.ServiceUnavailableError(MSG_BUSY)
        return real_get()

    monkeypatch.setattr(signature_repo, "get_signatures", get)


def test_rn012_every_transaction_sends_its_own_client_request_token(
    academy: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _record_transactions(monkeypatch)
    signature_id = _created_id()
    assert _put_image(signature_id)["statusCode"] == 200
    assert _delete_image(signature_id)["statusCode"] == 204

    tokens = [call.get("ClientRequestToken") for call in calls]
    assert len(tokens) == 3
    assert all(isinstance(token, str) and str(uuid.UUID(token)) == token for token in tokens)
    assert len(set(tokens)) == 3


def test_rn012_new_version_attempt_uses_a_new_token(
    academy: str, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    client = _signatures_client()
    real = client.transact_write_items
    tokens: list[str] = []

    def stale_once(**kwargs: Any) -> Any:
        tokens.append(kwargs["ClientRequestToken"])
        if len(tokens) == 1:
            raise _client_error("TransactionCanceledException", ["ConditionalCheckFailed"])
        return real(**kwargs)

    monkeypatch.setattr(client, "transact_write_items", stale_once)

    assert _create()["statusCode"] == 201
    assert len(tokens) == 2 and tokens[0] != tokens[1]


class _RawBody:
    def __init__(self, body: bytes) -> None:
        self.body = body

    def stream(self, **kwargs: Any) -> Any:
        yield self.body


def test_rn012_botocore_retries_resend_the_same_token(
    academy: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The first HTTP try commits (moto still runs) but answers 500, as if the
    # answer were lost; botocore resends the same request, with the same
    # token, which DynamoDB answers as a success without writing again. moto
    # ignores the token (its retry fails the version check and the change is
    # re-applied with a new token), so only the tokens are checked here.
    events = _signatures_client().meta.events
    bodies: list[str] = []

    def first_try_fails(request: Any, **kwargs: Any) -> Any:
        body = request.body
        bodies.append(body.decode() if isinstance(body, bytes) else body)
        if len(bodies) > 1:
            return None  # moto's answer is used
        error = b'{"__type":"com.amazonaws.dynamodb.v20120810#InternalServerError","message":"x"}'
        headers = {"Content-Type": "application/x-amz-json-1.0"}
        return AWSResponse(request.url, 500, headers, _RawBody(error))

    events.register_first("before-send.dynamodb.TransactWriteItems", first_try_fails)
    try:
        _create()
    finally:
        events.unregister("before-send.dynamodb.TransactWriteItems", first_try_fails)

    tokens = [json.loads(body)["ClientRequestToken"] for body in bodies]
    assert len(tokens) >= 2
    assert tokens[0] == tokens[1]  # botocore's retry of the same write
    assert all(token != tokens[0] for token in tokens[2:])  # a new version attempt


# --- definitive x ambiguous failures (RN012) ---------------------------------------------

DEFINITIVE_FAILURES = {
    "403-sensei": ForbiddenError(MSG_FORBIDDEN),
    "404": NotFoundError(MSG_NOT_FOUND),
    "409": ConflictError(rules.MSG_SIGNATURES_BUSY),
    "400": ValidationError("x"),
    "503": signature_repo.ServiceUnavailableError(MSG_BUSY),
    "stale": signature_repo.StaleListError(),
    "throttling": _client_error("ThrottlingException"),
    "provisioned": _client_error("ProvisionedThroughputExceededException"),
    "request-limit": _client_error("RequestLimitExceeded"),
    "validation": _client_error("ValidationException"),
    "cancel-condition": _client_error(
        "TransactionCanceledException", ["None", "ConditionalCheckFailed"]
    ),
    "cancel-sensei": _client_error("TransactionCanceledException", ["ConditionalCheckFailed"]),
    "cancel-conflict": _client_error("TransactionCanceledException", ["TransactionConflict"]),
    "cancel-throttled": _client_error("TransactionCanceledException", ["None", "ThrottlingError"]),
    "cancel-provisioned": _client_error(
        "TransactionCanceledException", ["ProvisionedThroughputExceeded"]
    ),
    "cancel-validation": _client_error("TransactionCanceledException", ["ValidationError"]),
}

AMBIGUOUS_FAILURES = {
    "internal-server-error": _client_error("InternalServerError"),
    "service-unavailable": _client_error("ServiceUnavailable"),
    "unknown-code": _client_error("TransactionInProgressException"),
    "cancel-without-reasons": _client_error("TransactionCanceledException"),
    "cancel-unknown-reason": _client_error("TransactionCanceledException", ["None", "Other"]),
    "connection-closed": ConnectionClosedError(endpoint_url="https://dynamodb.example"),
    "read-timeout": ReadTimeoutError(endpoint_url="https://dynamodb.example"),
    "endpoint-connection": EndpointConnectionError(endpoint_url="https://dynamodb.example"),
    "unknown-exception": RuntimeError("boom"),
}


@pytest.mark.parametrize("error", DEFINITIVE_FAILURES.values(), ids=DEFINITIVE_FAILURES.keys())
def test_rn012_definitive_write_failures_are_classified(error: Exception) -> None:
    assert signature_repo.is_definitive_write_failure(error) is True


@pytest.mark.parametrize("error", AMBIGUOUS_FAILURES.values(), ids=AMBIGUOUS_FAILURES.keys())
def test_rn012_ambiguous_write_failures_are_classified(error: Exception) -> None:
    assert signature_repo.is_definitive_write_failure(error) is False


def _fail_transactions(
    monkeypatch: pytest.MonkeyPatch, error: Exception, commit: bool = False
) -> list[bool]:
    """The next transactions commit (or not) and then raise ``error``."""
    client = _signatures_client()
    real = client.transact_write_items
    sent: list[bool] = []

    def fail(**kwargs: Any) -> Any:
        sent.append(True)
        if commit:
            real(**kwargs)
        raise error

    monkeypatch.setattr(client, "transact_write_items", fail)
    return sent


def _count_reads_after_send(monkeypatch: pytest.MonkeyPatch, sent: list[bool]) -> list[bool]:
    """Record the list reads made once a transaction was sent (the re-reads)."""
    real_get = signature_repo.get_signatures
    rereads: list[bool] = []

    def get() -> Any:
        if sent:
            rereads.append(True)
        return real_get()

    monkeypatch.setattr(signature_repo, "get_signatures", get)
    return rereads


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (_client_error("TransactionCanceledException", ["ConditionalCheckFailed", "None"]), 403),
        (_client_error("ThrottlingException"), 503),
        (_client_error("TransactionCanceledException", ["None", "ThrottlingError"]), 503),
        (_client_error("ValidationException"), 500),
    ],
    ids=["sensei-replaced", "throttled", "reason-throttled", "validation"],
)
def test_rn012_upload_refused_definitively_deletes_the_new_key_without_rereading(
    academy: str, monkeypatch: pytest.MonkeyPatch, error: ClientError, status: int
) -> None:
    signature_id = _with_image()
    before = _stored_list()
    before_keys = _bucket_keys()
    sent = _fail_transactions(monkeypatch, error)
    rereads = _count_reads_after_send(monkeypatch, sent)

    response = _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"), SENSEI)

    assert response["statusCode"] == status, response.get("body")
    assert rereads == []
    monkeypatch.undo()
    assert _stored_list() == before
    assert _bucket_keys() == before_keys
    assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")


@pytest.mark.parametrize("commit", [True, False], ids=["recorded", "not-recorded"])
@pytest.mark.parametrize("error", AMBIGUOUS_FAILURES.values(), ids=AMBIGUOUS_FAILURES.keys())
def test_rn012_upload_failed_ambiguously_never_deletes_the_new_key(
    academy: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
    commit: bool,
) -> None:
    # A transaction still in flight may commit after any re-read, so the new
    # key is kept even when the list does not point to it (yet): an orphan is
    # acceptable, metadata pointing to a deleted object are not.
    signature_id = _with_image()
    previous = _image_key(signature_id)
    before = _stored_list()
    sent = _fail_transactions(monkeypatch, error, commit=commit)
    rereads = _count_reads_after_send(monkeypatch, sent)

    with caplog.at_level(logging.ERROR):
        response = _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"))

    assert response["statusCode"] in (500, 503), response.get("body")
    assert rereads == []
    monkeypatch.undo()
    new_key = next(key for key in _bucket_keys() if key != previous)
    assert sorted(_bucket_keys()) == sorted([previous, new_key])
    assert new_key in caplog.text
    if commit:
        assert _image_key(signature_id) == new_key
        assert read_signature_image(academy, signature_id) == (JPEG_BYTES, "image/jpeg")
    else:
        assert _stored_list() == before
        assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")


def test_rn012_upload_recorded_after_an_ambiguous_failure_points_to_an_existing_object(
    academy: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The transaction was still in flight when the call failed and commits
    # after the handler answered: the object it records must still exist.
    signature_id = _created_id()
    pending: list[dict[str, Any]] = []
    client = _signatures_client()
    real = client.transact_write_items

    def send_and_time_out(**kwargs: Any) -> Any:
        pending.append(kwargs)
        raise ReadTimeoutError(endpoint_url="https://dynamodb.example")

    monkeypatch.setattr(client, "transact_write_items", send_and_time_out)
    response = _put_image(signature_id, _image(JPEG_BYTES, "image/jpeg"))
    monkeypatch.undo()
    assert response["statusCode"] == 500, response.get("body")

    real(**pending[0])  # DynamoDB applies it only now

    assert read_signature_image(academy, signature_id) == (JPEG_BYTES, "image/jpeg")


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (_client_error("TransactionCanceledException", ["ConditionalCheckFailed", "None"]), 403),
        (_client_error("ThrottlingException"), 503),
        (_client_error("ValidationException"), 500),
    ],
    ids=["sensei-replaced", "throttled", "validation"],
)
@pytest.mark.parametrize("route", ["delete", "delete-image"])
def test_rn012_removal_refused_definitively_keeps_the_image_without_rereading(
    academy: str, monkeypatch: pytest.MonkeyPatch, error: ClientError, status: int, route: str
) -> None:
    signature_id = _with_image()
    before = _stored_list()
    key = _image_key(signature_id)
    sent = _fail_transactions(monkeypatch, error)
    rereads = _count_reads_after_send(monkeypatch, sent)

    response = ROUTES[route](SENSEI, signature_id)

    assert response["statusCode"] == status, response.get("body")
    assert rereads == []
    monkeypatch.undo()
    assert _stored_list() == before
    assert _bucket_keys() == [key]
    assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")


@pytest.mark.parametrize("commit", [True, False], ids=["recorded", "not-recorded"])
@pytest.mark.parametrize(
    "error",
    [
        ConnectionClosedError(endpoint_url="https://dynamodb.example"),
        ReadTimeoutError(endpoint_url="https://dynamodb.example"),
        EndpointConnectionError(endpoint_url="https://dynamodb.example"),
        _client_error("ServiceUnavailable"),
        RuntimeError("boom"),
    ],
    ids=["connection-closed", "read-timeout", "endpoint-connection", "5xx", "unknown"],
)
@pytest.mark.parametrize("route", ["delete", "delete-image"])
def test_rn012_removal_failed_ambiguously_deletes_the_key_only_if_unreferenced(
    academy: str, monkeypatch: pytest.MonkeyPatch, error: Exception, route: str, commit: bool
) -> None:
    signature_id = _with_image()
    key = _image_key(signature_id)
    _fail_transactions(monkeypatch, error, commit=commit)

    response = ROUTES[route](MASTER, signature_id)

    assert response["statusCode"] == 500, response.get("body")
    monkeypatch.undo()
    if commit:
        assert _image_key(signature_id) is None
        assert _bucket_keys() == []
    else:
        assert _bucket_keys() == [key]
        assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")


@pytest.mark.parametrize("route", ["delete", "delete-image"])
def test_rn012_removal_with_lost_answer_deletes_the_old_key(
    academy: str, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    signature_id = _with_image()
    _lose_the_answer(monkeypatch)

    response = ROUTES[route](MASTER, signature_id)

    assert response["statusCode"] == 500, response.get("body")
    monkeypatch.undo()
    assert _image_key(signature_id) is None
    assert _bucket_keys() == []


@pytest.mark.parametrize("route", ["delete", "delete-image"])
def test_rn012_removal_not_recorded_keeps_the_image(
    academy: str, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    signature_id = _with_image()
    before = _stored_list()
    _lose_the_answer(monkeypatch, commit=False)

    response = ROUTES[route](MASTER, signature_id)

    assert response["statusCode"] == 500, response.get("body")
    monkeypatch.undo()
    assert _stored_list() == before
    assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")


@pytest.mark.parametrize("commit", [True, False], ids=["recorded", "not-recorded"])
@pytest.mark.parametrize("route", ["delete", "delete-image"])
def test_rn012_removal_failure_with_failed_reread_deletes_nothing(
    academy: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    route: str,
    commit: bool,
) -> None:
    signature_id = _with_image()
    key = _image_key(signature_id)
    _fail_rereads(monkeypatch, _lose_the_answer(monkeypatch, commit=commit))

    with caplog.at_level(logging.ERROR):
        response = ROUTES[route](MASTER, signature_id)

    assert response["statusCode"] == 500, response.get("body")
    monkeypatch.undo()
    assert _bucket_keys() == [key]
    assert key is not None and key in caplog.text
    if not commit:
        assert read_signature_image(academy, signature_id) == (PNG_BYTES, "image/png")
