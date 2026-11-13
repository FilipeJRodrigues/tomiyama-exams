"""Migração para o perfil principal derruba o deploy se cruzar com uma marcação.

Erro observado: a migração (``migrate_to_main_profile``, recurso ``InitialData``)
grava cada requisito com um ``UpdateItem`` avulso. A marcação (RN006) inclui o
mesmo requisito numa transação (``ADD answer_count`` na primeira marcação,
``ConditionCheck`` nas seguintes). Um ``UpdateItem`` que chega enquanto essa
transação está em curso é recusado pelo DynamoDB com
``TransactionConflictException``, que o botocore não repete e que
``retry_throttled`` também não repete (só limite de capacidade). A migração
para no meio, o ``InitialData`` responde ``FAILED`` e o CloudFormation desfaz
o deploy inteiro, só porque um examinador marcou um item durante o deploy.

Esperado: o conflito é passageiro (dura o tempo da transação); a migração
repete a gravação, como a marcação já repete ``TransactionConflict``, termina,
move o item e grava o marcador.

Issue: #144
"""

from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import belt_id

from domain.requirement_profiles import MAIN_PROFILE_ID
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV, SETTINGS_TABLE_ENV


class _ConflictOnce:
    """Moto never conflicts: the first ``UpdateItem`` meets a mark in progress."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.conflicts = 0

    def update_item(self, **kwargs: Any) -> Any:
        if self.conflicts == 0:
            self.conflicts += 1
            raise ClientError(
                {
                    "Error": {
                        "Code": "TransactionConflictException",
                        "Message": "Transaction is ongoing for the item",
                    }
                },
                "UpdateItem",
            )
        return self.inner.update_item(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


def test_rn017_migration_retries_a_write_that_met_a_mark_in_progress(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: 0.0)
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": "legacy-1",
            "belt_id": belt_id("Cinza"),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": "Item gravado antes dos perfis",
            "sort_order": 1,
            "answer_count": 1,
        }
    )
    real_table = requirement_repo.table
    racing = _ConflictOnce(real_table(REQUIREMENTS_TABLE_ENV))
    monkeypatch.setattr(
        requirement_repo,
        "table",
        lambda env: racing if env == REQUIREMENTS_TABLE_ENV else real_table(env),
    )

    moved = requirement_repo.migrate_to_main_profile()

    assert moved == 1
    stored = real_table(REQUIREMENTS_TABLE_ENV).get_item(
        Key={"id": "legacy-1"}, ConsistentRead=True
    )["Item"]
    assert stored["profile_id"] == MAIN_PROFILE_ID
    assert stored["answer_count"] == 1
    marker = real_table(SETTINGS_TABLE_ENV).get_item(
        Key={"id": requirement_repo.PROFILE_MIGRATION_MARKER_ID}, ConsistentRead=True
    )
    assert marker.get("Item")
