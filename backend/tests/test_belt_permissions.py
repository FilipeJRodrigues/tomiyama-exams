"""Who edits what in ``PUT /belts/{id}`` (RN001, RN002, RN015; card #142).

Decision of the user (2026-11-12, option A): the admin master (groups
``master`` + ``admin``) changes every field of a belt. Any other examiner
changes only the minimum age (RN001) and the months in the previous belt
(RN002); sending another field with a value different from the stored one is a
403 "Somente o administrador master altera nome, kyū, ordem, nível e cores da
faixa" and nothing is written, while resending the stored value (the form sends
every field) is accepted. The examiner's write touches only those two fields,
so a concurrent edit by the master is kept.
"""

import os
from dataclasses import replace
from typing import Any

import boto3
import pytest
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    DYNAMODB_WRITES,
    EXAMINER,
    GUARDIAN,
    MASTER,
    api_event,
    assert_service_busy,
    belt,
    belt_id,
    dynamodb_snapshot,
    lag_eventual_reads,
    response_json,
    throttle_dynamodb,
)

from domain.belts import (
    EXAMINER_EDITABLE_FIELDS,
    MASTER_ONLY_FIELDS,
    MSG_MASTER_ONLY_BELT_FIELDS,
    Belt,
)
from domain.users import User
from handlers import belts as belt_handlers
from repository import belts as belt_repo
from repository.tables import BELTS_TABLE_ENV

MSG_MASTER_ONLY = "Somente o administrador master altera nome, kyū, ordem, nível e cores da faixa"
MSG_EXAMINERS_ONLY = "Esta área é dos examinadores"
MSG_BELT_NOT_FOUND = "Faixa não encontrada"


def _stored_items() -> dict[str, dict[str, Any]]:
    """Every raw item of the belts table, by id (strongly consistent)."""
    table = boto3.resource("dynamodb").Table(os.environ["BELTS_TABLE"])
    return {item["id"]: item for item in table.scan(ConsistentRead=True)["Items"]}


def _stored(belt_name: str) -> Belt:
    stored = belt_repo.get_belt(belt_id(belt_name), consistent=True)
    assert stored is not None
    return stored


def _form(source: Belt, **changes: Any) -> dict[str, Any]:
    """The body the screen sends: every field of the belt but the id."""
    return {**{key: value for key, value in source.to_dict().items() if key != "id"}, **changes}


def _put(user: User | None, source: Belt, **changes: Any) -> dict[str, Any]:
    event = api_event(user, body=_form(source, **changes), path={"id": source.id})
    return belt_handlers.update_belt(event, None)


def test_rn015_master_only_message_is_the_agreed_one() -> None:
    assert MSG_MASTER_ONLY_BELT_FIELDS == MSG_MASTER_ONLY
    assert set(MASTER_ONLY_FIELDS) | set(EXAMINER_EDITABLE_FIELDS) == set(Belt.__annotations__) - {
        "id"
    }


# --- RN001 / RN002: any examiner edits the minimum age and the months -----------------------


@pytest.mark.parametrize("age", [0, 1, 98, 99])
def test_rn001_examiner_sets_minimum_age_within_limits(seeded: list[Belt], age: int) -> None:
    cinza = belt("Cinza")

    response = _put(EXAMINER, cinza, min_age_years=age)

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response) == {**cinza.to_dict(), "min_age_years": age}
    assert _stored("Cinza") == replace(cinza, min_age_years=age)


@pytest.mark.parametrize("age", [-1, 100, 10**38])
def test_rn001_examiner_minimum_age_out_of_limits_is_400(seeded: list[Belt], age: int) -> None:
    before = _stored_items()

    response = _put(EXAMINER, belt("Cinza"), min_age_years=age)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Idade mínima: deve estar entre 0 e 99"}
    assert _stored_items() == before


@pytest.mark.parametrize("months", [0, 1, 239, 240])
def test_rn002_examiner_sets_months_in_previous_belt_within_limits(
    seeded: list[Belt], months: int
) -> None:
    azul = belt("Azul")

    response = _put(EXAMINER, azul, min_months_previous=months)

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response) == {**azul.to_dict(), "min_months_previous": months}
    assert _stored("Azul") == replace(azul, min_months_previous=months)


