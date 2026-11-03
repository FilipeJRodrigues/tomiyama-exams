"""Enviar o arquivo cru (não JSON) para PUT /settings/logos/{slot} dava 500.

Quando o cliente manda o PNG direto no corpo (``Content-Type: image/png``), o
HTTP API entrega o corpo em base64 com ``isBase64Encoded`` verdadeiro. O
``json_body`` decodifica e chama ``.decode("utf-8")`` nos bytes do PNG, o que
levanta ``UnicodeDecodeError`` fora do ``try`` e vira 500 "Erro interno".

Esperado: 400 "Corpo da requisição inválido: envie um objeto JSON", como
documenta o backend/README.md (seção "Imagens da academia (RN012)"), e nada
gravado no S3 nem nas configurações.
Issue: #19
"""

import base64
import os

import boto3
from conftest import EXAMINER, api_event, response_json

from domain.settings import SETTINGS_ID
from handlers import logos as handlers

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40


def test_rn012_raw_image_body_is_400_not_500(images_bucket: str) -> None:
    event = api_event(EXAMINER, path={"slot": "primary"})
    # What the HTTP API delivers for a raw image/png body.
    event["body"] = base64.b64encode(PNG_BYTES).decode("ascii")
    event["isBase64Encoded"] = True

    response = handlers.put_logo(event, None)

    assert response["statusCode"] == 400
    assert response_json(response) == {
        "message": "Corpo da requisição inválido: envie um objeto JSON"
    }
    listed = boto3.client("s3").list_objects_v2(Bucket=images_bucket)
    assert listed.get("KeyCount", 0) == 0
    stored = (
        boto3.resource("dynamodb")
        .Table(os.environ["SETTINGS_TABLE"])
        .get_item(Key={"id": SETTINGS_ID})
        .get("Item")
    )
    assert stored is None
