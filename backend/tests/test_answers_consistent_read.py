"""Leituras das rotas de marcação e da folha (RN006, RN007, #50).

As marcações vêm da tabela base ``Answers`` com ``ConsistentRead=True``; as
consultas em GSI (``by_belt``) não podem levar ``ConsistentRead``, que o
DynamoDB recusa com ``ValidationException``. O teste espia os parâmetros de
cada ``Query`` no botocore nas três rotas.
"""

import os
from collections.abc import Iterator
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import EXAMINER, api_event, belt_id, make_student, response_json

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam
from domain.requirements import Requirement, RequirementKind
from handlers import exams as handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import ANSWERS_TABLE_ENV

TARGET = "Cinza/Azul"
NOW = "2026-11-01T12:00:00+00:00"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2027-03-20T13:45:00+00:00")


@pytest.fixture
def exam(seeded: None) -> Exam:
    exam_event = ExamEvent(
        id="event-1",
        name="Exame março/2027",
        exam_date=date(2027, 3, 20),
        status=EventStatus.OPEN,
        created_at=NOW,
        updated_at=NOW,
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1", full_name="Ana")
    student_repo.create_student(student)
    response = handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    for order, req_id in enumerate(("t1", "t2"), start=1):
        requirement_repo.create_requirement(
            Requirement(
                id=req_id,
                belt_id=belt_id(TARGET),
                kind=RequirementKind.THEORY,
                category="Vocabulário",
                description=f"Item {req_id}",
                expected_answer="Resposta",
                sort_order=order,
            )
        )
    stored = exam_repo.get_exam(exam_event.id, student.id)
    assert stored is not None
    return stored


@pytest.fixture
def queries(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []
    original = BaseClient._make_api_call

    def spy(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name in {"Query", "Scan"}:
            calls.append({"operation": operation_name, **api_params})
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", spy)
    yield calls


def _path(exam: Exam, requirement_id: str | None = None) -> dict[str, str]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    if requirement_id is not None:
        path["requirement_id"] = requirement_id
    return path


def _assert_reads(calls: list[dict[str, Any]]) -> None:
    on_index = [call for call in calls if "IndexName" in call]
    assert on_index, "a rota deveria consultar o by_belt"
    assert all("ConsistentRead" not in call for call in on_index), on_index
    answers = [
        call
        for call in calls
        if call.get("TableName") == os.environ[ANSWERS_TABLE_ENV] and "IndexName" not in call
    ]
    assert answers, "a rota deveria consultar Answers"
    assert all(call.get("ConsistentRead") is True for call in answers), answers
    assert all(call["operation"] == "Query" for call in calls), "nenhuma rota deveria fazer Scan"


def test_rn007_mark_reads_base_consistently_and_gsi_without_consistent_read(
    exam: Exam, queries: list[dict[str, Any]]
) -> None:
    response = handlers.mark_answer(
        api_event(EXAMINER, path=_path(exam, "t1"), body={"correct": True}), None
    )
    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["summary"]["THEORY"]["marked"] == 1
    _assert_reads(queries)


def test_rn007_unmark_reads_base_consistently_and_gsi_without_consistent_read(
    exam: Exam, queries: list[dict[str, Any]]
) -> None:
    handlers.mark_answer(api_event(EXAMINER, path=_path(exam, "t1"), body={"correct": True}), None)
    queries.clear()
    response = handlers.unmark_answer(api_event(EXAMINER, path=_path(exam, "t1")), None)
    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["summary"]["THEORY"]["marked"] == 0
    _assert_reads(queries)


def test_rn006_sheet_reads_base_consistently_and_gsi_without_consistent_read(
    exam: Exam, queries: list[dict[str, Any]]
) -> None:
    response = handlers.get_exam_sheet(api_event(EXAMINER, path=_path(exam)), None)
    assert response["statusCode"] == 200, response["body"]
    _assert_reads(queries)
