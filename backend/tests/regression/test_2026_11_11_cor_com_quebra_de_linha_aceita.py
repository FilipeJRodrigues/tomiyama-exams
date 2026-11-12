"""Cor da faixa com quebra de linha no fim era aceita e gravada.

Observado: no ``PUT /belts/{id}``, ``color_primary`` ou ``color_secondary`` igual a
``"#9E9E9E\\n"`` (sete caracteres válidos e uma quebra de linha) responde 200 e a
cor é gravada com a quebra de linha. A validação usa ``^#[0-9A-Fa-f]{6}$`` com
``match``, e em Python o ``$`` também casa antes de uma quebra de linha final.

Esperado (RN015, "cores ``#RRGGBB``"): 400 "Cor: use o formato #RRGGBB" (ou
"Cor das pontas: use o formato #RRGGBB") e nada é gravado.
Achado pelo qa na etapa 2 do card #22.
"""

from typing import Any

import pytest
from conftest import EXAMINER, api_event, response_json

from domain.belts import Belt
from handlers import belts as belt_handlers


def _form(belt: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {**{key: value for key, value in belt.items() if key != "id"}, **changes}


@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("color_primary", "Cor: use o formato #RRGGBB"),
        ("color_secondary", "Cor das pontas: use o formato #RRGGBB"),
    ],
)
def test_rn015_colour_with_trailing_line_break_is_refused(
    seeded: list[Belt], field: str, message: str
) -> None:
    before = response_json(belt_handlers.list_belts(api_event(EXAMINER), None))
    cinza = next(belt for belt in before if belt["name"] == "Cinza")

    response = belt_handlers.update_belt(
        api_event(EXAMINER, body=_form(cinza, **{field: "#9E9E9E\n"}), path={"id": cinza["id"]}),
        None,
    )

    assert response["statusCode"] == 400, response.get("body")
    assert response_json(response) == {"message": message}
    assert response_json(belt_handlers.list_belts(api_event(EXAMINER), None)) == before
