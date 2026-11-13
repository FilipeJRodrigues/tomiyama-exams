"""QA coverage for who edits what in ``PUT /belts/{id}`` (RN001, RN002, RN015; card #142).

Edge cases beyond ``test_belt_permissions.py``: odd JSON types on the master's
fields (``True == 1`` in Python, so a bool must never pass as the stored
integer), null x missing x empty optional fields, case and Unicode in the
name, the groups claim as the HTTP API sends it, a ``master`` without
``admin``, an ``id`` in the body, and the "last write wins" when the master
saves a form read before the examiner's edit.
"""

import os
from dataclasses import replace
from typing import Any

import boto3
import pytest
from conftest import (
    EXAMINER,
    MASTER,
    api_event,
    assert_service_busy,
    belt,
    response_json,
    throttle_dynamodb,
)

from domain.belts import Belt
from domain.users import ADMIN_GROUP, MASTER_GROUP, User
from handlers import belts as belt_handlers
from repository import belts as belt_repo
from repository.tables import BELTS_TABLE_ENV

MSG_MASTER_ONLY = "Somente o administrador master altera nome, kyū, ordem, nível e cores da faixa"
MSG_EXAMINERS_ONLY = "Esta área é dos examinadores"


def _stored_items() -> dict[str, dict[str, Any]]:
    table = boto3.resource("dynamodb").Table(os.environ["BELTS_TABLE"])
    return {item["id"]: item for item in table.scan(ConsistentRead=True)["Items"]}


def _stored(source: Belt) -> Belt:
    stored = belt_repo.get_belt(source.id, consistent=True)
    assert stored is not None
    return stored


def _form(source: Belt, **changes: Any) -> dict[str, Any]:
    return {**{key: value for key, value in source.to_dict().items() if key != "id"}, **changes}


def _put(user: User | None, source: Belt, **changes: Any) -> dict[str, Any]:
    event = api_event(user, body=_form(source, **changes), path={"id": source.id})
    return belt_handlers.update_belt(event, None)


# --- odd types on the master's fields are a 400, never a silent 200 ----------------------------

# (belt, field, value equal to the stored one under Python ``==`` but not a valid field, message)
ODD_TYPES = [
    ("Marrom", "kyu", True, "Kyū: deve ser um número inteiro"),  # True == 1 == stored kyū
    ("Branca/Cinza", "sort_order", True, "Ordem: deve ser um número inteiro"),  # True == 1
    ("Branca", "sort_order", False, "Ordem: deve ser um número inteiro"),  # False == 0
    ("Cinza", "kyu", 10.0, "Kyū: deve ser um número inteiro"),  # 10.0 == 10
    ("Cinza", "sort_order", 2.0, "Ordem: deve ser um número inteiro"),
    ("Cinza", "sort_order", "2", "Ordem: deve ser um número inteiro"),
    ("Cinza", "kyu", "10", "Kyū: deve ser um número inteiro"),
    ("Branca", "kyu", 0, "Kyū: deve estar entre 1 e 11"),  # 0 is not "no kyū"
    ("Branca", "kyu", "", "Kyū: deve ser um número inteiro"),
    ("Cinza", "level", "basic", "Nível: valor inválido"),
    ("Cinza", "name", ["Cinza"], "Nome: valor inválido"),
    ("Cinza", "color_primary", ["#9E9E9E"], "Cor: use o formato #RRGGBB"),
    ("Cinza", "color_primary", "#9E9E9E\n", "Cor: use o formato #RRGGBB"),
]


@pytest.mark.parametrize(
    ("belt_name", "field", "value", "message"),
    ODD_TYPES,
    ids=[f"{name}-{field}-{value!r}" for name, field, value, _ in ODD_TYPES],
)
def test_rn015_examiner_odd_type_on_master_field_is_400_and_writes_nothing(
    seeded: list[Belt], belt_name: str, field: str, value: Any, message: str
) -> None:
    before = _stored_items()

    response = _put(EXAMINER, belt(belt_name), min_age_years=3, **{field: value})

    assert response["statusCode"] == 400, response.get("body")
    assert response_json(response) == {"message": message}
    assert _stored_items() == before


# --- null x missing x empty optional fields ----------------------------------------------------


