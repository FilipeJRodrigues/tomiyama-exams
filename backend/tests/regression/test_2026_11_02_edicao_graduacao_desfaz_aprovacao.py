"""Edição da graduação pelo examinador no meio da aprovação desfazia a nova faixa (RN009).

Erro observado: o ``PUT /students/{id}`` lê o aluno (``get_student``) e, depois,
lê o marcador ``exam_in_progress_id`` numa segunda leitura
(``has_exam_in_progress``). Se a aprovação do sensei (``POST .../decision``)
acontece entre as duas leituras, o handler valida a edição contra a graduação
antiga (lida com o marcador) mas acha que não há exame em andamento (o marcador
já saiu). Quando o examinador muda a graduação (por exemplo, +1 grau sobre a
faixa que ele viu), a gravação só exige ``attribute_not_exists(exam_in_progress_id)``,
que agora é verdade, e regrava a faixa de origem por cima da faixa aprovada:
o exame fica ``APPROVED`` com a faixa-alvo e o aluno volta para a faixa antiga,
com 200 e sem erro para ninguém. A correção da 1ª rodada
(``save_student(write_graduation=False)``) só cobre a edição que não muda a
graduação.

Esperado (RN009; RN005 com a decisão do responsável de 2026-11-02, "graduação
travada durante o exame"): a edição montada sobre a graduação lida com exame em
andamento nunca desfaz a graduação gravada pela decisão. O ``PUT`` é recusado
com 409 e nada é gravado; a graduação continua a da aprovação.
"""

from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, api_event, make_student

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


def _one_more_stripe_body(student: Student) -> dict[str, Any]:
    return {
        "full_name": student.full_name,
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes + 1,
        "federation_id": student.federation_id,
        "active": student.active,
    }


def test_rn009_approval_between_reads_is_not_reverted_by_graduation_edit(
    exam_in_progress: tuple[ExamEvent, Student], monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event, student = exam_in_progress
    real_check = student_repo.has_exam_in_progress

    def approve_then_check(student_id: str) -> bool:
        # The PUT already read the student (old belt, marker present); the
        # sensei approves before the marker is read.
        response = exam_handlers.decide_exam(
            api_event(
                SENSEI,
                path={"id": exam_event.id, "student_id": student.id},
                body={"result": "APPROVED"},
            ),
            None,
        )
        assert response["statusCode"] == 200, response["body"]
        return real_check(student_id)

    monkeypatch.setattr(student_repo, "has_exam_in_progress", approve_then_check)

    response = student_handlers.update_student(
        api_event(EXAMINER, path={"id": student.id}, body=_one_more_stripe_body(student)), None
    )

    exam = exam_repo.get_exam(exam_event.id, student.id)
    assert exam is not None
    stored = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]
    # The approved graduation stays (RN009) and the stale edit is refused.
    assert stored["current_belt_id"] == exam.target_belt_id
    assert stored["current_belt_since"] == EVENT_DATE.isoformat()
    assert response["statusCode"] == 409, response["body"]
