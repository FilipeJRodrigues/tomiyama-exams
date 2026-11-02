"""Listas "ordenadas por nome" põem nomes acentuados depois do Z.

Erro observado: ``GET /events/{id}/exams`` e ``GET /students`` ordenam com
``str.casefold()``, que compara pontos de código. "Álvaro" (U+00C1/U+00E1) vem
depois de "zélia", e "Érica" depois de "Zeca". Nomes com acento inicial são
comuns em pt-BR.

Esperado: ordem alfabética do português, ignorando acentos e maiúsculas:
Álvaro, bruno, Érica, zélia.
"""

from dataclasses import replace
from datetime import date

from conftest import EXAMINER, api_event, make_student, response_json

from domain.events import EventStatus, ExamEvent
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import students as student_repo

NOW = "2026-11-01T12:00:00+00:00"
NAMES = ["zélia", "Érica", "bruno", "Álvaro"]
EXPECTED = ["Álvaro", "bruno", "Érica", "zélia"]


def _students() -> list[str]:
    ids = []
    for index, name in enumerate(NAMES):
        student = replace(make_student(), id=f"student-{index}", full_name=name)
        student_repo.create_student(student)
        ids.append(student.id)
    return ids


def test_rn005_event_exams_sorted_alphabetically_with_accents(seeded: None) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 13), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    for student_id in _students():
        confirm = exam_handlers.confirm_attendance(
            api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student_id}),
            None,
        )
        assert confirm["statusCode"] == 201, confirm["body"]

    response = exam_handlers.list_event_exams(api_event(EXAMINER, path={"id": exam_event.id}), None)

    assert [view["student_name"] for view in response_json(response)] == EXPECTED


def test_students_sorted_alphabetically_with_accents(seeded: None) -> None:
    _students()

    response = student_handlers.list_students(api_event(EXAMINER), None)

    assert [view["full_name"] for view in response_json(response)] == EXPECTED
