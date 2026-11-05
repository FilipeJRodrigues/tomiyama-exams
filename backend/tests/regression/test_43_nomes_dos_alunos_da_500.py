"""Nomes dos alunos da lista do evento: limite do DynamoDB dava 500 ou laço sem fim.

Erro observado: ``GET /events/{id}/exams`` lê os nomes com
``repository.students.get_names``, um ``BatchGetItem`` próprio, sem o helper
``tables.batch_get`` (#21):

- o ``BatchGetItem`` inteiro limitado (``ProvisionedThroughputExceededException``,
  ``ThrottlingException`` ou ``RequestLimitExceeded`` depois das tentativas do
  botocore) sai como ``ClientError`` cru e vira 500 "Erro interno. Tente de
  novo.";
- as chaves devolvidas em ``UnprocessedKeys`` são pedidas de novo na hora, sem
  espera, e sem limite: se a capacidade não voltar, o ``while request`` nunca
  termina e a Lambda só para no timeout de 10 s (500 genérico do API Gateway),
  gastando capacidade a cada volta.

Esperado (``backend/README.md``: as leituras que passam da capacidade, entre
elas "os nomes dos alunos (``BatchGetItem``)", são repetidas pelo botocore e,
"se persistir, a resposta é 503"; as chaves não processadas são pedidas de
novo com espera crescente e um limite, como os eventos do histórico, RN018,
com ``tables.batch_get``): 503 "Sistema ocupado no momento. Tente de novo em
instantes." depois de um número limitado de chamadas, e espera entre as novas
tentativas.

Os stubs param na 11ª chamada (``CallLimitExceededError``), então o laço sem
fim falha o teste em vez de travar a suíte.

Issue: #43
"""

import pytest
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    SCENARIO_ROUTES,
    assert_service_busy,
    leave_batch_unprocessed,
    response_json,
    throttle_dynamodb,
)

from repository.tables import STUDENTS_TABLE_ENV

ROUTE = "GET /events/{id}/exams"
# Total wait accepted across the retries: well inside the functions' 10 s timeout.
MAX_TOTAL_WAIT_SECONDS = 2.0


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Record every ``time.sleep`` instead of sleeping."""
    recorded: list[float] = []
    monkeypatch.setattr("time.sleep", recorded.append)
    return recorded


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
def test_throttled_student_names_batch_is_503(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, waits: list[float], code: str
) -> None:
    stub = throttle_dynamodb(monkeypatch, "BatchGetItem", STUDENTS_TABLE_ENV, code=code)

    response = SCENARIO_ROUTES[ROUTE]()

    assert_service_busy(response, stub)


def test_student_names_never_processed_is_503_after_a_limited_number_of_calls(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, waits: list[float]
) -> None:
    stub = leave_batch_unprocessed(monkeypatch, STUDENTS_TABLE_ENV, times=None)

    response = SCENARIO_ROUTES[ROUTE]()

    assert_service_busy(response, stub)
    assert sum(waits) < MAX_TOTAL_WAIT_SECONDS, waits


def test_unprocessed_student_names_are_asked_again_after_a_wait(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, waits: list[float]
) -> None:
    """Two calls leave every key unprocessed; the third one reads the name.

    Each new call comes after a wait (backoff), as AWS recommends for
    ``UnprocessedKeys`` and as ``tables.batch_get`` does.
    """
    stub = leave_batch_unprocessed(monkeypatch, STUDENTS_TABLE_ENV, times=2)

    response = SCENARIO_ROUTES[ROUTE]()

    assert response["statusCode"] == 200, response["body"]
    assert [view["student_name"] for view in response_json(response)] == ["Ana"]
    assert len(stub.calls) == 2
    assert len(waits) >= 2, f"novas tentativas sem espera: {waits}"
    assert all(wait > 0 for wait in waits), waits
    assert sum(waits) < MAX_TOTAL_WAIT_SECONDS, waits