@pytest.mark.parametrize("months", [-1, 241, 10**38])
def test_rn002_examiner_months_out_of_limits_is_400(seeded: list[Belt], months: int) -> None:
    before = _stored_items()

    response = _put(EXAMINER, belt("Azul"), min_months_previous=months)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Carência: deve estar entre 0 e 240"}
    assert _stored_items() == before


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("min_age_years", "7", "Idade mínima: deve ser um número inteiro"),
        ("min_age_years", 7.5, "Idade mínima: deve ser um número inteiro"),
        ("min_age_years", True, "Idade mínima: deve ser um número inteiro"),
        ("min_age_years", None, "Campo obrigatório: Idade mínima"),
        ("min_months_previous", "6", "Carência: deve ser um número inteiro"),
        ("min_months_previous", None, "Campo obrigatório: Carência"),
    ],
)
def test_rn001_rn002_examiner_numbers_must_be_integers(
    seeded: list[Belt], field: str, value: Any, message: str
) -> None:
    before = _stored_items()

    response = _put(EXAMINER, belt("Cinza"), **{field: value})

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": message}
    assert _stored_items() == before


def test_rn001_rn002_examiner_changes_both_numbers_at_once(seeded: list[Belt]) -> None:
    roxa = belt("Roxa")

    response = _put(EXAMINER, roxa, min_age_years=15, min_months_previous=18)

    assert response["statusCode"] == 200
    stored = _stored("Roxa")
    assert (stored.min_age_years, stored.min_months_previous) == (15, 18)
    assert stored == replace(roxa, min_age_years=15, min_months_previous=18)


# --- RN015: the master changes every field -----------------------------------------------------


def test_rn015_master_changes_every_field(seeded: list[Belt]) -> None:
    cinza = belt("Cinza")
    changes = {
        "name": "Cinza clara",
        "kyu": 9,
        "sort_order": 50,
        "level": "INTERMEDIATE",
        "min_age_years": 6,
        "min_months_previous": 4,
        "color_primary": "#AAAAAA",
        "color_secondary": "#123456",
    }

    response = _put(MASTER, cinza, **changes)

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response) == {"id": cinza.id, **changes}
    assert _stored("Cinza").to_dict() == {"id": cinza.id, **changes}


def test_rn015_master_removes_kyu_and_tips(seeded: list[Belt]) -> None:
    two_colours = belt("Cinza/Azul")

    response = _put(MASTER, two_colours, kyu=None, color_secondary=None)

    assert response["statusCode"] == 200, response.get("body")
    stored = _stored_items()[two_colours.id]
    assert "kyu" not in stored and "color_secondary" not in stored


# --- RN015: any other examiner may not change the master's fields ------------------------------

# (belt, field, a valid value different from the stored one)
MASTER_ONLY_CHANGES = [
    ("Cinza", "name", "Cinza clara"),
    ("Cinza", "name", "cinza"),  # case counts: "cinza" is not what is stored
    ("Cinza", "kyu", 9),
    ("Cinza", "kyu", None),  # removing the kyū
    ("Branca", "kyu", 11),  # adding one to the belt without kyū
    ("Cinza", "sort_order", 50),
    ("Cinza", "level", "INTERMEDIATE"),
    ("Cinza", "color_primary", "#000000"),
    ("Cinza", "color_secondary", "#FFFFFF"),  # adding tips
    ("Cinza/Azul", "color_secondary", None),  # removing tips
    ("Cinza/Azul", "color_secondary", "#000000"),  # other tips
]


@pytest.mark.parametrize(
    ("belt_name", "field", "value"),
    MASTER_ONLY_CHANGES,
    ids=[f"{name}-{field}-{value}" for name, field, value in MASTER_ONLY_CHANGES],
)
def test_rn015_examiner_changing_master_field_is_403_and_writes_nothing(
    seeded: list[Belt], belt_name: str, field: str, value: Any
) -> None:
    source = belt(belt_name)
    assert getattr(source, field) != value
    before = _stored_items()

    response = _put(EXAMINER, source, **{field: value})

    assert response["statusCode"] == 403, response.get("body")
    assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


def test_rn015_examiner_missing_tips_on_two_colour_belt_is_a_change(seeded: list[Belt]) -> None:
    # A missing optional field means "none", which differs from the stored tips.
    two_colours = belt("Cinza/Azul")
    form = _form(two_colours, min_age_years=7)
    del form["color_secondary"]
    before = _stored_items()

    response = belt_handlers.update_belt(
        api_event(EXAMINER, body=form, path={"id": two_colours.id}), None
    )

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


def test_rn015_examiner_refused_change_does_not_write_the_numbers_either(
    seeded: list[Belt],
) -> None:
    before = _stored_items()

    response = _put(
        EXAMINER, belt("Cinza"), name="Cinza clara", min_age_years=8, min_months_previous=9
    )

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MASTER_ONLY}
    assert _stored_items() == before


