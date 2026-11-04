"""A releitura depois de edição ou presença recusada escolhia o erro errado (RN005, RN009, RN016).

Observado: quando a gravação condicional é recusada, o repositório relê o item
para dizer o motivo ao usuário: ``repository.students.save_student`` (``PUT
/students/{id}``) e ``repository.exams._condition_error`` (presença, ``POST
/events/{id}/exams``). As duas releituras são ``GetItem`` sem
``ConsistentRead``; logo depois da gravação concorrente que fez a condição
falhar, a réplica ainda devolve o item de antes dela, e a resposta descrevia um
estado que não existe mais:

- edição do nome em corrida com a exclusão do aluno: 409 "Não é possível
  alterar a graduação com exame em andamento" em vez de 404 "Aluno não
  encontrado";
- edição da graduação pelo examinador em corrida com a aprovação (RN009): 409
  "... com exame em andamento. Decida o exame primeiro." com o exame já
  decidido, em vez de 409 "Os dados do aluno mudaram. Tente de novo.". O teste
  chama ``save_student`` com os argumentos que o handler passa ao examinador:
  pelo handler, a leitura defasada de ``has_exam_in_progress`` responderia
  antes (``test_78_aluno_leitura_consistente.py``);
- presença em corrida com a exclusão do aluno, com a inativação dele ou com a
  presença dele em outro evento (RN005): 409 "Os dados do aluno mudaram" em vez
  de 404 "Aluno não encontrado", 400 "Aluno inativo não pode fazer exame" e 409
  "O aluno já tem um exame em andamento em outro evento.";
- presença em corrida com a exclusão do evento (RN016): 400 "Evento encerrado"
  em vez de 404 "Evento não encontrado".

Esperado: as releituras usam ``ConsistentRead=True``. A corrida é simulada
gravando a mudança concorrente logo antes da gravação condicional do
repositório; ``lag_eventual_reads`` (``conftest.py``) faz a tabela responder
como uma réplica uma gravação atrás às leituras sem ``ConsistentRead``. As
leituras do handler acontecem antes da corrida, então só a releitura fica
defasada.

Issue: #78
"""

from collections.abc import Callable
from dataclasses import replace
from datetime import date
from types import ModuleType
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
from domain.errors import DomainError
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.students import Student
from domain.users import ADMIN_GROUP, User
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EVENTS_TABLE_ENV, STUDENTS_TABLE_ENV

EVENT_ID = "event-1"
OTHER_EVENT_ID = "event-2"
NOW = "2026-11-01T12:00:00+00:00"
STUDENT_ID = "student-1"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2027-03-20T13:45:00+00:00")


@pytest.fixture
def student(seeded: None) -> Student:
    """Dois eventos abertos, sensei definido e o aluno padrão (Cinza, elegível nos dois)."""
    for event_id, exam_date in ((EVENT_ID, date(2027, 3, 20)), (OTHER_EVENT_ID, date(2030, 6, 1))):
        event_repo.create_event(
            ExamEvent(event_id, f"Exame {event_id}", exam_date, EventStatus.OPEN, NOW, NOW)
        )
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    created = replace(make_student(), id=STUDENT_ID, full_name="Ana")
    student_repo.create_student(created)
    return created


def _race_before(
    monkeypatch: pytest.MonkeyPatch, module: ModuleType, name: str, concurrent: Callable[[], Any]
) -> None:
    """Grava ``concurrent`` uma vez, logo antes da primeira chamada de ``module.name``."""
    original = getattr(module, name)
    done: list[bool] = []

    def racing(*args: Any, **kwargs: Any) -> Any:
        if not done:
            done.append(True)
            concurrent()
        return original(*args, **kwargs)

    monkeypatch.setattr(module, name, racing)


def _expect(status: int, call: Callable[[], dict[str, Any]]) -> Callable[[], None]:
    def run() -> None:
        response = call()
        assert response["statusCode"] == status, response["body"]

    return run


def _confirm(event_id: str) -> dict[str, Any]:
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": STUDENT_ID}), None
    )


def _payload(**changes: Any) -> dict[str, Any]:
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


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert (response["statusCode"], response_json(response)) == (status, {"message": message}), (
        f"{response['statusCode']} {response['body']}"
    )


# --- PUT /students/{id}: save_student ---------------------------------------------


def test_edit_racing_student_delete_answers_student_not_found(
    student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    _race_before(
        monkeypatch,
        student_repo,
        "save_student",
        _expect(
            204,
            lambda: student_handlers.delete_student(
                api_event(GUARDIAN, path={"id": STUDENT_ID}), None
            ),
        ),
    )

    response = student_handlers.update_student(
        api_event(GUARDIAN, path={"id": STUDENT_ID}, body=_payload(full_name="Ana Clara")), None
    )

    _assert_rejected(response, 404, "Aluno não encontrado")


def test_rn009_graduation_edit_racing_approval_answers_student_changed(
    student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _confirm(EVENT_ID)["statusCode"] == 201
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    # O sensei aprova entre a leitura do aluno pelo examinador e a gravação da edição.
    approved = exam_handlers.decide_exam(
        api_event(
            SENSEI, path={"id": EVENT_ID, "student_id": STUDENT_ID}, body={"result": "APPROVED"}
        ),
        None,
    )
    assert approved["statusCode"] == 200, approved["body"]
    edited = replace(student, current_belt_since=date(2026, 2, 14), updated_at=NOW)

    # A gravação que o PUT /students/{id} do examinador faz ao mudar a graduação.
    with pytest.raises(DomainError) as caught:
        student_repo.save_student(
            edited,
            require_no_exams=False,
            require_no_exam_in_progress=True,
            write_graduation=True,
            expected_graduation=student,
        )

    assert (caught.value.status_code, caught.value.message) == (
        409,
        "Os dados do aluno mudaram. Tente de novo.",
    )


# --- POST /events/{id}/exams: _condition_error ------------------------------------


def test_rn005_attendance_racing_student_delete_answers_student_not_found(
    student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    _race_before(
        monkeypatch,
        exam_repo,
        "create_exam",
        _expect(
            204,
            lambda: student_handlers.delete_student(
                api_event(GUARDIAN, path={"id": STUDENT_ID}), None
            ),
        ),
    )

    response = _confirm(EVENT_ID)

    _assert_rejected(response, 404, "Aluno não encontrado")


def test_rn005_attendance_racing_deactivation_answers_student_inactive(
    student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    _race_before(
        monkeypatch,
        exam_repo,
        "create_exam",
        _expect(
            200,
            lambda: student_handlers.update_student(
                api_event(EXAMINER, path={"id": STUDENT_ID}, body=_payload(active=False)), None
            ),
        ),
    )

    response = _confirm(EVENT_ID)

    _assert_rejected(response, 400, "Aluno inativo não pode fazer exame")


def test_rn005_attendance_racing_other_event_answers_in_progress_elsewhere(
    student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, STUDENTS_TABLE_ENV)
    _race_before(monkeypatch, exam_repo, "create_exam", _expect(201, lambda: _confirm(EVENT_ID)))

    response = _confirm(OTHER_EVENT_ID)

    _assert_rejected(response, 409, "O aluno já tem um exame em andamento em outro evento.")


def test_rn016_attendance_racing_event_delete_answers_event_not_found(
    student: Student, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV)
    _race_before(
        monkeypatch,
        exam_repo,
        "create_exam",
        _expect(
            204,
            lambda: event_handlers.delete_event(api_event(EXAMINER, path={"id": EVENT_ID}), None),
        ),
    )

    response = _confirm(EVENT_ID)

    _assert_rejected(response, 404, "Evento não encontrado")
