"""Corpo JSON válido mas muito aninhado dava 500 em vez de 400.

Observado: um corpo como ``[[[[...]]]]`` com alguns milhares de níveis (JSON
bem formado, ~20 KB, bem abaixo do limite de 6 MB da Lambda) faz o
``json.loads`` do ``json_body`` (handlers/http.py) estourar ``RecursionError``,
que não é capturado e vira 500 "Erro interno. Tente de novo." em todas as rotas
que leem corpo, com ou sem ``isBase64Encoded``. É a mesma classe do erro do
corpo binário (test_2026_11_02_logo_corpo_binario_da_500.py): corpo do cliente
que não é um objeto JSON deve ser 400.

Esperado: 400 "Corpo da requisição inválido: envie um objeto JSON", como o
contrato do backend/README.md, e nada gravado.
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
DEPTH = 10_000
NESTED = "[" * DEPTH + "]" * DEPTH


def _event(raw: str, encoded: bool, path: dict[str, str] | None = None) -> dict:
    event = api_event(EXAMINER, path=path)
    if encoded:
        event["body"] = base64.b64encode(raw.encode("ascii")).decode("ascii")
        event["isBase64Encoded"] = True
    else:
        event["body"] = raw
        event["isBase64Encoded"] = False
    return event


@pytest.mark.parametrize("encoded", [False, True], ids=["plain", "base64"])
def test_rn012_deeply_nested_logo_body_is_400_not_500(images_bucket: str, encoded: bool) -> None:
    response = logo_handlers.put_logo(_event(NESTED, encoded, {"slot": "primary"}), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_BODY}
    listed = boto3.client("s3").list_objects_v2(Bucket=images_bucket)
    assert listed.get("Contents", []) == []
    table = boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])
    assert table.scan()["Items"] == []


@pytest.mark.parametrize("encoded", [False, True], ids=["plain", "base64"])
def test_rn016_deeply_nested_event_body_is_400_not_500(aws: None, encoded: bool) -> None:
    response = event_handlers.create_event(_event(NESTED, encoded), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_INVALID_BODY}
    assert event_repo.list_all() == []
