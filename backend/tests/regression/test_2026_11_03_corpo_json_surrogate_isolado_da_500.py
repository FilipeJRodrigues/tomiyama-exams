"""Corpo JSON com surrogate isolado escapado (como "\ud800") dava 500 em vez de 400.

Observado: o ``json_body`` (handlers/http.py) aceita o escape ``\ud800`` (ou
``\udfff``) dentro de uma string, porque o texto do corpo é ASCII válido e o
``json.loads`` devolve a string com o surrogate isolado. Esse texto não é
Unicode válido: não dá para codificar em UTF-8. A validação dos campos aceita
(``required_str`` só olha tipo e tamanho), e a gravação no DynamoDB quebra com
``UnicodeEncodeError`` ("surrogates not allowed"), que vira 500 "Erro interno.
Tente de novo." em ``POST /events`` e ``POST /students`` (e em toda rota que
grava texto do corpo), com ou sem ``isBase64Encoded``. Mesma família dos
corpos binário, aninhado e com inteiro gigante: texto do cliente que não é
Unicode válido deve ser 400, como já acontece com bytes que não são UTF-8.

Esperado: 400 "Corpo da requisição inválido: envie um objeto JSON" e nada gravado.
Issue: #19
"""

import base64

import pytest
from conftest import EXAMINER, api_event, response_json

from domain.errors import ValidationError
from handlers import events as event_handlers
from handlers import students as student_handlers
from handlers.http import json_body
from repository import events as event_repo
from repository import students as student_repo

MSG_INVALID_BODY = "Corpo da requisição inválido: envie um objeto JSON"
BACKSLASH = chr(92)
ESCAPES = [BACKSLASH + "ud800", BACKSLASH + "udfff", BACKSLASH + "udc00x"]
ENCODINGS = pytest.mark.parametrize("encoded", [False, True], ids=["plain", "base64"])


def _event(raw: str, encoded: bool) -> dict:
    event = api_event(EXAMINER)
    if encoded:
        event["body"] = base64.b64encode(raw.encode("ascii")).decode("ascii")
        event["isBase64Encoded"] = True
    else:
        event["body"] = raw
        event["isBase64Encoded"] = False
    return event


@ENCODINGS
@pytest.mark.parametrize("escape", ESCAPES)
def test_lone_surrogate_escape_is_rejected_by_json_body(encoded: bool, escape: str) -> None:
    with pytest.raises(ValidationError) as caught:
        json_body(_event('{"name": "Exame' + escape + '"}', encoded))

    assert caught.value.message == MSG_INVALID_BODY


@ENCODINGS
def test_rn016_lone_surrogate_in_event_name_is_400_not_500(aws: None, encoded: bool) -> None:
    raw = '{"name": "Exame' + BACKSLASH + 'ud800", "exam_date": "2026-12-01", "status": "OPEN"}'

    response = event_handlers.create_event(_event(raw, encoded), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_BODY}
    assert event_repo.list_all() == []


@ENCODINGS
def test_rn013_lone_surrogate_in_student_name_is_400_not_500(seeded: list, encoded: bool) -> None:
    raw = (
        '{"full_name": "Ana' + BACKSLASH + 'udfff", "birth_date": "2015-01-01", '
        '"current_belt_id": "' + seeded[0].id + '", "current_belt_since": "2025-01-01"}'
    )

    response = student_handlers.create_student(_event(raw, encoded), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_BODY}
    assert student_repo.list_all() == []
