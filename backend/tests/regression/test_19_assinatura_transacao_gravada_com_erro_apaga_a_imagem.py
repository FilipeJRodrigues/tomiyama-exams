"""Transação gravada mas respondida com erro apagava a imagem que ela registrou.

``PUT /settings/signatures/{id}/image`` grava o objeto numa chave nova
``signatures/{id}/{uuid}`` e depois os metadados, com essa chave, numa
transação do DynamoDB. Se a chamada da transação termina em erro, o handler
supõe que nada foi gravado e apaga a chave nova. Mas o DynamoDB pode gravar a
transação e a resposta se perder: ``InternalServerError`` ("a operação pode ter
sido concluída", segundo a documentação do DynamoDB) ou a conexão fechada
depois do envio. Nesse caso os metadados ficam apontando para a chave nova, e
o handler apaga o objeto: a assinatura conta como completa (RN012, e o RN011
depende disso), mas a imagem do certificado não existe mais.

Esperado (backend/README.md, "O que pode sobrar"): "metadados apontando para
um objeto que não existe, nunca acontece". Pode sobrar objeto órfão, nunca o
contrário. Qualquer resposta serve; o que não pode é os metadados gravados
apontarem para um objeto apagado (por exemplo, conferir com uma leitura forte
se a chave nova ficou registrada antes de apagá-la).
Issue: #19
"""

import base64
import os
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError, ConnectionClosedError
from conftest import MASTER, api_event, read_signature_image, response_json, signature_image_meta

from domain.settings import SETTINGS_ID
from handlers import signatures as handlers
from repository import tables

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
JPEG_BYTES = b"\xff\xd8\xff" + b"\xe0\x00\x10JFIF" + b"\x02" * 40


def _image(data: bytes, content_type: str) -> dict[str, Any]:
    return {"content_type": content_type, "data": base64.b64encode(data).decode("ascii")}


def _internal_error() -> Exception:
    return ClientError(
        {"Error": {"Code": "InternalServerError", "Message": "Internal server error"}},
        "TransactWriteItems",
    )


def _connection_closed() -> Exception:
    return ConnectionClosedError(endpoint_url="https://dynamodb.example")


@pytest.mark.parametrize(
    "lost_response",
    [_internal_error, _connection_closed],
    ids=["internal-server-error", "connection-closed"],
)
@pytest.mark.parametrize("with_previous_image", [False, True], ids=["first", "replace"])
def test_rn012_committed_transaction_with_lost_response_keeps_the_registered_image(
    images_bucket: str, monkeypatch: Any, lost_response: Any, with_previous_image: bool
) -> None:
    boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"]).put_item(
        Item={"id": SETTINGS_ID, "academy_name": "Tomiyama"}
    )
    created = handlers.create_signature(
        api_event(MASTER, body={"name": "Jigoro Kano", "graduation": "Fundador"}), None
    )
    signature_id = response_json(created)["id"]
    if with_previous_image:
        first = api_event(MASTER, body=_image(PNG_BYTES, "image/png"), path={"id": signature_id})
        assert handlers.put_signature_image(first, None)["statusCode"] == 200

    client = tables.table(tables.SETTINGS_TABLE_ENV).meta.client
    real_transact = client.transact_write_items

    def commit_then_lose_the_response(**kwargs: Any) -> Any:
        real_transact(**kwargs)  # DynamoDB writes the metadata...
        raise lost_response()  # ...and the answer never arrives

    monkeypatch.setattr(client, "transact_write_items", commit_then_lose_the_response)
    upload = api_event(MASTER, body=_image(JPEG_BYTES, "image/jpeg"), path={"id": signature_id})

    try:
        handlers.put_signature_image(upload, None)
    except Exception:  # noqa: BLE001 - any answer is fine; the stored state is what matters
        pass
    monkeypatch.undo()

    meta = signature_image_meta(signature_id)
    assert meta is not None and meta.get("key"), "the transaction did record the new key"
    # The object the stored metadata point to must exist.
    assert read_signature_image(images_bucket, signature_id) == (JPEG_BYTES, "image/jpeg")
    listed = response_json(handlers.list_signatures(api_event(MASTER), None))["signatures"][0]
    assert listed["complete"] is True
