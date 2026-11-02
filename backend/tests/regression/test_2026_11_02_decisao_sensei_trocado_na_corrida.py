"""Decisão gravada por quem deixou de ser o sensei entre a leitura e a gravação.

Erro observado: ``POST /events/{id}/exams/{student_id}/decision`` lê
``settings.sensei_user_id`` com ``GetItem`` e depois grava a decisão numa
transação (``TransactWriteItems``) que confere o exame e a graduação do aluno,
mas não confere as configurações. Se o master trocar o sensei entre a leitura e
a gravação, o sensei anterior ainda aprova o exame (200) e muda a faixa do
aluno, embora no instante da gravação já não seja o sensei.

Esperado (RN008): só o sensei configurado no momento da gravação decide. A
transação deve conferir também que ``sensei_user_id`` ainda é quem decide; se
mudou, a decisão é recusada (por exemplo, 403 "Somente o sensei pode decidir o
exame") e nada é gravado no exame nem no aluno.
"""

from dataclasses import replace
from datetime import date

import pytest
from conftest import EXAMINER, api_event, make_student

from domain.events import EventStatus, ExamEvent
from domain.exams import ExamStatus
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import STUDENTS_TABLE_ENV, table

NOW = "2026-11-01T12:00:00+00:00"
OLD_SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


def _settings(sensei_user_id: str) -> AcademySettings:
    return AcademySettings(
        academy_name="Associação Tomiyama de Judô",
        sensei_user_id=sensei_user_id,
        certificate_city="Araraquara",
        updated_at=NOW,
    )


def test_rn008_sensei_replaced_between_read_and_write(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = ExamEvent(
        "event-1", "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1")
    student_repo.create_student(student)
    confirmed = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert confirmed["statusCode"] == 201, confirmed["body"]

    settings_repo.save_settings(_settings(OLD_SENSEI.sub))
    stale = settings_repo.get_settings()
    # The master picks another sensei after the handler read the settings.
    settings_repo.save_settings(_settings("sensei-2"))
    monkeypatch.setattr(settings_repo, "get_settings", lambda: stale)
    student_before = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"]

    response = exam_handlers.decide_exam(
        api_event(
            OLD_SENSEI,
            path={"id": exam_event.id, "student_id": student.id},
            body={"result": "APPROVED"},
        ),
        None,
    )

    exam = exam_repo.get_exam(exam_event.id, student.id)
    assert exam is not None
    assert response["statusCode"] != 200, "o sensei anterior decidiu depois da troca"
    assert exam.status == ExamStatus.IN_PROGRESS
    assert table(STUDENTS_TABLE_ENV).get_item(Key={"id": student.id})["Item"] == student_before
