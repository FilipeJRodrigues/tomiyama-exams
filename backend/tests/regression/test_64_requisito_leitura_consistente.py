"""O requisito lido por chave podia estar defasado logo depois de gravado (RN017).

Observado: ``repository.requirements.get_requirement`` lia a tabela
``Requirements`` sem ``ConsistentRead``. A leitura eventualmente consistente
pode, por cerca de 1 s depois de uma gravação, não trazer um item recém-criado.
Ela decide o 404 de ``PUT``/``DELETE /requirements/{id}`` (``_get_or_404``) e
o da marcação (``_requirement_or_404`` em ``handlers/exams.py``). Assim, editar,
excluir ou marcar um item logo depois do ``POST /requirements`` respondia 404
"Requisito não encontrado".

Esperado: a leitura por chave do requisito usa ``ConsistentRead=True``. O moto
é sempre consistente; ``lag_eventual_reads`` (``conftest.py``) faz a tabela
responder como uma réplica uma gravação atrás às leituras sem
``ConsistentRead`` e registra os parâmetros de cada ``GetItem``.

Issue: #64
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    MASTER,
    api_event,
    belt_id,
    lag_eventual_reads,
    make_student,
    response_json,
)

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.requirements import Requirement, RequirementKind
from handlers import exams as exam_handlers
from handlers import requirements as requirement_handlers
from repository import events as event_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository.tables import REQUIREMENTS_TABLE_ENV

TARGET = "Cinza/Azul"  # faixa-alvo do aluno padrão (Cinza)
NOW = "2026-11-01T12:00:00+00:00"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2027-03-20T13:45:00+00:00")


def _payload(description: str = "Item novo") -> dict[str, Any]:
    return {
        "belt_id": belt_id(TARGET),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": description,
        "expected_answer": "Resposta",
    }


def _create_requirement_via_api() -> str:
    # Items of the main profile: only the admin master writes them (#144).
    response = requirement_handlers.create_requirement(api_event(MASTER, body=_payload()), None)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)["id"]


def _not_consistent(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [call for call in calls if call.get("ConsistentRead") is not True]


def test_rn017_get_requirement_reads_requirements_table_consistently(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = lag_eventual_reads(monkeypatch, REQUIREMENTS_TABLE_ENV)
    requirement_repo.create_requirement(
        Requirement(
            id="t1",
            belt_id=belt_id(TARGET),
            kind=RequirementKind.THEORY,
            category="Vocabulário",
            description="Item t1",
            expected_answer="Resposta",
            sort_order=1,
        )
    )

    found = requirement_repo.get_requirement("t1")

    assert calls, "get_requirement deveria ler a tabela Requirements com GetItem"
    assert not _not_consistent(calls), (
        f"get_requirement deve usar ConsistentRead=True; leituras sem ele: {_not_consistent(calls)}"
    )
    assert found is not None and found.id == "t1"


def test_rn017_update_right_after_create_finds_requirement(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, REQUIREMENTS_TABLE_ENV)
    requirement_id = _create_requirement_via_api()

    response = requirement_handlers.update_requirement(
        api_event(MASTER, path={"id": requirement_id}, body=_payload("Item novo, texto corrigido")),
        None,
    )

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["description"] == "Item novo, texto corrigido"


def test_rn017_delete_right_after_create_removes_requirement(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, REQUIREMENTS_TABLE_ENV)
    requirement_id = _create_requirement_via_api()

    response = requirement_handlers.delete_requirement(
        api_event(MASTER, path={"id": requirement_id}), None
    )

    assert response["statusCode"] == 204, response["body"]
    assert requirement_id not in {item.id for item in requirement_repo.list_all()}


def test_rn017_marking_right_after_create_finds_requirement(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    event_repo.create_event(
        ExamEvent(
            id="event-1",
            name="Exame março/2027",
            exam_date=date(2027, 3, 20),
            status=EventStatus.OPEN,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    student_repo.create_student(replace(make_student(), id="student-1", full_name="Ana"))
    attendance = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": "event-1"}, body={"student_id": "student-1"}), None
    )
    assert attendance["statusCode"] == 201, attendance["body"]
    lag_eventual_reads(monkeypatch, REQUIREMENTS_TABLE_ENV)
    requirement_id = _create_requirement_via_api()

    response = exam_handlers.mark_answer(
        api_event(
            EXAMINER,
            path={"id": "event-1", "student_id": "student-1", "requirement_id": requirement_id},
            body={"correct": True},
        ),
        None,
    )

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["summary"]["THEORY"]["correct"] == 1