@pytest.mark.parametrize("how", ["null", "missing"])
def test_rn015_examiner_no_kyu_on_belt_without_kyu_is_200(seeded: list[Belt], how: str) -> None:
    branca = belt("Branca")
    form = _form(branca, min_age_years=1)
    if how == "missing":
        del form["kyu"]

    response = belt_handlers.update_belt(
        api_event(EXAMINER, body=form, path={"id": branca.id}), None
    )

    assert response["statusCode"] == 200, response.get("body")
    assert _stored(branca) == replace(branca, min_age_years=1)


@pytest.mark.parametrize("how", ["null", "missing"])
def test_rn015_examiner_dropping_kyu_of_belt_with_kyu_is_403(seeded: list[Belt], how: str) -> None:
    marrom = belt("Marrom")
    form = _form(marrom, min_age_years=15)
    if how == "missing":
        del form["kyu"]
    else:
        form["kyu"] = None
    before = _stored_items()

    response = belt_handlers.update_belt(
        api_event(EXAMINER, body=form, path={"id": marrom.id}), None
    )

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


def test_rn015_examiner_empty_tips_on_two_colour_belt_is_403(seeded: list[Belt]) -> None:
    before = _stored_items()

    response = _put(EXAMINER, belt("Amarela/Laranja"), color_secondary="", min_age_years=11)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


def test_rn015_examiner_missing_tips_on_one_colour_belt_is_200(seeded: list[Belt]) -> None:
    cinza = belt("Cinza")
    form = _form(cinza, min_months_previous=4)
    del form["color_secondary"]

    response = belt_handlers.update_belt(
        api_event(EXAMINER, body=form, path={"id": cinza.id}), None
    )

    assert response["statusCode"] == 200, response.get("body")
    assert "color_secondary" not in _stored_items()[cinza.id]


# --- name: case, whitespace and Unicode --------------------------------------------------------


@pytest.mark.parametrize("name", ["CINZA", "cinza", "Cinza.", "Cinza 2", "Cínza"])
def test_rn015_examiner_other_spelling_of_name_is_403(seeded: list[Belt], name: str) -> None:
    before = _stored_items()

    response = _put(EXAMINER, belt("Cinza"), name=name)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


@pytest.mark.parametrize("name", ["Cinza\t", "\nCinza", " Cinza　"])
def test_rn015_examiner_name_with_blank_ends_is_the_stored_name(
    seeded: list[Belt], name: str
) -> None:
    cinza = belt("Cinza")

    response = _put(EXAMINER, cinza, name=name, min_age_years=6)

    assert response["statusCode"] == 200, response.get("body")
    assert _stored(cinza) == replace(cinza, min_age_years=6)


def test_rn015_examiner_resends_accented_name_set_by_master(seeded: list[Belt]) -> None:
    cinza = belt("Cinza")
    assert _put(MASTER, cinza, name="Cinza-ébano ✓")["statusCode"] == 200
    renamed = _stored(cinza)

    response = _put(EXAMINER, renamed, min_age_years=6)

    assert response["statusCode"] == 200, response.get("body")
    assert _stored(cinza) == replace(renamed, min_age_years=6)


# --- who is the master ------------------------------------------------------------------------


def test_rn015_master_group_without_admin_is_not_an_examiner(seeded: list[Belt]) -> None:
    only_master = User(sub="only-master", email=None, groups=frozenset({MASTER_GROUP}))
    before = _stored_items()

    for changes in ({"min_age_years": 6}, {"name": "Cinza clara"}):
        response = _put(only_master, belt("Cinza"), **changes)

        assert response["statusCode"] == 403
        assert response_json(response) == {"message": MSG_EXAMINERS_ONLY}
    assert _stored_items() == before


@pytest.mark.parametrize("claim", ["[admin master]", "[master admin]", '["admin","master"]'])
def test_rn015_master_from_flattened_groups_claim_renames(seeded: list[Belt], claim: str) -> None:
    # The HTTP API JWT authorizer flattens ``cognito:groups`` into a string.
    cinza = belt("Cinza")
    event = api_event(MASTER, body=_form(cinza, name="Cinza clara"), path={"id": cinza.id})
    event["requestContext"]["authorizer"]["jwt"]["claims"]["cognito:groups"] = claim

    response = belt_handlers.update_belt(event, None)

    assert response["statusCode"] == 200, response.get("body")
    assert _stored(cinza).name == "Cinza clara"


