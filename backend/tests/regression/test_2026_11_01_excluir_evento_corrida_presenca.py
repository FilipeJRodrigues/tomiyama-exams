"""Excluir evento em corrida com a confirmação de presença deixa exame órfão.

Erro observado: o ``DELETE /events/{id}`` consulta ``event_has_exams`` e só
depois apaga o evento, sem condição na gravação. Se uma confirmação de presença
(RN005) for gravada entre a consulta e a exclusão, a resposta é 204, o evento
some e o exame fica no banco apontando para um evento inexistente.

Esperado (RN016): evento com exames nunca é excluído, nem em corrida. A exclusão
deve ser recusada com 409 "Evento possui exames registrados" e o evento continua
existindo. O teste simula a corrida gravando a presença imediatamente antes da
escrita de ``event_repo.delete_event``; a guarda precisa estar nessa escrita
(por exemplo, uma condição atômica no item do evento atualizada pela transação
da presença).
"""

from dataclasses import replace
from datetime import date

import pytest
from conftest import EXAMINER, api_event, make_student, response_json

from domain.events import EventStatus, ExamEvent
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo

NOW = "2026-11-01T12:00:00+00:00"


def test_rn016_delete_racing_with_attendance_keeps_event(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 13), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1")
    student_repo.create_student(student)

    original_delete = event_repo.delete_event
    raced: list[int] = []

    def delete_after_concurrent_attendance(event_id: str) -> None:
        confirm = exam_handlers.confirm_attendance(
            api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}),
            None,
        )
        raced.append(confirm["statusCode"])
        original_delete(event_id)

    monkeypatch.setattr(event_repo, "delete_event", delete_after_concurrent_attendance)

    response = event_handlers.delete_event(api_event(EXAMINER, path={"id": exam_event.id}), None)

    assert raced == [201], "a presença concorrente deveria ter sido gravada"
    assert exam_repo.list_by_event(exam_event.id), "o exame concorrente existe"
    assert response["statusCode"] == 409, response.get("body")
    assert response_json(response)["message"] == "Evento possui exames registrados"
    assert event_repo.get_event(exam_event.id) is not None
