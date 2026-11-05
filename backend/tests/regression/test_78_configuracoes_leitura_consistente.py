"""As configurações lidas por chave podiam estar defasadas logo depois de gravadas (RN008).

Observado: ``repository.settings.get_settings`` lia o registro ``academy`` da
tabela ``Settings`` sem ``ConsistentRead``. A leitura eventualmente consistente
pode, por cerca de 1 s depois de uma gravação, devolver a versão anterior do
item. Ela decide quem é o sensei na decisão (``ensure_is_sensei`` em
``handlers/exams.py``): quem o master acabou de escolher como sensei recebia 403
"Somente o sensei pode decidir o exame" (RN008). E o ``GET /settings`` logo
depois do ``PUT`` devolvia os campos antigos, que o formulário mostrava como
salvos. ``get_sensei_user_id`` já era consistente.

Esperado: a leitura por chave das configurações usa ``ConsistentRead=True``. O
moto é sempre consistente; ``lag_eventual_reads`` (``conftest.py``) faz a
tabela responder como uma réplica uma gravação atrás às leituras sem
``ConsistentRead`` e registra os parâmetros de cada ``GetItem``.

Issue: #78
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, api_event, belt_id, lag_eventual_reads, make_student, response_json

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import settings as settings_handlers
from repository import events as event_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import SETTINGS_TABLE_ENV

EVENT_ID = "event-1"
EVENT_DATE = date(2027, 3, 20)
NOW = "2026-11-01T12:00:00+00:00"
STUDENT_ID = "student-1"
FORMER_SENSEI_SUB = "sensei-antigo"
NEW_SENSEI = User(sub="sensei-novo", email="novo@example.com", groups=frozenset({ADMIN_GROUP}))


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))
    monkeypatch.setattr(dates, "utc_now_iso", lambda: "2027-03-20T13:45:00+00:00")


def _settings(sensei_user_id: str | None, academy_name: str) -> AcademySettings:
    return AcademySettings(
        academy_name=academy_name,
        sensei_user_id=sensei_user_id,
        certificate_city="Araraquara",
        updated_at=NOW,
    )


def _not_consistent(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [call for call in calls if call.get("ConsistentRead") is not True]


def test_get_settings_reads_settings_table_consistently(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = lag_eventual_reads(monkeypatch, SETTINGS_TABLE_ENV)
    settings_repo.save_settings(_settings(None, "Associação Tomiyama de Judô"))

    found = settings_repo.get_settings()

    assert found is not None and found.academy_name == "Associação Tomiyama de Judô", (
        "get_settings logo depois de salvar deveria trazer o registro salvo"
    )
    assert not _not_consistent(calls), (
        f"get_settings deve usar ConsistentRead=True; leituras sem ele: {_not_consistent(calls)}"
    )


def test_get_settings_right_after_put_shows_saved_fields(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings_repo.save_settings(_settings(None, "Academia Tomiyama"))
    lag_eventual_reads(monkeypatch, SETTINGS_TABLE_ENV)
    saved = settings_handlers.update_settings(
        api_event(
            EXAMINER,
            body={
                "academy_name": "Associação Tomiyama de Judô",
                "sensei_user_id": None,
                "certificate_city": "São Carlos",
            },
        ),
        None,
    )
    assert saved["statusCode"] == 200, saved["body"]

    response = settings_handlers.get_settings(api_event(EXAMINER), None)

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert (body["academy_name"], body["certificate_city"]) == (
        "Associação Tomiyama de Judô",
        "São Carlos",
    )


def test_rn008_decision_right_after_becoming_sensei_is_accepted(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    event_repo.create_event(
        ExamEvent(EVENT_ID, "Exame março/2027", EVENT_DATE, EventStatus.OPEN, NOW, NOW)
    )
    settings_repo.save_settings(_settings(FORMER_SENSEI_SUB, "Associação Tomiyama de Judô"))
    student_repo.create_student(replace(make_student(), id=STUDENT_ID, full_name="Ana"))
    confirmed = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": EVENT_ID}, body={"student_id": STUDENT_ID}), None
    )
    assert confirmed["statusCode"] == 201, confirmed["body"]
    lag_eventual_reads(monkeypatch, SETTINGS_TABLE_ENV)
    # A gravação que o PUT /settings do master faz ao trocar o sensei.
    settings_repo.save_settings(_settings(NEW_SENSEI.sub, "Associação Tomiyama de Judô"))

    response = exam_handlers.decide_exam(
        api_event(
            NEW_SENSEI,
            path={"id": EVENT_ID, "student_id": STUDENT_ID},
            body={"result": "APPROVED"},
        ),
        None,
    )

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert (body["exam"]["status"], body["exam"]["decided_by_id"]) == ("APPROVED", NEW_SENSEI.sub)
    assert body["student"]["current_belt_id"] == belt_id("Cinza/Azul")
