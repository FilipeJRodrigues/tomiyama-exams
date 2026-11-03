"""Ordem padrão do requisito passava do teto de 9999 e o item ficava sem edição.

Observado: no ``POST /requirements`` sem ``sort_order`` a ordem padrão é a maior
ordem da faixa + 1, e esse valor não passa pela faixa 0 a 9999 documentada no
``backend/README.md`` (tabela "Campos inteiros (RN015)"). Com um item da faixa
em 9999, o novo item é gravado com ``sort_order`` 10000 (201). Depois disso o
formulário, que reenvia o item como foi lido, recebe 400 "Ordem: deve estar
entre 0 e 9999" no ``PUT /requirements/{id}``.

Esperado: nenhum item gravado fora de 0 a 9999. Ou o ``POST`` responde 400 em
pt-BR e nada é gravado, ou o item é criado dentro da faixa e o reenvio dele no
``PUT`` é aceito.
Issue: #47
"""

import json

from conftest import EXAMINER, api_event, response_json

from domain.requirements import MAX_SORT_ORDER
from handlers import requirements as requirement_handlers
from repository import requirements as requirement_repo


def _event(payload: dict, path: dict[str, str] | None = None) -> dict:
    event = api_event(EXAMINER, path=path)
    event["body"] = json.dumps(payload)
    event["isBase64Encoded"] = False
    return event


def test_rn015_default_sort_order_never_goes_past_9999(seeded: list) -> None:
    base = {
        "belt_id": seeded[0].id,
        "kind": "THEORY",
        "category": "Categoria",
        "description": "Descrição",
    }
    first = requirement_handlers.create_requirement(
        _event({**base, "sort_order": MAX_SORT_ORDER}), None
    )
    assert first["statusCode"] == 201

    response = requirement_handlers.create_requirement(_event(base), None)

    assert all(0 <= item.sort_order <= MAX_SORT_ORDER for item in requirement_repo.list_all())
    if response["statusCode"] == 201:
        created = response_json(response)
        resent = requirement_handlers.update_requirement(
            _event(created, path={"id": created["id"]}), None
        )
        assert resent["statusCode"] == 200
    else:
        assert response["statusCode"] == 400
        assert isinstance(response_json(response).get("message"), str)
        assert len(requirement_repo.list_all()) == 1
