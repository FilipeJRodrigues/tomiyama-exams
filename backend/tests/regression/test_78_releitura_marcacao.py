"""A releitura depois da marcação recusada escolhia o erro errado (RN006, RN010, RN016).

Observado: quando a transação da marcação (``PUT``/``DELETE
.../answers/{requirement_id}``) é recusada, ``repository.answers._guard_error``
relê o exame ou o evento e ``_requirement_error`` relê o requisito para dizer o
motivo. As releituras são ``GetItem`` sem ``ConsistentRead``; logo depois da
gravação concorrente que fez a condição falhar, a réplica ainda devolve o item
de antes dela, ou nenhum item quando ele foi criado no mesmo instante:

- requisito excluído enquanto o examinador marca: 400 "Item não pertence à
  faixa do exame" em vez de 404 "Requisito não encontrado" (RN006);
- marcação em corrida com a decisão logo depois da presença: a réplica ainda
  sem a presença nem a decisão (``writes_behind=2``) responde 404 "Exame não
  encontrado" em vez de 409 "Exame já decidido" (RN010). A leitura do exame no
  handler também é defasada (``test_78_exame_leitura_consistente.py``), então o
  teste chama a gravação do repositório direto;
- marcação em corrida com o encerramento de um evento criado no mesmo instante
  (criação, presença e encerramento ainda fora da réplica, ``writes_behind=3``):
  404 "Evento não encontrado" em vez de 400 "Evento encerrado" (RN016).

Esperado: as releituras usam ``ConsistentRead=True``. A corrida é simulada
gravando a mudança concorrente logo antes da transação da marcação;
``lag_eventual_reads`` (``conftest.py``) faz a tabela responder como uma
réplica atrasada às leituras sem ``ConsistentRead``, inclusive às gravações
feitas dentro de transações.

Issue: #78
"""

from collections.abc import Callable
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    MASTER,
    api_event,
    belt_id,
    lag_eventual_reads,
    make_student,
    response_json,
)

from domain import answers as answer_rules
from domain import dates
from domain import decisions as decision_rules
from domain import exams as exam_rules
from domain.decisions import Decision
from domain.errors import DomainError
from domain.events import EventStatus, ExamEvent
from domain.exams import ExamStatus, Graduation
from domain.requirements import Requirement, RequirementKind
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import requirements as requirement_handlers
from repository import answers as answer_repo
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EVENTS_TABLE_ENV, EXAMS_TABLE_ENV, REQUIREMENTS_TABLE_ENV

EVENT_ID = "event-1"
EVENT_NAME = "Exame março/2027"
EVENT_DATE = date(2027, 3, 20)
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
STUDENT_ID = "student-1"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
REQUIREMENT = Requirement(
    id="t1",
    belt_id=belt_id("Cinza/Azul"),
    kind=RequirementKind.THEORY,
    category="Vocabulário",
    description="Item t1",
    expected_answer="Resposta",
    sort_order=1,
)


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


@pytest.fixture
def ready(seeded: None) -> None:
    """Sensei definido, aluno Cinza elegível para a Cinza/Azul e o item t1 dessa faixa."""
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    student_repo.create_student(replace(make_student(), id=STUDENT_ID, full_name="Ana"))
    requirement_repo.create_requirement(REQUIREMENT)


def _create_event() -> ExamEvent:
    exam_event = ExamEvent(EVENT_ID, EVENT_NAME, EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    event_repo.create_event(exam_event)
    return exam_event


def _confirm() -> None:
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": EVENT_ID}, body={"student_id": STUDENT_ID}), None
    )
    assert response["statusCode"] == 201, response["body"]


def _mark() -> dict[str, Any]:
    return exam_handlers.mark_answer(
        api_event(
            EXAMINER,
            path={"id": EVENT_ID, "student_id": STUDENT_ID, "requirement_id": REQUIREMENT.id},
            body={"correct": True},
        ),
        None,
    )


def _race_before_marking(monkeypatch: pytest.MonkeyPatch, concurrent: Callable[[], None]) -> None:
    """Grava ``concurrent`` logo antes da transação da marcação."""
    original = answer_repo.save_answer

    def racing(*args: Any, **kwargs: Any) -> None:
        concurrent()
        original(*args, **kwargs)

    monkeypatch.setattr(answer_repo, "save_answer", racing)


def _expect(status: int, call: Callable[[], dict[str, Any]]) -> Callable[[], None]:
    def run() -> None:
        response = call()
        assert response["statusCode"] == status, response["body"]

    return run


def _assert_rejected(response: dict[str, Any], status: int, message: str) -> None:
    assert (response["statusCode"], response_json(response)) == (status, {"message": message}), (
        f"{response['statusCode']} {response['body']}"
    )


def test_rn006_marking_racing_requirement_delete_answers_requirement_not_found(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _create_event()
    _confirm()
    lag_eventual_reads(monkeypatch, REQUIREMENTS_TABLE_ENV)
    _race_before_marking(
        monkeypatch,
        _expect(
            204,
            # Only the admin master deletes items of the main profile (#144).
            lambda: requirement_handlers.delete_requirement(
                api_event(MASTER, path={"id": REQUIREMENT.id}), None
            ),
        ),
    )

    response = _mark()

    _assert_rejected(response, 404, "Requisito não encontrado")


def test_rn010_marking_racing_decision_answers_already_decided(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    exam_event = _create_event()
    student = student_repo.get_student(STUDENT_ID)
    assert student is not None
    lag_eventual_reads(monkeypatch, EXAMS_TABLE_ENV, writes_behind=2)
    exam = exam_rules.confirm_attendance(
        exam_event, student, belt_repo.list_belts(), confirmed_by=EXAMINER.sub, now_iso=NOW
    )
    exam_repo.create_exam(exam, student)
    # A marcação leu o exame em andamento; o sensei decide antes da transação dela.
    answer = answer_rules.mark(
        exam, exam_event, REQUIREMENT, correct=True, marked_by=EXAMINER.sub, now_iso=MARKED_AT
    )
    decided = decision_rules.decide(
        exam, Decision(ExamStatus.FAILED, None), decided_by=SENSEI.sub, now_iso=MARKED_AT
    )
    exam_repo.decide_exam(decided, Graduation.of(student), None)

    with pytest.raises(DomainError) as caught:
        answer_repo.save_answer(exam, answer)

    assert (caught.value.status_code, caught.value.message) == (409, "Exame já decidido")


def test_rn016_marking_racing_closing_of_new_event_answers_event_closed(
    ready: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, EVENTS_TABLE_ENV, writes_behind=3)
    _create_event()
    _confirm()
    _race_before_marking(
        monkeypatch,
        _expect(
            200,
            lambda: event_handlers.update_event(
                api_event(
                    EXAMINER,
                    path={"id": EVENT_ID},
                    body={"name": EVENT_NAME, "exam_date": "2027-03-20", "status": "CLOSED"},
                ),
                None,
            ),
        ),
    )

    response = _mark()

    _assert_rejected(response, 400, "Evento encerrado")
