"""Corpo JSON com número inteiro de mais de 4300 dígitos dava 500 em vez de 400.

Observado: no Python 3.12 o ``json.loads`` do ``json_body`` (handlers/http.py)
levanta ``ValueError`` ("Exceeds the limit (4300 digits) for integer string
conversion") ao ler um inteiro com mais de 4300 dígitos, como
``{"name": 111...1}``. ``ValueError`` não é ``JSONDecodeError`` nem está no
except do ``json_body``, então vira 500 "Erro interno. Tente de novo." em todas
as rotas que leem corpo, com ou sem ``isBase64Encoded``. Mesma classe dos erros
do corpo binário e do JSON aninhado: corpo do cliente que não dá para ler deve
ser 400.

Esperado: 400 "Corpo da requisição inválido: envie um objeto JSON" e nada gravado.
Issue: #19
"""

import base64
import os

import boto3
import pytest
from conftest import EXAMINER, api_event, response_json

from handlers import events as event_handlers
from handlers import logos as logo_handlers
from repository import events as event_repo

MSG_INVALID_BODY = "Corpo da requisição inválido: envie um objeto JSON"
HUGE_INT = "1" * 5000
BODIES = {
    "in_object": '{"contentType": "image/png", "data": ' + HUGE_INT + "}",
    "top_level": HUGE_INT,
}


def _event(raw: str, encoded: bool, path: dict[str, str] | None = None) -> dict:
    event = api_event(EXAMINER, path=path)
    if encoded:
        event["body"] = base64.b64encode(raw.encode("ascii")).decode("ascii")
        event["isBase64Encoded"] = True
    else:
        event["body"] = raw
        event["isBase64Encoded"] = False
    return event


@pytest.mark.parametrize("shape", sorted(BODIES))
@pytest.mark.parametrize("encoded", [False, True], ids=["plain", "base64"])
def test_rn012_huge_integer_logo_body_is_400_not_500(
    images_bucket: str, encoded: bool, shape: str
) -> None:
    response = logo_handlers.put_logo(_event(BODIES[shape], encoded, {"slot": "primary"}), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_BODY}
    listed = boto3.client("s3").list_objects_v2(Bucket=images_bucket)
    assert listed.get("Contents", []) == []
    table = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    assert table.scan()["Items"] == []


@pytest.mark.parametrize("encoded", [False, True], ids=["plain", "base64"])
def test_rn016_huge_integer_event_body_is_400_not_500(aws: None, encoded: bool) -> None:
    response = event_handlers.create_event(_event('{"name": ' + HUGE_INT + "}", encoded), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_BODY}
    assert event_repo.list_all() == []
