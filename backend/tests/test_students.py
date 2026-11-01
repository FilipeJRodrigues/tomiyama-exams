"""Students: ownership and graduation lock (RN013), dates (RN014), deletion (RN018)."""

from datetime import date
from typing import Any

import boto3
import pytest
from conftest import (
    EXAMINER,
    GUARDIAN,
    GUARDIAN_SUB,
    OTHER_GUARDIAN,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain.belts import SEED_BELTS
from domain.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from domain.students import create_student, ensure_can_access, ensure_can_delete, update_student
from handlers import students as handlers

BELTS_BY_ID = {b.id: b for b in SEED_BELTS}
TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"


def _payload(**overrides: Any) -> dict[str, Any]:
    data = {
        "full_name": "Ana Souza",
        "birth_date": "2018-05-10",
        "current_belt_id": belt_id("Cinza"),
        "current_belt_since": "2026-03-14",
        "stripes": 0,
        "federation_id": None,
        "active": True,
    }
    data.update(overrides)
    return data


def _add_exam(student_id: str) -> None:
    boto3.resource("dynamodb").Table("test-exams").put_item(
        Item={"event_id": "event-1", "student_id": student_id, "status": "IN_PROGRESS"}
    )


# --- domain ---------------------------------------------------------------


def test_owner_comes_from_token_not_body() -> None:
    student = create_student(_payload(owner_id="intruder"), GUARDIAN, BELTS_BY_ID, TODAY, NOW)
    assert student.owner_id == GUARDIAN_SUB


def test_create_requires_existing_belt() -> None:
    with pytest.raises(ValidationError, match="Faixa atual"):
        create_student(_payload(current_belt_id="nope"), GUARDIAN, BELTS_BY_ID, TODAY, NOW)


@pytest.mark.parametrize("stripes", [-1, 5, "1", True])
def test_stripes_between_0_and_4(stripes: Any) -> None:
    with pytest.raises(ValidationError):
        create_student(_payload(stripes=stripes), GUARDIAN, BELTS_BY_ID, TODAY, NOW)


@pytest.mark.parametrize(
    "overrides",
    [
        {"birth_date": "2026-11-02"},
        {"current_belt_since": "2026-11-02"},
        {"current_belt_since": "2018-05-09"},
    ],
)
def test_rn014_invalid_dates(overrides: dict[str, Any]) -> None:
    with pytest.raises(
        ValidationError, match="Datas inválidas: verifique nascimento e data da faixa atual"
    ):
        create_student(_payload(**overrides), GUARDIAN, BELTS_BY_ID, TODAY, NOW)


def test_rn014_today_is_allowed() -> None:
    student = create_student(
        _payload(current_belt_since="2026-11-01"), GUARDIAN, BELTS_BY_ID, TODAY, NOW
    )
    assert student.current_belt_since == TODAY


def test_rn013_guardian_sees_only_own_students() -> None:
    student = make_student(owner_id=GUARDIAN_SUB)
    assert ensure_can_access(student, GUARDIAN) is student
    assert ensure_can_access(student, EXAMINER) is student
    with pytest.raises(NotFoundError):
        ensure_can_access(student, OTHER_GUARDIAN)


def test_rn013_guardian_cannot_change_graduation_after_first_exam() -> None:
    student = make_student()
    payload = _payload(current_belt_id=belt_id("Cinza/Azul"))
    with pytest.raises(ForbiddenError, match="Somente examinadores alteram a graduação"):
        update_student(student, payload, GUARDIAN, BELTS_BY_ID, True, TODAY, NOW)


@pytest.mark.parametrize(
    "overrides",
    [{"current_belt_since": "2026-03-15"}, {"stripes": 1}],
)
def test_rn013_lock_covers_belt_date_and_stripes(overrides: dict[str, Any]) -> None:
    with pytest.raises(ForbiddenError):
        update_student(
            make_student(), _payload(**overrides), GUARDIAN, BELTS_BY_ID, True, TODAY, NOW
        )


def test_rn013_resending_same_graduation_does_not_block() -> None:
    updated = update_student(
        make_student(),
        _payload(full_name="Ana S.", federation_id="SP-123"),
        GUARDIAN,
        BELTS_BY_ID,
        True,
        TODAY,
        NOW,
    )
    assert updated.full_name == "Ana S."
    assert updated.federation_id == "SP-123"


def test_rn013_examiner_changes_graduation_after_exam() -> None:
    payload = _payload(current_belt_id=belt_id("Cinza/Azul"))
    updated = update_student(make_student(), payload, EXAMINER, BELTS_BY_ID, True, TODAY, NOW)
    assert updated.current_belt_id == belt_id("Cinza/Azul")
    assert updated.owner_id == GUARDIAN_SUB


def test_rn013_guardian_changes_graduation_before_first_exam() -> None:
    payload = _payload(current_belt_id=belt_id("Cinza/Azul"))
    updated = update_student(make_student(), payload, GUARDIAN, BELTS_BY_ID, False, TODAY, NOW)
    assert updated.current_belt_id == belt_id("Cinza/Azul")


def test_rn018_student_with_exams_cannot_be_deleted() -> None:
    with pytest.raises(ConflictError, match="Aluno possui exames registrados"):
        ensure_can_delete(True)
    ensure_can_delete(False)


# --- routes ---------------------------------------------------------------


def _create(user: Any, **overrides: Any) -> dict[str, Any]:
    response = handlers.create_student(api_event(user, body=_payload(**overrides)), None)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)


