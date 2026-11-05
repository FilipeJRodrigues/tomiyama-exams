"""O aluno lido por chave podia estar defasado logo depois de gravado (RN005, RN009, RN013).

Observado: ``repository.students.get_student`` e ``has_exam_in_progress`` liam a
tabela ``Students`` sem ``ConsistentRead``. A leitura eventualmente consistente
pode, por cerca de 1 s depois de uma gravação, devolver a versão anterior do
item, ou nenhum item quando ele acabou de ser criado. Assim:

- ``GET``/``PUT``/``DELETE /students/{id}`` e a presença (``POST
  /events/{id}/exams``) logo depois do ``POST /students`` respondiam 404 "Aluno
  não encontrado";
- uma segunda edição logo depois de corrigir a graduação partia da graduação
  antiga (vira o ``expected_graduation`` da gravação condicional) e era
  recusada sem motivo real, aqui com 403 "Somente examinadores alteram a
  graduação após o primeiro exame" para um aluno sem exames (RN013);
- a decisão logo depois de corrigir a graduação e confirmar a presença
  comparava a graduação da presença com a antiga e respondia 409 "A graduação
  do aluno mudou desde a presença" (RN009). Aqui a réplica está sem as duas
  gravações (``writes_behind=2``) e a presença é gravada pelo repositório, para
  que só a leitura da decisão fique em jogo;
- corrigir a graduação logo depois da decisão lia o marcador
  ``exam_in_progress_id`` antigo em ``has_exam_in_progress`` e respondia 409 "Não
  é possível alterar a graduação com exame em andamento" com o exame já
  decidido (RN005).

Esperado: as leituras por chave do aluno usam ``ConsistentRead=True``. O moto é
sempre consistente; ``lag_eventual_reads`` (``conftest.py``) faz a tabela
responder como uma réplica atrasada às leituras sem ``ConsistentRead``,
inclusive às gravações feitas dentro de transações (presença e decisão), e
registra os parâmetros de cada ``GetItem``.

Issue: #78
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    GUARDIAN,
    api_event,
    belt_id,
    lag_eventual_reads,
    make_student,
    response_json,
)

from domain import dates
from domain import exams as exam_rules
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import STUDENTS_TABLE_ENV

EVENT_ID = "event-1"
EVENT_DATE = date(2027, 3, 20)
NOW = "2026-11-01T12:00:00+00:00"
STUDENT_ID = "student-1"
FIXED_SINCE = "2026-02-14"  # data da faixa corrigida (a original é 2026-03-14)
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2027-03-20T13:45:00+00:00")


def _payload(**changes: Any) -> dict[str, Any]:
    """Corpo completo do formulário do aluno padrão (Cinza desde 2026-03-14)."""
    return {
        "full_name": "Ana",
        "birth_date": "2018-05-10",
        "current_belt_id": belt_id("Cinza"),
        "current_belt_since": "2026-03-14",
        "stripes": 0,
        "federation_id": None,
        "active": True,
        **changes,
    }


def _create_via_api() -> str:
    response = student_handlers.create_student(api_event(GUARDIAN, body=_payload()), None)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)["id"]


def _put(user: User, student_id: str, **changes: Any) -> dict[str, Any]:
    return student_handlers.update_student(
        api_event(user, path={"id": student_id}, body=_payload(**changes)), None
    )


def _stored_student() -> Student:
    """Aluno padrão já gravado (antes de a réplica atrasar)."""
    student = replace(make_student(), id=STUDENT_ID, full_name="Ana")
    student_repo.create_student(student)
    return student


@pytest.fixture
def exam_ready(seeded: None) -> ExamEvent:
    """Evento aberto e sensei definido."""
    exam_event = ExamEvent(EVENT_ID, "Exame março/2027", EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(exam_event)
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    return exam_event


def _confirm(student_id: str) -> dict[str, Any]:
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": EVENT_ID}, body={"student_id": student_id}), None
    )


def _decide(result: str) -> dict[str, Any]:
    return exam_handlers.decide_exam(
        api_event(SENSEI, path={"id": EVENT_ID, "student_id": STUDENT_ID}, body={"result": result}),
        None,
    )


def _not_consistent(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [call for call in calls if call.get("ConsistentRead") is not True]


def test_rn013_get_student_reads_students_table_consistently(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    _stored_student()

    found = student_repo.get_student(STUDENT_ID)

    assert found is not None and found.id == STUDENT_ID, (
        "get_student logo depois do cadastro deveria achar o aluno"
    )
    assert not _not_consistent(calls), (
        f"get_student deve usar ConsistentRead=True; leituras sem ele: {_not_consistent(calls)}"
    )


def test_rn013_get_right_after_create_finds_student(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    student_id = _create_via_api()

    response = student_handlers.get_student(api_event(GUARDIAN, path={"id": student_id}), None)

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["id"] == student_id


def test_rn013_update_right_after_create_finds_student(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    student_id = _create_via_api()

    response = _put(GUARDIAN, student_id, full_name="Ana Clara")

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["full_name"] == "Ana Clara"


def test_rn018_delete_right_after_create_removes_student(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    student_id = _create_via_api()

    response = student_handlers.delete_student(api_event(GUARDIAN, path={"id": student_id}), None)

    assert response["statusCode"] == 204, response["body"]
    assert [student.id for student in student_repo.list_all()] == []


def test_rn005_attendance_right_after_create_is_confirmed(
    exam_ready: ExamEvent, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    student_id = _create_via_api()

    response = _confirm(student_id)

    assert response["statusCode"] == 201, response["body"]
    assert response_json(response)["student_id"] == student_id


def test_rn013_second_edit_right_after_graduation_fix_is_accepted(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stored_student()
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    fixed = _put(GUARDIAN, STUDENT_ID, current_belt_since=FIXED_SINCE)
    assert fixed["statusCode"] == 200, fixed["body"]

    # O formulário já mostra a data corrigida e o responsável só acerta o nome.
    response = _put(GUARDIAN, STUDENT_ID, full_name="Ana Clara", current_belt_since=FIXED_SINCE)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert (body["full_name"], body["current_belt_since"]) == ("Ana Clara", FIXED_SINCE)


def test_rn009_decision_right_after_graduation_fix_and_attendance_is_accepted(
    exam_ready: ExamEvent, monkeypatch: pytest.MonkeyPatch
) -> None:
    student = _stored_student()
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV, writes_behind=2)
    fixed = _put(EXAMINER, STUDENT_ID, current_belt_since=FIXED_SINCE)
    assert fixed["statusCode"] == 200, fixed["body"]
    corrected = replace(student, current_belt_since=date.fromisoformat(FIXED_SINCE))
    exam = exam_rules.confirm_attendance(
        exam_ready, corrected, belt_repo.list_belts(), confirmed_by=EXAMINER.sub, now_iso=NOW
    )
    exam_repo.create_exam(exam, corrected)

    response = _decide("APPROVED")

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["student"]["current_belt_id"] == belt_id("Cinza/Azul")


def test_rn005_graduation_fix_right_after_decision_is_accepted(
    exam_ready: ExamEvent, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stored_student()
    confirmed = _confirm(STUDENT_ID)
    assert confirmed["statusCode"] == 201, confirmed["body"]
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    decided = _decide("FAILED")
    assert decided["statusCode"] == 200, decided["body"]

    response = _put(EXAMINER, STUDENT_ID, current_belt_since=FIXED_SINCE)

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["current_belt_since"] == FIXED_SINCE
