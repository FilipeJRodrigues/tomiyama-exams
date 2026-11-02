"""Edição do aluno no meio da aprovação desfazia a nova graduação (RN009).

Erro observado: o ``PUT /students/{id}`` lê o aluno, e a gravação
(``repository.students.save_student``, via ``replace_fields``) regrava todos os
campos do modelo, inclusive ``current_belt_id``, ``current_belt_since`` e
``stripes``. Quando o formulário reenvia a mesma graduação (só troca o nome, por
exemplo), a gravação não tem condição nenhuma sobre a graduação
(``require_no_exam_in_progress`` só entra quando a graduação muda em relação à
leitura). Se a aprovação do sensei (``POST .../decision``) grava a nova faixa
entre a leitura e a gravação do ``PUT``, o ``PUT`` devolve 200 e regrava a
faixa antiga: o exame fica ``APPROVED`` com a faixa-alvo, mas o aluno volta para
a faixa de origem, sem marcador de exame em andamento, sem erro para ninguém.
Vale para examinador e responsável.

Esperado (RN009, RN005 com a decisão do responsável de 2026-11-02, "graduação
travada durante o exame"; contrato do ``backend/README.md``): uma edição que
não muda a graduação nunca desfaz a graduação gravada pela decisão. Ou o
``PUT`` é recusado (409, nada gravado), ou ele grava os outros campos e a
graduação continua a da aprovação.
"""

from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, api_event, make_student

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import STUDENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
TODAY = date(2026, 11, 1)
EVENT_DATE = date(2027, 3, 20)
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


@pytest.fixture
def exam_in_progress(seeded: None) -> tuple[ExamEvent, Student]:
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    exam_event = ExamEvent("event-a", "Exame A", EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(exam_event)
    student = make_student()
    student_repo.create_student(student)
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    return exam_event, student


def _same_graduation_body(student: Student) -> dict[str, Any]:
    return {
        "full_name": "Ana Maria",
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "federation_id": student.federation_id,
        "active": student.active,
    }


@pytest.mark.parametrize("user", [EXAMINER, GUARDIAN], ids=["examiner", "guardian"])
def test_rn009_approval_during_student_edit_is_not_reverted(
    exam_in_progress: tuple[ExamEvent, Student], monkeypatch: pytest.MonkeyPatch, user: User
) -> None:
    exam_event, student = exam_in_progress
    real_check = student_repo.has_exam_in_progress

    def approve_in_between(student_id: str) -> bool:
        # The PUT already read the student; the sensei approves before it writes.
        seen = real_check(student_id)
        response = exam_handlers.decide_exam(
            api_event(
                SENSEI,
                path={"id": exam_event.id, "student_id": student.id},
                body={"result": "APPROVED"},
            ),
            None,
        )
        assert response["statusCode"] == 200, response["body"]
        return seen

    monkeypatch.setattr(student_repo, "has_exam_in_progress", approve_in_between)

    response = student_handlers.update_student(
        api_event(user, path={"id": student.id}, body=_same_graduation_body(student)), None
    )

    exam = exam_repo.get_exam(exam_event.id, student.id)
    assert exam is not None
    stored = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]
    assert response["statusCode"] in (200, 409), response["body"]
    # Whatever the answer, the approved graduation stays (RN009).
    assert stored["current_belt_id"] == exam.target_belt_id
    assert stored["current_belt_since"] == EVENT_DATE.isoformat()
    if response["statusCode"] == 409:
        assert stored["full_name"] == student.full_name
