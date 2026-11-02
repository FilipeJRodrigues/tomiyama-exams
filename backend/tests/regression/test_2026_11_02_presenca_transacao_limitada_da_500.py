"""Presença com a própria transação limitada pelo DynamoDB respondia 500, e não 503.

Erro observado: na confirmação de presença (``POST /events/{id}/exams``,
``repository.exams.create_exam``), o limite de capacidade direto na transação
sai como ``ClientError`` cru e vira 500 "Erro interno". Acontece de duas formas:

- o ``TransactWriteItems`` falha com ``Error.Code`` de limite
  (``ProvisionedThroughputExceededException``, ``ThrottlingException`` ou
  ``RequestLimitExceeded``, os códigos de ``repository.tables.THROTTLING_ERRORS``),
  que persistiu depois das tentativas do botocore;
- o ``TransactionCanceledException`` traz entre os motivos de cancelamento
  ``ThrottlingError`` ou ``ProvisionedThroughputExceeded``.

Esperado (RN005, contrato do ``backend/README.md``): 503 "Sistema ocupado no
momento. Tente de novo em instantes.", sem gravar nada, como já faz a decisão
do sensei (``repository.exams.decide_exam``). O conflito de transação
(``TransactionConflict``) já é repetido e vira 409 se persistir; isso está
coberto em ``tests/test_attendance.py``.

A transação falsa não depende da quantidade nem da ordem dos itens: o motivo
de limite vai para o item da tabela indicada e os demais recebem ``None``.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, make_student

from domain.events import EventStatus, ExamEvent
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo
from repository.tables import (
    EVENTS_TABLE_ENV,
    EXAMS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    table,
)

NOW = "2026-11-01T12:00:00+00:00"
BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


def _table_name(transact_item: dict[str, Any]) -> str:
    (operation,) = transact_item.values()
    return operation["TableName"]


def _direct(code: str) -> Any:
    def transact(transact_items: list[dict[str, Any]]) -> None:
        raise ClientError({"Error": {"Code": code, "Message": "x"}}, "TransactWriteItems")

    return transact


def _cancelled(reason: str, throttled_env: str) -> Any:
    def transact(transact_items: list[dict[str, Any]]) -> None:
        throttled = table(throttled_env).name
        codes = [reason if _table_name(item) == throttled else "None" for item in transact_items]
        assert reason in codes, codes
        raise ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                "CancellationReasons": [{"Code": code} for code in codes],
            },
            "TransactWriteItems",
        )

    return transact


CASES = [
    pytest.param(_direct("ProvisionedThroughputExceededException"), id="direct-provisioned"),
    pytest.param(_direct("ThrottlingException"), id="direct-throttling"),
    pytest.param(_direct("RequestLimitExceeded"), id="direct-request-limit"),
    pytest.param(_cancelled("ThrottlingError", EXAMS_TABLE_ENV), id="reason-throttling-exams"),
    pytest.param(
        _cancelled("ThrottlingError", STUDENTS_TABLE_ENV), id="reason-throttling-students"
    ),
    pytest.param(
        _cancelled("ProvisionedThroughputExceeded", EVENTS_TABLE_ENV),
        id="reason-provisioned-events",
    ),
    pytest.param(
        _cancelled("ProvisionedThroughputExceeded", STUDENTS_TABLE_ENV),
        id="reason-provisioned-students",
    ),
]


@pytest.mark.parametrize("transact", CASES)
def test_rn005_throttled_attendance_transaction_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, transact: Any
) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1")
    student_repo.create_student(student)
    event_before = table(EVENTS_TABLE_ENV).get_item(Key={"id": exam_event.id})["Item"]
    student_before = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]

    calls = {"n": 0}

    def counted(transact_items: list[dict[str, Any]]) -> None:
        calls["n"] += 1
        transact(transact_items)

    monkeypatch.setattr(exam_repo, "_transact_create", counted)
    monkeypatch.setattr(exam_repo.time, "sleep", lambda seconds: None)

    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )

    assert calls["n"] >= 1, response["body"]
    assert response["statusCode"] == 503, response["body"]
    assert BUSY in response["body"]
    assert table(EXAMS_TABLE_ENV).scan()["Items"] == []
    assert table(EVENTS_TABLE_ENV).get_item(Key={"id": exam_event.id})["Item"] == event_before
    assert table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"] == student_before