def test_rn015_examiner_resending_the_stored_values_is_200(seeded: list[Belt]) -> None:
    for name in ("Branca", "Cinza", "Cinza/Azul", "Marrom"):
        source = belt(name)

        response = _put(EXAMINER, source)

        assert response["statusCode"] == 200, (name, response.get("body"))
        assert response_json(response) == source.to_dict()
        assert _stored(name) == source


def test_rn015_examiner_resending_values_that_normalise_to_the_stored_ones_is_200(
    seeded: list[Belt],
) -> None:
    # Compared after validation: the name is trimmed and colours go to upper case.
    two_colours = belt("Cinza/Azul")

    response = _put(
        EXAMINER,
        two_colours,
        name=f"  {two_colours.name} ",
        color_primary=two_colours.color_primary.lower(),
        color_secondary=(two_colours.color_secondary or "").lower(),
        min_age_years=7,
    )

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response) == {**two_colours.to_dict(), "min_age_years": 7}


def test_rn015_examiner_resending_an_empty_tips_colour_on_a_one_colour_belt_is_200(
    seeded: list[Belt],
) -> None:
    for empty in ("", None):
        response = _put(EXAMINER, belt("Cinza"), color_secondary=empty, min_age_years=6)

        assert response["statusCode"] == 200, response.get("body")
        assert response_json(response)["color_secondary"] is None


# --- permission, order of the checks and missing belt ------------------------------------------


@pytest.mark.parametrize("changes", [{"min_age_years": 6}, {"name": "Cinza clara"}, {}])
def test_rn015_guardian_is_403_before_anything_else(
    seeded: list[Belt], changes: dict[str, Any]
) -> None:
    before = _stored_items()

    response = _put(GUARDIAN, belt("Cinza"), **changes)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_EXAMINERS_ONLY}
    assert _stored_items() == before


def test_rn015_guardian_with_missing_belt_is_still_403(seeded: list[Belt]) -> None:
    event = api_event(GUARDIAN, body=_form(belt("Cinza")), path={"id": "nao-existe"})

    response = belt_handlers.update_belt(event, None)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_EXAMINERS_ONLY}


def test_rn015_login_is_required(seeded: list[Belt]) -> None:
    assert _put(None, belt("Cinza"), min_age_years=6)["statusCode"] == 401


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
@pytest.mark.parametrize("changes", [{"min_age_years": 6}, {"name": "Cinza clara"}])
def test_rn015_missing_belt_is_404_and_creates_nothing(
    seeded: list[Belt], user: User, changes: dict[str, Any]
) -> None:
    before = _stored_items()
    event = api_event(user, body=_form(belt("Cinza"), **changes), path={"id": "nao-existe"})

    response = belt_handlers.update_belt(event, None)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": MSG_BELT_NOT_FOUND}
    assert _stored_items() == before


def test_rn015_examiner_invalid_body_is_400_before_the_master_rule(seeded: list[Belt]) -> None:
    # The body is validated before the master rule: a different name with an
    # invalid colour answers the colour's 400, not the 403.
    before = _stored_items()

    response = _put(EXAMINER, belt("Cinza"), name="Cinza clara", color_primary="cinza")

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Cor: use o formato #RRGGBB"}
    assert _stored_items() == before


@pytest.mark.parametrize(
    "missing", ["name", "sort_order", "level", "color_primary", "min_age_years"]
)
def test_rn015_examiner_must_still_send_every_required_field(
    seeded: list[Belt], missing: str
) -> None:
    form = _form(belt("Cinza"))
    del form[missing]
    before = _stored_items()

    response = belt_handlers.update_belt(
        api_event(EXAMINER, body=form, path={"id": belt_id("Cinza")}), None
    )

    assert response["statusCode"] == 400
    assert response_json(response)["message"].startswith("Campo obrigatório: ")
    assert _stored_items() == before


def test_rn015_examiner_body_that_is_not_json_is_400(seeded: list[Belt]) -> None:
    event = api_event(EXAMINER, path={"id": belt_id("Cinza")})
    event["body"] = "{nome"

    response = belt_handlers.update_belt(event, None)

    assert response["statusCode"] == 400
    assert response_json(response) == {
        "message": "Corpo da requisição inválido: envie um objeto JSON"
    }


# --- concurrency and consistency ----------------------------------------------------------------


