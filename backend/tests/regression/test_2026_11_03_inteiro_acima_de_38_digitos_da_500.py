"""Inteiro com mais de 38 dígitos num campo sem teto dava 500 em vez de 400.

Observado: os campos inteiros validados por ``validation.int_field`` só com
``minimum`` (``sort_order`` do requisito e da faixa, ``min_age_years`` e
``min_months_previous`` da faixa) aceitam qualquer inteiro que o ``json_body``
leia, até 4300 dígitos. O DynamoDB guarda números com no máximo 38 dígitos
significativos: o ``TypeSerializer`` do boto3 levanta ``decimal.Inexact`` /
``Rounded`` ao gravar, por exemplo, ``"sort_order": 10**38``, e a rota responde
500 "Erro interno. Tente de novo." em ``POST /requirements`` e
``PUT /belts/{id}``. Um corpo do cliente nunca deve dar 500.

Esperado: 400 com mensagem em pt-BR no formato ``{"message": ...}`` e nada gravado.
Issue: #19
"""

import json

import pytest
from conftest import EXAMINER, api_event, response_json

from handlers import belts as belt_handlers
from handlers import requirements as requirement_handlers
from repository import belts as belt_repo
from repository import requirements as requirement_repo

BIG_INTS = [10**38, int("9" * 39), int("1" * 4000)]
IDS = ["10e38", "39_digits", "4000_digits"]


def _event(payload: dict, path: dict[str, str] | None = None) -> dict:
    event = api_event(EXAMINER, path=path)
    event["body"] = json.dumps(payload)
    event["isBase64Encoded"] = False
    return event


@pytest.mark.parametrize("value", BIG_INTS, ids=IDS)
def test_requirement_sort_order_above_38_digits_is_400_not_500(seeded: list, value: int) -> None:
    payload = {
        "belt_id": seeded[0].id,
        "kind": "THEORY",
        "category": "Categoria",
        "description": "Descrição",
        "sort_order": value,
    }

    response = requirement_handlers.create_requirement(_event(payload), None)

    assert response["statusCode"] == 400
    assert isinstance(response_json(response).get("message"), str)
    assert requirement_repo.list_all() == []


@pytest.mark.parametrize("field", ["sort_order", "min_age_years", "min_months_previous"])
@pytest.mark.parametrize("value", BIG_INTS, ids=IDS)
def test_rn015_belt_integer_above_38_digits_is_400_not_500(
    seeded: list, field: str, value: int
) -> None:
    before = belt_repo.list_belts()
    target = before[-1]
    payload = {**target.to_dict(), field: value}

    response = belt_handlers.update_belt(_event(payload, path={"id": target.id}), None)

    assert response["statusCode"] == 400
    assert isinstance(response_json(response).get("message"), str)
    assert belt_repo.list_belts() == before
