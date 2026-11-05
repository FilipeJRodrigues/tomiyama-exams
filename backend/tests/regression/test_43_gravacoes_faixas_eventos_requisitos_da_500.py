"""Gravações de faixa, evento e requisito limitadas pelo DynamoDB respondiam 500.

Erro observado: as gravações de um item só não tratam o limite de capacidade.
``repository.belts.save_belt`` (``PUT /belts/{id}``),
``repository.events.create_event`` (``POST /events``) e
``repository.requirements.create_requirement`` (``POST /requirements``) chamam
``put_item`` sem ``try``; ``repository.events.save_event``
(``PUT /events/{id}``), ``events.delete_event`` (``DELETE /events/{id}``),
``requirements.save_requirement`` (``PUT /requirements/{id}``) e
``requirements.delete_requirement`` (``DELETE /requirements/{id}``) só
traduzem o ``ConditionalCheckFailedException`` e devolvem o resto. Um
``ProvisionedThroughputExceededException``, ``ThrottlingException`` ou
``RequestLimitExceeded`` que persiste depois das tentativas do botocore sai
como ``ClientError`` cru, e o ``api_handler`` responde 500 "Erro interno. Tente
de novo.".

Esperado (card #43; o ``backend/README.md`` ainda não cita estas rotas), como
já fazem a edição e a exclusão do aluno (#18) e a gravação das configurações:
503 "Sistema ocupado no momento. Tente de novo em instantes.", só com essa
mensagem, e nada muda em nenhuma tabela (a faixa e o requisito continuam
iguais, o evento continua existindo, nenhum item novo).

Toda gravação na tabela é limitada (``DYNAMODB_WRITES``), então o teste vale
qualquer que seja a operação usada pela correção.

Issue: #43
"""

import pytest
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    DYNAMODB_WRITES,
    SCENARIO_ROUTES,
    assert_service_busy,
    dynamodb_snapshot,
    throttle_dynamodb,
)

from repository.tables import BELTS_TABLE_ENV, EVENTS_TABLE_ENV, REQUIREMENTS_TABLE_ENV

# Route → table its only write goes to.
WRITES = {
    "PUT /belts/{id}": BELTS_TABLE_ENV,
    "POST /events": EVENTS_TABLE_ENV,
    "PUT /events/{id}": EVENTS_TABLE_ENV,
    "DELETE /events/{id}": EVENTS_TABLE_ENV,
    "POST /requirements": REQUIREMENTS_TABLE_ENV,
    "PUT /requirements/{id}": REQUIREMENTS_TABLE_ENV,
    "DELETE /requirements/{id}": REQUIREMENTS_TABLE_ENV,
}


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
@pytest.mark.parametrize("route", list(WRITES))
def test_throttled_write_is_503_and_changes_nothing(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, route: str, code: str
) -> None:
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, DYNAMODB_WRITES, WRITES[route], code=code)

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before
