"""Presença grava faixa-alvo de uma graduação que o aluno já não tem.

Erro observado: ``POST /events/{id}/exams`` lê o aluno, calcula faixa-alvo e
tipo e grava numa transação cuja ``ConditionCheck`` em Students só confere
``active``. Se a graduação mudar entre a leitura e a gravação (o responsável
ainda pode editá-la antes do primeiro exame, RN013), o exame nasce com 201 e
faixa-alvo Cinza/Azul para um aluno que já está na Azul.

Esperado (RN005/RN003/RN004): o exame só é gravado se a faixa-alvo e o tipo
corresponderem à graduação atual do aluno; senão a confirmação é recusada (por
exemplo, 409 "Outra confirmação está em andamento. Tente de novo.") ou refeita
com os dados novos.
"""

from dataclasses import replace
from datetime import date

import pytest
from conftest import EXAMINER, api_event, belt_id, make_student

from domain.events import EventStatus, ExamEvent
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import students as student_repo

NOW = "2026-11-01T12:00:00+00:00"


def test_rn005_belt_changed_between_read_and_write(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 13), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    stale = replace(make_student(belt_name="Cinza", since=date(2026, 3, 14)), id="student-1")
    student_repo.create_student(stale)
    # Graduation edited after the handler read the student.
    student_repo.save_student(
        replace(stale, current_belt_id=belt_id("Azul"), current_belt_since=date(2025, 1, 1))
    )
    monkeypatch.setattr(student_repo, "get_student", lambda student_id: stale)

    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": stale.id}), None
    )

    exam = exam_repo.get_exam(exam_event.id, stale.id)
    if response["statusCode"] == 201:
        assert exam is not None
        assert exam.target_belt_id == belt_id("Azul/Amarela"), "faixa-alvo da graduação antiga"
    else:
        assert exam is None
