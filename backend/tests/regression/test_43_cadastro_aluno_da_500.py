"""Cadastro de aluno com gravação limitada pelo DynamoDB respondia 500, e não 503.

Erro observado: ``POST /students`` grava com
``repository.students.create_student``, um ``put_item`` sem ``try``. Um
``ProvisionedThroughputExceededException``, ``ThrottlingException`` ou
``RequestLimitExceeded`` que persiste depois das tentativas do botocore sai
como ``ClientError`` cru, e o ``api_handler`` responde 500 "Erro interno. Tente
de novo.". A leitura das faixas da mesma rota (``Scan`` em ``Belts``) já
responde 503, e a edição e a exclusão do aluno também (#18).

Esperado (card #43; o ``backend/README.md`` promete 503 na edição e na
exclusão do aluno, mas ainda não cita o cadastro): 503 "Sistema ocupado no
momento. Tente de novo em instantes.", só com essa mensagem, para o
responsável e para o examinador, e nenhum aluno gravado. A mesma rota sem
limite responde 201 (``test_throttling_routes.py``).

Issue: #43
"""

import pytest
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    DYNAMODB_WRITES,
    EXAMINER,
    GUARDIAN,
    api_event,
    assert_service_busy,
    belt_id,
    dynamodb_snapshot,
    throttle_dynamodb,
)

from domain.users import User
from handlers import students as student_handlers
from repository.tables import STUDENTS_TABLE_ENV

BODY = {
    "full_name": "Caio",
    "birth_date": "2018-05-10",
    "current_belt_id": belt_id("Cinza"),
    "current_belt_since": "2026-03-14",
    "stripes": 0,
}


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
@pytest.mark.parametrize("user", [GUARDIAN, EXAMINER], ids=["guardian", "examiner"])
def test_throttled_student_registration_is_503_and_stores_nothing(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, user: User, code: str
) -> None:
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, DYNAMODB_WRITES, STUDENTS_TABLE_ENV, code=code)

    response = student_handlers.create_student(api_event(user, body=BODY), None)
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before
