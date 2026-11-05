"""A releitura depois da decisão recusada escolhia o erro errado (RN005, RN008, RN010).

Observado: quando a transação da decisão (``POST .../decision``) é recusada,
``repository.exams._decision_error`` relê as configurações, o exame ou o aluno
para dizer o motivo. As releituras são ``GetItem`` sem ``ConsistentRead``; logo
depois da gravação concorrente que fez a condição falhar, a réplica ainda
devolve o item de antes dela:

- o master remove o sensei enquanto o sensei decide: 403 "Somente o sensei pode
  decidir o exame" em vez de 409 "Defina o sensei nas configurações da
  academia" (RN008);
- duas decisões do mesmo exame em corrida (clique duplo) logo depois da
  presença: a réplica ainda sem a presença nem a primeira decisão
  (``writes_behind=2``) responde 404 "Exame não encontrado" em vez de 409
  "Exame já decidido" (RN010). As duas leituras do handler acontecem antes de
  qualquer gravação, então o teste chama a gravação do repositório direto;
- exame antigo, sem o marcador ``exam_in_progress_id`` (dados de antes do
  marcador), decidido logo depois da presença do aluno em outro evento: 409 "A
  graduação do aluno mudou desde a presença" em vez de 409 "O aluno já tem um
  exame em andamento em outro evento." (RN005).

Esperado: as releituras usam ``ConsistentRead=True``. ``lag_eventual_reads``
(``conftest.py``) faz a tabela responder como uma réplica atrasada às leituras
sem ``ConsistentRead``, inclusive às gravações feitas dentro de transações.

Issue: #78
"""

from collections.abc import Callable
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, api_event, lag_eventual_reads, make_student, response_json

from domain import dates
from domain import decisions as decision_rules
from domain import exams as exam_rules
from domain.decisions import Decision
from domain.errors import DomainError
from domain.events import EventStatus, ExamEvent
from domain.exams import ExamStatus, Graduation
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import (
    EXAM_IN_PROGRESS,
    EXAMS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    STUDENTS_TABLE_ENV,
    table,
)

EVENT_ID = "event-1"
OTHER_EVENT_ID = "event-2"
EVENT_DATE = date(2027, 3, 20)
NOW = "2026-11-01T12:00:00+00:00"
DECIDED_AT = "2027-03-20T15:00:00+00:00"
STUDENT_ID = "student-1"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: DECIDED_AT)


def _settings(sensei_user_id: str | None) -> AcademySettings:
    return AcademySettings(
        academy_name="Associação Tomiyama de Judô",
        sensei_user_id=sensei_user_id,
        certificate_city="Araraquara",
        updated_at=NOW,
    )


@pytest.fixture
def exam_event(seeded: None) -> ExamEvent:
    """Dois eventos abertos (devolve o primeiro), sensei definido e o aluno padrão (Cinza)."""
    events = [
        ExamEvent(EVENT_ID, "Exame março/2027", EVENT_DATE, EventStatus.OPEN, NOW, NOW),
        ExamEvent(OTHER_EVENT_ID, "Exame junho/2030", date(2030, 6, 1), EventStatus.OPEN, NOW, NOW),
    ]
    for item in events:
        event_repo.create_event(item)
    settings_repo.save_settings(_settings(SENSEI.sub))
    student_repo.create_student(replace(make_student(), id=STUDENT_ID, full_name="Ana"))
    return events[0]


def _confirm(event_id: str) -> dict[str, Any]:
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": STUDENT_ID}), None
    )
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)


def _decide(event_id: str, result: str) -> dict[str, Any]:
    return exam_handlers.decide_exam(
        api_event(SENSEI, path={"id": event_id, "student_id": STUDENT_ID}, body={"result": result}),
        None,
    )


def _race_before_decision(monkeypatch: pytest.MonkeyPatch, concurrent: Callable[[], Any]) -> None:
    """Grava ``concurrent`` logo antes da transação da decisão."""
    original = exam_repo.decide_exam

    def racing(*args: Any, **kwargs: Any) -> None:
        concurrent()
        original(*args, **kwargs)

    monkeypatch.setattr(exam_repo, "decide_exam", racing)


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert (response["statusCode"], response_json(response)) == (status, {"message": message}), (
        f"{response['statusCode']} {response['body']}"
    )


def test_rn008_decision_racing_sensei_removal_answers_no_sensei(
    exam_event: ExamEvent, monkeypatch: pytest.MonkeyPatch
) -> None:
    _confirm(EVENT_ID)
    lag_eventual_reads(monkeypatch, SETTINGS_TABLE_ENV)
    # O master salva as configurações sem sensei entre a leitura e a transação.
    _race_before_decision(monkeypatch, lambda: settings_repo.save_settings(_settings(None)))

    response = _decide(EVENT_ID, "APPROVED")

    _assert_rejected(response, 409, "Defina o sensei nas configurações da academia")


def test_rn010_decision_racing_another_decision_answers_already_decided(
    exam_event: ExamEvent, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = student_repo.get_student(STUDENT_ID)
    assert student is not None
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV, writes_behind=2)
    exam = exam_rules.confirm_attendance(
        exam_event, student, belt_repo.list_belts(), confirmed_by=EXAMINER.sub, now_iso=NOW
    )
    exam_repo.create_exam(exam, student)
    expected = Graduation.of(student)
    first = decision_rules.decide(
        exam, Decision(ExamStatus.FAILED, None), decided_by=SENSEI.sub, now_iso=DECIDED_AT
    )
    exam_repo.decide_exam(first, expected, None)
    # O segundo clique leu o exame em andamento antes da primeira decisão.
    second = decision_rules.decide(
        exam, Decision(ExamStatus.FAILED, "Repetida"), decided_by=SENSEI.sub, now_iso=DECIDED_AT
    )

    with pytest.raises(DomainError) as caught:
        exam_repo.decide_exam(second, expected, None)

    assert (caught.value.status_code, caught.value.message) == (409, "Exame já decidido")


def _drop_marker(student: Student) -> None:
    """Transforma o exame em andamento em dado de antes do marcador (só em dev)."""
    table(STUDENTS_TABLE_ENV).update_item(
        Key={"id": student.id}, UpdateExpression=f"REMOVE {EXAM_IN_PROGRESS}"
    )


def test_rn005_legacy_decision_right_after_attendance_elsewhere_answers_in_progress_elsewhere(
    exam_event: ExamEvent, monkeypatch: pytest.MonkeyPatch
) -> None:
    _confirm(EVENT_ID)
    student = student_repo.get_student(STUDENT_ID)
    assert student is not None
    _drop_marker(student)
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    _confirm(OTHER_EVENT_ID)

    response = _decide(EVENT_ID, "FAILED")

    _assert_rejected(response, 409, "O aluno já tem um exame em andamento em outro evento.")