def test_create_and_get_student(seeded: list) -> None:
    created = _create(GUARDIAN, owner_id="intruder")
    assert created["owner_id"] == GUARDIAN_SUB
    assert created["current_belt_name"] == "Cinza"

    response = handlers.get_student(
        api_event(GUARDIAN, path={"id": created["id"]}, query={"reference_date": "2027-03-13"}),
        None,
    )
    body = response_json(response)
    assert body["age"] == 8
    assert body["eligibility"] == {
        "eligible": True,
        "kind": "BELT",
        "target_belt_id": belt_id("Cinza/Azul"),
        "target_belt_name": "Cinza/Azul",
        "reasons": [],
    }


def test_rn013_other_guardian_gets_404(seeded: list) -> None:
    created = _create(GUARDIAN)
    for call in (handlers.get_student, handlers.update_student, handlers.delete_student):
        event = api_event(OTHER_GUARDIAN, path={"id": created["id"]}, body=_payload())
        assert call(event, None)["statusCode"] == 404


def test_rn013_list_scoped_by_role(seeded: list) -> None:
    _create(GUARDIAN, full_name="Bruno")
    _create(GUARDIAN, full_name="ana")
    _create(OTHER_GUARDIAN, full_name="Carla")

    own = response_json(handlers.list_students(api_event(GUARDIAN), None))
    assert [s["full_name"] for s in own] == ["ana", "Bruno"]

    every = response_json(handlers.list_students(api_event(EXAMINER), None))
    assert [s["full_name"] for s in every] == ["ana", "Bruno", "Carla"]


def test_list_filters_active(seeded: list) -> None:
    _create(GUARDIAN, full_name="Ativa")
    _create(GUARDIAN, full_name="Inativa", active=False)
    body = response_json(
        handlers.list_students(api_event(GUARDIAN, query={"active": "false"}), None)
    )
    assert [s["full_name"] for s in body] == ["Inativa"]


def test_rn013_lock_through_route(seeded: list) -> None:
    created = _create(GUARDIAN)
    _add_exam(created["id"])
    event = api_event(GUARDIAN, path={"id": created["id"]}, body=_payload(stripes=1))
    response = handlers.update_student(event, None)
    assert response["statusCode"] == 403

    event = api_event(GUARDIAN, path={"id": created["id"]}, body=_payload(full_name="Ana Maria"))
    assert response_json(handlers.update_student(event, None))["full_name"] == "Ana Maria"


def test_rn018_delete_through_route(seeded: list) -> None:
    with_exam = _create(GUARDIAN)
    _add_exam(with_exam["id"])
    response = handlers.delete_student(api_event(GUARDIAN, path={"id": with_exam["id"]}), None)
    assert response["statusCode"] == 409
    assert response_json(response)["message"] == "Aluno possui exames registrados"

    without_exam = _create(GUARDIAN)
    response = handlers.delete_student(api_event(GUARDIAN, path={"id": without_exam["id"]}), None)
    assert response["statusCode"] == 204
    get = handlers.get_student(api_event(GUARDIAN, path={"id": without_exam["id"]}), None)
    assert get["statusCode"] == 404


def test_invalid_json_returns_400(seeded: list) -> None:
    event = api_event(GUARDIAN)
    event["body"] = "{not json"
    assert handlers.create_student(event, None)["statusCode"] == 400