@pytest.mark.parametrize("claim", ["[admin]", "admin", "[admin masters]", "[admin, Master]"])
def test_rn015_examiner_claim_without_exact_master_group_cannot_rename(
    seeded: list[Belt], claim: str
) -> None:
    cinza = belt("Cinza")
    event = api_event(MASTER, body=_form(cinza, name="Cinza clara"), path={"id": cinza.id})
    event["requestContext"]["authorizer"]["jwt"]["claims"]["cognito:groups"] = claim
    before = _stored_items()

    response = belt_handlers.update_belt(event, None)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


def test_rn015_admin_and_master_constants_are_the_cognito_groups() -> None:
    assert (ADMIN_GROUP, MASTER_GROUP) == ("admin", "master")


# --- the body cannot redirect the write --------------------------------------------------------


def test_rn015_examiner_id_in_body_is_ignored(seeded: list[Belt]) -> None:
    cinza, azul = belt("Cinza"), belt("Azul")
    before = _stored_items()

    response = _put(EXAMINER, cinza, id=azul.id, min_age_years=6)

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response)["id"] == cinza.id
    after = _stored_items()
    assert after[azul.id] == before[azul.id]
    assert _stored(cinza) == replace(cinza, min_age_years=6)


def test_rn015_examiner_unknown_fields_are_not_stored(seeded: list[Belt]) -> None:
    cinza = belt("Cinza")

    response = _put(EXAMINER, cinza, min_age_years=6, owner="x", extra={"a": 1})

    assert response["statusCode"] == 200, response.get("body")
    assert set(_stored_items()[cinza.id]) == set(cinza.to_dict()) - {"color_secondary"}


# --- order of the checks ------------------------------------------------------------------------


def test_rn015_examiner_invalid_number_with_master_field_change_is_400(seeded: list[Belt]) -> None:
    # 400 (body) comes before 403 (master rule), for the examiner's own fields too.
    before = _stored_items()

    response = _put(EXAMINER, belt("Cinza"), sort_order=50, min_months_previous=241)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Carência: deve estar entre 0 e 240"}
    assert _stored_items() == before


def test_rn015_examiner_never_sees_the_uniqueness_409(seeded: list[Belt]) -> None:
    # A name or order taken by another belt is a change: the examiner gets the 403.
    before = _stored_items()

    for changes in ({"name": "Azul"}, {"sort_order": 4}):
        response = _put(EXAMINER, belt("Cinza"), **changes)

        assert response["statusCode"] == 403, changes
        assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


def test_rn015_examiner_missing_belt_with_invalid_body_is_404(seeded: list[Belt]) -> None:
    event = api_event(EXAMINER, path={"id": "nao-existe"})
    event["body"] = "{nome"

    response = belt_handlers.update_belt(event, None)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": "Faixa não encontrada"}


# --- last write wins (documented) ---------------------------------------------------------------


def test_rn015_master_saving_form_read_before_examiner_edit_keeps_the_masters_numbers(
    seeded: list[Belt],
) -> None:
    # The master opened the form before the examiner saved the numbers; his save
    # rewrites the whole belt, numbers included ("last write wins", README).
    cinza = belt("Cinza")
    master_form = _form(cinza, name="Cinza clara")

    assert _put(EXAMINER, cinza, min_age_years=8, min_months_previous=9)["statusCode"] == 200
    response = belt_handlers.update_belt(
        api_event(MASTER, body=master_form, path={"id": cinza.id}), None
    )

    assert response["statusCode"] == 200
    assert _stored(cinza) == replace(cinza, name="Cinza clara")


def test_rn015_examiner_response_is_the_stored_belt_after_the_write(seeded: list[Belt]) -> None:
    cinza = belt("Cinza")

    response = _put(EXAMINER, cinza, min_age_years=6)

    assert response_json(response) == _stored(cinza).to_dict()


# --- throttling goes through the repository helpers, not the #43 safety net -------------------


@pytest.mark.parametrize("operation", ["GetItem", "UpdateItem"])
def test_rn015_examiner_throttling_is_handled_by_the_repository(
    seeded: list[Belt],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    operation: str,
) -> None:
    # The safety net of ``api_handler`` also answers 503, but logs an ERROR
    # meaning "a call skipped raise_if_throttled": the examiner's read and
    # write must not reach it.
    stub = throttle_dynamodb(monkeypatch, operation, BELTS_TABLE_ENV)

    with caplog.at_level("INFO"):
        response = _put(EXAMINER, belt("Cinza"), min_age_years=6)
    stub.active = False

    assert_service_busy(response, stub)
    assert [record for record in caplog.records if record.levelname in {"ERROR", "CRITICAL"}] == []