def _record_writes(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """Record every DynamoDB write on the belts table (operation, parameters)."""
    from botocore.client import BaseClient

    table_name = os.environ["BELTS_TABLE"]
    calls: list[tuple[str, dict[str, Any]]] = []
    original = BaseClient._make_api_call

    def recording(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name in DYNAMODB_WRITES and api_params.get("TableName") == table_name:
            calls.append((operation_name, dict(api_params)))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", recording)
    return calls


def test_rn015_master_rename_between_examiner_read_and_write_is_kept(
    seeded: list[Belt], monkeypatch: pytest.MonkeyPatch
) -> None:
    cinza = belt("Cinza")
    original_save = belt_repo.save_examiner_fields
    master_answers: list[dict[str, Any]] = []

    def master_edits_first(updated: Belt) -> Belt:
        # The examiner already read the belt; the master renames it right now.
        master_answers.append(
            _put(MASTER, cinza, name="Cinza clara", color_primary="#AAAAAA", sort_order=40)
        )
        return original_save(updated)

    monkeypatch.setattr(belt_repo, "save_examiner_fields", master_edits_first)
    writes = _record_writes(monkeypatch)

    response = _put(EXAMINER, cinza, min_age_years=6, min_months_previous=5)

    assert [answer["statusCode"] for answer in master_answers] == [200]
    assert response["statusCode"] == 200, response.get("body")
    expected = {
        **cinza.to_dict(),
        "name": "Cinza clara",
        "color_primary": "#AAAAAA",
        "sort_order": 40,
        "min_age_years": 6,
        "min_months_previous": 5,
    }
    # The answer is the belt as stored, with the master's edit.
    assert response_json(response) == expected
    assert _stored("Cinza").to_dict() == expected
    # The examiner's write is an UpdateItem of the two fields only.
    operation, params = writes[-1]
    assert operation == "UpdateItem"
    assert set(params["ExpressionAttributeNames"].values()) == set(EXAMINER_EDITABLE_FIELDS)
    assert params["ConditionExpression"] == "attribute_exists(id)"


def test_rn015_examiner_write_never_rewrites_the_whole_belt(
    seeded: list[Belt], monkeypatch: pytest.MonkeyPatch
) -> None:
    writes = _record_writes(monkeypatch)

    assert _put(EXAMINER, belt("Cinza"), min_age_years=6)["statusCode"] == 200

    assert [operation for operation, _ in writes] == ["UpdateItem"]
    params = writes[0][1]
    assert params["Key"] == {"id": belt_id("Cinza")}
    assert set(params["ExpressionAttributeNames"].values()) == {
        "min_age_years",
        "min_months_previous",
    }


def test_rn015_belt_deleted_between_examiner_read_and_write_is_404_and_not_recreated(
    seeded: list[Belt], monkeypatch: pytest.MonkeyPatch
) -> None:
    cinza = belt("Cinza")
    original_save = belt_repo.save_examiner_fields

    def deleted_first(updated: Belt) -> Belt:
        boto3.resource("dynamodb").Table(os.environ["BELTS_TABLE"]).delete_item(
            Key={"id": cinza.id}
        )
        return original_save(updated)

    monkeypatch.setattr(belt_repo, "save_examiner_fields", deleted_first)

    response = _put(EXAMINER, cinza, min_age_years=6)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": MSG_BELT_NOT_FOUND}
    assert cinza.id not in _stored_items()


def test_rn015_examiner_reads_the_belt_strongly_consistent(
    seeded: list[Belt], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The master renames; the examiner's screen already shows the new name and
    # sends it. An eventually consistent read would still see the old name and
    # refuse the edit with the 403 by mistake.
    cinza = belt("Cinza")
    get_calls = lag_eventual_reads(monkeypatch, BELTS_TABLE_ENV)
    assert _put(MASTER, cinza, name="Cinza clara")["statusCode"] == 200
    renamed = _stored("Cinza")

    response = _put(EXAMINER, renamed, min_age_years=6)

    assert response["statusCode"] == 200, response.get("body")
    assert response_json(response)["name"] == "Cinza clara"
    assert get_calls and all(call.get("ConsistentRead") is True for call in get_calls)


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
@pytest.mark.parametrize("operation", ["GetItem", "UpdateItem"])
def test_rn015_examiner_throttled_read_or_write_is_503_and_writes_nothing(
    seeded: list[Belt], monkeypatch: pytest.MonkeyPatch, operation: str, code: str
) -> None:
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, operation, BELTS_TABLE_ENV, code=code)

    response = _put(EXAMINER, belt("Cinza"), min_age_years=6)
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before
