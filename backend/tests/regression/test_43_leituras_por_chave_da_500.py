"""Leituras por chave de evento, requisito e faixa limitadas pelo DynamoDB respondiam 500.

Erro observado: ``repository.events.get_event``,
``repository.requirements.get_requirement`` e ``repository.belts.get_belt``
chamam ``table(...).get_item`` direto, sem ``get_item_or_busy``. Um
``ProvisionedThroughputExceededException``, ``ThrottlingException`` ou
``RequestLimitExceeded`` que persiste depois das tentativas do botocore sai
como ``ClientError`` cru, e o ``api_handler`` responde 500 "Erro interno. Tente
de novo.". Chegam a essas leituras:

- ``get_event`` (``_get_or_404`` e ``_event_or_404``): ``GET``, ``PUT`` e
  ``DELETE /events/{id}``, a presença, a lista e a ficha do evento, a
  marcação, a desmarcação e a decisão;
- ``get_requirement``: ``PUT`` e ``DELETE /requirements/{id}``, a marcação e a
  desmarcação, e a releitura que ``save_requirement`` faz depois de um
  ``UpdateItem`` recusado pela condição (item apagado ou travado com respostas,
  RN017);
- ``get_belt``: só a ficha do exame (``GET /events/{id}/exams/{student_id}``).
  O ``PUT /belts/{id}`` lê as faixas com ``list_belts`` (``Scan``), que já
  responde 503.

Esperado (``backend/README.md``, "Leitura consistente nas leituras por chave":
nas leituras de ``Events`` e ``Requirements``, "se persistir, a resposta é
503"; tabelas de erros da marcação e da decisão: "limite de capacidade do
DynamoDB que persistiu" → 503): 503 "Sistema ocupado no momento. Tente de novo
em instantes.", só com essa mensagem, e nada gravado em nenhuma tabela.

O limite é simulado no nível do botocore (``throttle_dynamodb``), então vale
qualquer que seja o caminho da correção.

Issue: #43
"""

from collections.abc import Callable

import pytest
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    EXAMINER,
    SCENARIO_REQUIREMENT,
    SCENARIO_ROUTES,
    api_event,
    assert_service_busy,
    before_dynamodb_call,
    belt_id,
    dynamodb_snapshot,
    scenario_requirement_body,
    throttle_dynamodb,
)

from handlers import requirements as requirement_handlers
from repository.tables import (
    ANSWER_COUNT,
    BELTS_TABLE_ENV,
    EVENTS_TABLE_ENV,
    REQUIREMENTS_TABLE_ENV,
    table,
)

# Routes that read the event by key before anything else.
EVENT_ROUTES = [
    "GET /events/{id}",
    "PUT /events/{id}",
    "DELETE /events/{id}",
    "POST /events/{id}/exams",
    "GET /events/{id}/exams",
    "GET /events/{id}/exams/{student_id}",
    "PUT .../answers/{requirement_id}",
    "DELETE .../answers/{requirement_id}",
    "POST .../decision",
]
REQUIREMENT_ROUTES = [
    "PUT /requirements/{id}",
    "DELETE /requirements/{id}",
    "PUT .../answers/{requirement_id}",
    "DELETE .../answers/{requirement_id}",
]
BELT_ROUTES = ["GET /events/{id}/exams/{student_id}"]

KEY_READS = (
    [(EVENTS_TABLE_ENV, route) for route in EVENT_ROUTES]
    + [(REQUIREMENTS_TABLE_ENV, route) for route in REQUIREMENT_ROUTES]
    + [(BELTS_TABLE_ENV, route) for route in BELT_ROUTES]
)
TABLE_NAMES = {
    EVENTS_TABLE_ENV: "event",
    REQUIREMENTS_TABLE_ENV: "requirement",
    BELTS_TABLE_ENV: "belt",
}


@pytest.mark.parametrize(
    ("table_env", "route"),
    KEY_READS,
    ids=[f"{TABLE_NAMES[env]}: {route}" for env, route in KEY_READS],
)
def test_throttled_read_by_key_is_503_and_writes_nothing(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, table_env: str, route: str
) -> None:
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, "GetItem", table_env)

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
@pytest.mark.parametrize(
    ("table_env", "route"),
    [
        (EVENTS_TABLE_ENV, "GET /events/{id}"),
        (REQUIREMENTS_TABLE_ENV, "DELETE /requirements/{id}"),
        (BELTS_TABLE_ENV, "GET /events/{id}/exams/{student_id}"),
    ],
    ids=["get_event", "get_requirement", "get_belt"],
)
def test_every_throttling_code_on_read_by_key_is_503(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, table_env: str, route: str, code: str
) -> None:
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, "GetItem", table_env, code=code)

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before


def _delete_requirement() -> None:
    table(REQUIREMENTS_TABLE_ENV).delete_item(Key={"id": SCENARIO_REQUIREMENT.id})


def _keep_requirement() -> None:
    """The item stays: the lock refuses the write (answers and a belt change)."""


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
@pytest.mark.parametrize(
    ("change", "changes"),
    [
        (_delete_requirement, {"description": "Item t1 (editado)"}),
        (_keep_requirement, {"belt_id": belt_id("Azul")}),
    ],
    ids=["deleted_meanwhile", "locked_by_answers"],
)
def test_rn017_throttled_reread_after_refused_requirement_edit_is_503(
    exam_scenario: None,
    monkeypatch: pytest.MonkeyPatch,
    change: Callable[[], None],
    changes: dict[str, str],
    code: str,
) -> None:
    """The re-read of ``save_requirement`` after a refused ``UpdateItem`` is throttled.

    The item has an answer counted (``answer_count`` 1). The handler's read
    passes; right before the ``UpdateItem`` reaches the table, the item is
    deleted (or kept, and the belt change is refused by the lock) and only then
    the requirement's ``GetItem`` starts to be throttled, so the throttling
    hits the re-read that picks the error (404 or 409), never the first read.
    """
    table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": SCENARIO_REQUIREMENT.id},
        UpdateExpression="SET #count = :one",
        ExpressionAttributeNames={"#count": ANSWER_COUNT},
        ExpressionAttributeValues={":one": 1},
    )
    stub = throttle_dynamodb(
        monkeypatch, "GetItem", REQUIREMENTS_TABLE_ENV, code=code, active=False
    )

    def concurrent_change() -> None:
        change()
        stub.active = True

    triggered = before_dynamodb_call(
        monkeypatch, "UpdateItem", REQUIREMENTS_TABLE_ENV, concurrent_change
    )
    before = dynamodb_snapshot()

    response = requirement_handlers.update_requirement(
        api_event(
            EXAMINER,
            path={"id": SCENARIO_REQUIREMENT.id},
            body=scenario_requirement_body(**changes),
        ),
        None,
    )
    stub.active = False

    assert triggered, f"the write was not reached ({response['body']})"
    assert_service_busy(response, stub)
    after = dynamodb_snapshot()
    if change is _keep_requirement:
        assert after == before
    else:
        stored = table(REQUIREMENTS_TABLE_ENV).get_item(
            Key={"id": SCENARIO_REQUIREMENT.id}, ConsistentRead=True
        )
        assert "Item" not in stored, "the refused edit must not recreate the item"
        assert {env: items for env, items in after.items() if env != "REQUIREMENTS_TABLE"} == {
            env: items for env, items in before.items() if env != "REQUIREMENTS_TABLE"
        }
