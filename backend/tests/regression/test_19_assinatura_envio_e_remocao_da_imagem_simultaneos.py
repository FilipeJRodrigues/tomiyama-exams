"""Envio e remoção da imagem da assinatura ao mesmo tempo deixavam metadados sem objeto.

``PUT /settings/signatures/{id}/image`` grava o objeto em ``signatures/{id}``
e depois os metadados; ``DELETE /settings/signatures/{id}/image`` apaga os
metadados e depois o objeto da mesma chave. Se o ``DELETE`` inteiro acontece
entre as duas gravações do ``PUT``, ele apaga o objeto recém-enviado e o
``PUT`` grava os metadados em seguida: a assinatura fica ``complete`` e
``has_complete`` fica verdadeiro, mas a imagem não existe no bucket. O
certificado (RN011) seria liberado com uma assinatura sem imagem, e a URL do
``GET /{id}/image`` responde 404 do S3.

Nos logos essa corrida foi aceita e documentada no README; nas assinaturas ela
decide se o certificado pode ser emitido e não está documentada.

Esperado: depois das duas requisições, metadados e objeto concordam: ou a
assinatura tem imagem e o objeto apontado pelos metadados existe (com o mesmo
tipo), ou nenhum dos dois; e nenhum outro objeto da assinatura sobra no bucket.
O teste localiza a imagem pela chave registrada nos metadados, sem supor o formato.
Issue: #19
"""

import base64
from typing import Any

from conftest import (
    MASTER,
    api_event,
    read_signature_image,
    response_json,
    signature_image_key,
    signature_image_meta,
    signature_object_keys,
)

from handlers import signatures as handlers
from repository import images as image_repo

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40


def test_rn012_upload_racing_image_removal_keeps_metadata_and_object_together(
    images_bucket: str, monkeypatch: Any
) -> None:
    created = handlers.create_signature(
        api_event(MASTER, body={"name": "Jigoro Kano", "graduation": "Fundador"}), None
    )
    signature_id = response_json(created)["id"]
    real_put = image_repo.put_image

    def put_then_image_removed(*args: Any, **kwargs: Any) -> None:
        real_put(*args, **kwargs)
        removal = api_event(MASTER, path={"id": signature_id})
        assert handlers.delete_signature_image(removal, None)["statusCode"] == 204

    monkeypatch.setattr(image_repo, "put_image", put_then_image_removed)
    body = {"content_type": "image/png", "data": base64.b64encode(PNG_BYTES).decode("ascii")}

    handlers.put_signature_image(api_event(MASTER, body=body, path={"id": signature_id}), None)

    listed = response_json(handlers.list_signatures(api_event(MASTER), None))
    has_metadata = listed["signatures"][0]["image"] is not None
    assert has_metadata == (signature_image_meta(signature_id) is not None)
    stored = read_signature_image(images_bucket, signature_id)
    has_object = stored is not None
    assert has_metadata == has_object, (has_metadata, has_object)
    assert listed["has_complete"] == has_object
    if stored is not None:
        # The pointed object is the uploaded image, with the type of the metadata.
        assert stored == (PNG_BYTES, listed["signatures"][0]["image"]["content_type"])
    # No other object of this signature is left behind (none at all without metadata).
    pointed = signature_image_key(images_bucket, signature_id)
    expected = [pointed] if has_object and pointed is not None else []
    assert signature_object_keys(images_bucket, signature_id) == expected
