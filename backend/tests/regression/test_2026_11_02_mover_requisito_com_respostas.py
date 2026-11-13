"""Trocar a faixa de um requisito já marcado fazia o exame perder a resposta.

Observado: com o item marcado num exame, ``PUT /requirements/{id}`` com outro
``belt_id`` é aceito (200). A resposta continua gravada em ``Answers`` e no
``answer_count``, mas some da folha e do percentual do exame (RN006/RN007),
não pode mais ser desmarcada (400 "Item não pertence à faixa do exame") e o
requisito nunca mais pode ser excluído (409 "Requisito possui respostas
registradas"), sem nenhuma tela que mostre essa resposta. Na prática, é o
mesmo efeito da exclusão que o 409 do ``DELETE`` quer impedir, e num exame
decidido altera o resultado registrado (RN010).

Esperado: a resposta registrada continua visível e contada no exame depois da
tentativa de edição. O teste não fixa o status nem a mensagem da recusa (por
exemplo, 409 "Requisito possui respostas registradas"): isso fica para a
decisão do usuário.
"""

from dataclasses import replace
from datetime import date

import pytest
from conftest import EXAMINER, MASTER, api_event, belt_id, make_student, response_json

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.requirements import Requirement, RequirementKind
from handlers import exams as exam_handlers
from handlers import requirements as requirement_handlers
from repository import events as event_repo
from repository import requirements as requirement_repo
from repository import students as student_repo

TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)
NOW = "2026-11-01T12:00:00+00:00"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


def test_rn006_rn007_moving_answered_item_keeps_the_exam_answer(seeded: None) -> None:
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
    student_repo.create_student(replace(make_student(), id="student-1"))
    confirmed = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": "event-1"}, body={"student_id": "student-1"}), None
    )
    assert confirmed["statusCode"] == 201, confirmed["body"]
    requirement_repo.create_requirement(
        Requirement(
            id="t1",
            belt_id=belt_id(TARGET),
            kind=RequirementKind.THEORY,
            category="Vocabulário",
            description="Item t1",
            expected_answer=None,
            sort_order=1,
        )
    )
    exam_path = {"id": "event-1", "student_id": "student-1"}
    marked = exam_handlers.mark_answer(
        api_event(EXAMINER, path={**exam_path, "requirement_id": "t1"}, body={"correct": True}),
        None,
    )
    assert marked["statusCode"] == 200, marked["body"]

    # The admin master, the only one who edits the main profile (#144): an
    # examiner would get the 403 and the item would stay for the wrong reason.
    requirement_handlers.update_requirement(
        api_event(
            MASTER,
            path={"id": "t1"},
            body={
                "belt_id": belt_id("Cinza"),
                "kind": "THEORY",
                "category": "Vocabulário",
                "description": "Item t1",
                "sort_order": 1,
            },
        ),
        None,
    )

    sheet = response_json(exam_handlers.get_exam_sheet(api_event(EXAMINER, path=exam_path), None))
    answered = [item for item in sheet["items"] if item["id"] == "t1"]
    assert answered, "a resposta registrada sumiu da folha do exame"
    assert answered[0]["answer"]["correct"] is True
    assert sheet["summary"]["THEORY"]["correct"] == 1
