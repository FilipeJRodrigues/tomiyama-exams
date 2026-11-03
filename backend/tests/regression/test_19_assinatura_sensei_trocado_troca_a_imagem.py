"""Um sensei trocado no meio do envio da imagem ainda substituía a assinatura.

Até o commit e8b1105, ``PUT /settings/signatures/{id}/image`` conferia o sensei
no início, gravava o objeto em ``signatures/{id}`` (chave fixa) e só depois os
metadados, numa transação que conferia o sensei de novo. Se o master troca o sensei entre a
conferência e a transação, a resposta é 403, mas o objeto da assinatura já foi
sobrescrito pelos bytes enviados pelo ex-sensei: a imagem que vai no
certificado muda, e os metadados continuam os da imagem antiga.

Esperado (backend/README.md, "Assinaturas do certificado (RN012)"): "um sensei
trocado entre a conferência e a gravação recebe 403 e nada é gravado"; a
imagem atual fica como estava (bytes e tipo). RN012 proíbe que alguém além do
master e do sensei altere uma assinatura (risco de falsificação). O teste
localiza a imagem pela chave registrada nos metadados, sem supor o formato.
Issue: #19
"""

import base64
import os
from typing import Any

import boto3
from conftest import (
    MASTER,
    api_event,
    read_signature_image,
    response_json,
    signature_image_meta,
    signature_object_keys,
)

from domain.settings import SETTINGS_ID
from domain.users import ADMIN_GROUP, User
from handlers import signatures as handlers
from repository import images as image_repo

SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x01" * 40
JPEG_BYTES = b"\xff\xd8\xff" + b"\xe0\x00\x10JFIF" + b"\x02" * 40


def _image(data: bytes, content_type: str) -> dict[str, Any]:
    return {"content_type": content_type, "data": base64.b64encode(data).decode("ascii")}


def _set_sensei(sub: str) -> None:
    boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"]).put_item(
        Item={"id": SETTINGS_ID, "academy_name": "Tomiyama", "sensei_user_id": sub}
    )


def test_rn012_sensei_replaced_during_image_upload_keeps_the_current_image(
    images_bucket: str, monkeypatch: Any
) -> None:
    _set_sensei(SENSEI.sub)
    created = handlers.create_signature(
        api_event(MASTER, body={"name": "Jigoro Kano", "graduation": "Fundador"}), None
    )
    signature_id = response_json(created)["id"]
    original = api_event(MASTER, body=_image(PNG_BYTES, "image/png"), path={"id": signature_id})
    assert handlers.put_signature_image(original, None)["statusCode"] == 200

    real_put = image_repo.put_image

    def put_then_sensei_replaced(*args: Any, **kwargs: Any) -> None:
        real_put(*args, **kwargs)
        _set_sensei("someone-else")  # the master picks another sensei meanwhile

    meta_before = signature_image_meta(signature_id)
    objects_before = signature_object_keys(images_bucket, signature_id)
    assert meta_before is not None and len(objects_before) == 1
    monkeypatch.setattr(image_repo, "put_image", put_then_sensei_replaced)
    forged = api_event(SENSEI, body=_image(JPEG_BYTES, "image/jpeg"), path={"id": signature_id})

    response = handlers.put_signature_image(forged, None)

    assert response["statusCode"] == 403
    # The image the metadata points to is still the original one (bytes and type).
    assert read_signature_image(images_bucket, signature_id) == (PNG_BYTES, "image/png")
    # Nothing was written: same metadata, same objects (no orphan of the forged upload).
    assert signature_image_meta(signature_id) == meta_before
    assert signature_object_keys(images_bucket, signature_id) == objects_before
