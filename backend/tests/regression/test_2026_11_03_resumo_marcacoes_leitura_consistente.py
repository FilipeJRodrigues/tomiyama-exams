"""O resumo do exame podia ficar uma marcação atrás (RN006, RN007).

Observado: ``repository.answers.list_by_exam`` consultava a tabela ``Answers``
sem ``ConsistentRead``. A leitura eventualmente consistente podia não trazer
uma marcação de outro item gravada milissegundos antes, e o ``summary`` do PUT
e do DELETE de ``/events/{id}/exams/{student_id}/answers/{requirement_id}``
(o ``_summary_after`` só aplica a própria gravação) e o do GET
``/events/{id}/exams/{student_id}`` saíam com o percentual e as contagens um
item atrás.

Esperado: toda consulta das marcações de um exame na tabela base usa
``ConsistentRead=True``, em todas as páginas da paginação. O moto é sempre
consistente e não reproduz o atraso, por isso o teste espia os parâmetros da
chamada ``Query`` no botocore (vale para ``Table.query`` e ``client.query``) e
força páginas de um item para exercitar a paginação.

A outra leitura que sustenta o resumo, ``requirement_repo.list_by_belt``,
consulta o índice ``by_belt`` (GSI), que o DynamoDB não lê de forma
consistente; ela fica fora deste teste.

Issue: #50
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

EVENT_DATE = date(2027, 3, 20)
TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
TARGET = "Cinza/Azul"  # faixa-alvo do aluno padrão (Cinza)


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


@pytest.fixture
def exam(seeded: None) -> Exam:
    """Exame em andamento (Cinza → Cinza/Azul) num evento aberto, com quatro itens."""
    exam_event = ExamEvent(
        id="event-1",
        name="Exame março/2027",
        exam_date=EVENT_DATE,
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
    for order, req_id in enumerate(("t1", "t2", "t3", "t4"), start=1):
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
def answer_queries(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    """Registra os parâmetros de cada Query na tabela base ``Answers``.

    Cada consulta recebe ``Limit=1`` (só na chamada ao moto, não no registro),
    para que a leitura de um exame com várias marcações percorra várias páginas.
    """
    calls: list[dict[str, Any]] = []
    original = BaseClient._make_api_call

    def spy(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if (
            operation_name == "Query"
            and api_params.get("TableName") == os.environ[ANSWERS_TABLE_ENV]
            and "IndexName" not in api_params
        ):
            calls.append(dict(api_params))
            api_params = {**api_params, "Limit": 1}
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", spy)
    yield calls


def _path(exam: Exam, requirement_id: str | None = None) -> dict[str, str]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    if requirement_id is not None:
        path["requirement_id"] = requirement_id
    return path


def _mark(exam: Exam, requirement_id: str, correct: bool) -> dict[str, Any]:
    event = api_event(EXAMINER, path=_path(exam, requirement_id), body={"correct": correct})
    response = handlers.mark_answer(event, None)
    assert response["statusCode"] == 200, response["body"]
    return response


def _assert_all_pages_consistent(calls: list[dict[str, Any]]) -> None:
    assert len(calls) >= 2, f"a leitura deveria percorrer várias páginas: {calls}"
    not_consistent = [call for call in calls if call.get("ConsistentRead") is not True]
    assert not not_consistent, (
        "a consulta das marcações do exame deve usar ConsistentRead=True em todas as "
        f"páginas; {len(not_consistent)} de {len(calls)} sem ConsistentRead"
    )


def test_rn007_mark_summary_reads_answers_consistently(
    exam: Exam, answer_queries: list[dict[str, Any]]
) -> None:
    _mark(exam, "t1", True)
    _mark(exam, "t2", False)
    answer_queries.clear()

    response = _mark(exam, "t3", True)

    summary = response_json(response)["summary"]
    assert summary["THEORY"]["correct"] == 2
    assert summary["THEORY"]["marked"] == 3
    _assert_all_pages_consistent(answer_queries)


def test_rn007_unmark_summary_reads_answers_consistently(
    exam: Exam, answer_queries: list[dict[str, Any]]
) -> None:
    _mark(exam, "t1", True)
    _mark(exam, "t2", True)
    _mark(exam, "t3", False)
    answer_queries.clear()

    response = handlers.unmark_answer(api_event(EXAMINER, path=_path(exam, "t3")), None)

    assert response["statusCode"] == 200, response["body"]
    summary = response_json(response)["summary"]
    assert summary["THEORY"]["correct"] == 2
    assert summary["THEORY"]["marked"] == 2
    _assert_all_pages_consistent(answer_queries)


def test_rn006_exam_sheet_reads_answers_consistently(
    exam: Exam, answer_queries: list[dict[str, Any]]
) -> None:
    _mark(exam, "t1", True)
    _mark(exam, "t2", False)
    _mark(exam, "t4", True)
    answer_queries.clear()

    response = handlers.get_exam_sheet(api_event(EXAMINER, path=_path(exam)), None)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    answered = {item["id"] for item in body["items"] if item["answer"] is not None}
    assert answered == {"t1", "t2", "t4"}
    assert body["summary"]["THEORY"]["marked"] == 3
    _assert_all_pages_consistent(answer_queries)
