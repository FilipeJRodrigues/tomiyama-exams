"""Excluir aluno em corrida com a confirmação de presença deixa exame órfão.

Erro observado: o ``DELETE /students/{id}`` consulta ``student_has_exams`` e só
depois apaga o aluno, sem condição na gravação. Se a presença (RN005) for
confirmada entre a consulta e a exclusão, a resposta é 204, o aluno some e o
exame fica sem aluno (na lista do evento, ``student_name`` vira ``null``). O
histórico se perde, que é o que a RN018 proíbe.

Esperado (RN018): aluno com exames nunca é excluído, nem em corrida. A exclusão
deve ser recusada com 409 "Aluno possui exames registrados" e o aluno continua
existindo. O teste simula a corrida gravando a presença imediatamente antes da
escrita de ``student_repo.delete_student``; a guarda precisa estar nessa escrita.
"""

from dataclasses import replace
from datetime import date

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, make_student, response_json

from domain.events import EventStatus, ExamEvent
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo

NOW = "2026-11-01T12:00:00+00:00"


def test_rn018_delete_racing_with_attendance_keeps_student(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 13), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1")
    student_repo.create_student(student)

    original_delete = student_repo.delete_student
    raced: list[int] = []

    def delete_after_concurrent_attendance(student_id: str) -> None:
        confirm = exam_handlers.confirm_attendance(
            api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}),
            None,
        )
        raced.append(confirm["statusCode"])
        original_delete(student_id)

    monkeypatch.setattr(student_repo, "delete_student", delete_after_concurrent_attendance)

    response = student_handlers.delete_student(api_event(GUARDIAN, path={"id": student.id}), None)

    assert raced == [201], "a presença concorrente deveria ter sido gravada"
    assert exam_repo.get_exam(exam_event.id, student.id) is not None
    assert response["statusCode"] == 409, response.get("body")
    assert response_json(response)["message"] == "Aluno possui exames registrados"
    assert student_repo.get_student(student.id) is not None
