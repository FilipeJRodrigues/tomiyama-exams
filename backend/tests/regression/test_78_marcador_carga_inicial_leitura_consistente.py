"""O marcador da carga inicial lido por chave podia estar defasado (RN017).

Observado: ``repository.requirements.seed_requirements`` lia o marcador
``seed:requirements:v1`` da tabela ``Settings`` sem ``ConsistentRead``. Uma
carga que comece até cerca de 1 s depois de outra terminar pode ler o marcador
ainda ausente e refazer a carga; ``put_if_absent`` não duplica itens, mas
recria os que um examinador excluiu nesse intervalo, que é o que o marcador
existe para evitar. Probabilidade baixa: cada deploy roda uma carga, e duas
cargas tão próximas só acontecem se o CloudFormation repetir a chamada do
recurso personalizado logo em seguida. Achado fora da lista do card, mesma
classe de leitura.

Esperado: a leitura do marcador usa ``ConsistentRead=True``, e a segunda carga
não insere nada. ``lag_eventual_reads`` (``conftest.py``) faz a tabela responder
como uma réplica uma gravação atrás às leituras sem ``ConsistentRead``.

Issue: #78
"""

import pytest
from conftest import belt_id, lag_eventual_reads

from domain.requirements import Requirement, RequirementKind
from repository import requirements as requirement_repo
from repository.tables import SETTINGS_TABLE_ENV


def _item(requirement_id: str, sort_order: int) -> Requirement:
    return Requirement(
        id=requirement_id,
        belt_id=belt_id("Cinza/Azul"),
        kind=RequirementKind.THEORY,
        category="Vocabulário",
        description=f"Item {requirement_id}",
        expected_answer="Resposta",
        sort_order=sort_order,
    )


def test_rn017_seed_right_after_previous_seed_keeps_deleted_item(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    items = [_item("seed-1", 1), _item("seed-2", 2)]
    lag_eventual_reads(monkeypatch, SETTINGS_TABLE_ENV)
    assert requirement_repo.seed_requirements(items) == 2
    requirement_repo.delete_requirement("seed-2")

    inserted = requirement_repo.seed_requirements(items)

    assert inserted == 0, "a carga já tinha sido aplicada; o item excluído não pode voltar"
    assert {item.id for item in requirement_repo.list_all()} == {"seed-1"}
