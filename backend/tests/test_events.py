"""Exam events: RN016 (examiner-only management, delete blocked by exams)."""

import os
from typing import Any

import boto3
import pytest
from conftest import EXAMINER, GUARDIAN, api_event, response_json

from domain.events import EventStatus
from handlers import events as handlers
from repository import events as event_repo


def _payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": "Exame março/2027", "exam_date": "2027-03-20"}
    payload.update(overrides)
    return payload


def _create(**overrides: Any) -> dict[str, Any]:
    response = handlers.create_event(api_event(EXAMINER, body=_payload(**overrides)), None)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)


def _insert_exam(event_id: str) -> None:
    boto3.resource("dynamodb").Table(os.environ["EXAMS_TABLE"]).put_item(
        Item={"event_id": event_id, "student_id": "student-1"}
    )


# --- CRUD ---------------------------------------------------------------------


def test_rn016_create_defaults_to_open(aws: None) -> None:
    created = _create()
    assert created["name"] == "Exame março/2027"
    assert created["exam_date"] == "2027-03-20"
    assert created["status"] == "OPEN"
    assert created["id"]
    assert created["created_at"]
    stored = event_repo.get_event(created["id"])
    assert stored is not None
    assert stored.status == EventStatus.OPEN


def test_rn016_create_with_explicit_status(aws: None) -> None:
    assert _create(status="CLOSED")["status"] == "CLOSED"


def test_rn016_get_event(aws: None) -> None:
    created = _create()
    response = handlers.get_event(api_event(EXAMINER, path={"id": created["id"]}), None)
    assert response["statusCode"] == 200
    assert response_json(response) == created


def test_rn016_update_name_and_close(aws: None) -> None:
    created = _create()
    event = api_event(
        EXAMINER,
        path={"id": created["id"]},
        body=_payload(name="Exame abril/2027", status="CLOSED"),
    )
    response = handlers.update_event(event, None)
    assert response["statusCode"] == 200
    body = response_json(response)
    assert body["name"] == "Exame abril/2027"
    assert body["status"] == "CLOSED"
    assert body["created_at"] == created["created_at"]
    assert event_repo.get_event(created["id"]).status == EventStatus.CLOSED


def test_rn016_reopen_closed_event(aws: None) -> None:
    created = _create(status="CLOSED")
    event = api_event(EXAMINER, path={"id": created["id"]}, body=_payload(status="OPEN"))
    response = handlers.update_event(event, None)
    assert response["statusCode"] == 200
    assert response_json(response)["status"] == "OPEN"
    assert event_repo.get_event(created["id"]).is_open


def test_rn016_update_without_status_keeps_current(aws: None) -> None:
    created = _create(status="CLOSED")
    event = api_event(EXAMINER, path={"id": created["id"]}, body={"name": "Outro nome"})
    response = handlers.update_event(event, None)
    assert response["statusCode"] == 200
    assert response_json(response)["status"] == "CLOSED"


def test_rn016_exam_date_resent_unchanged_is_allowed(aws: None) -> None:
    created = _create()
    event = api_event(
        EXAMINER, path={"id": created["id"]}, body=_payload(name="Novo", exam_date="2027-03-20")
    )
    response = handlers.update_event(event, None)
    assert response["statusCode"] == 200
    assert response_json(response)["exam_date"] == "2027-03-20"


def test_rn016_exam_date_cannot_change(aws: None) -> None:
    created = _create()
    event = api_event(EXAMINER, path={"id": created["id"]}, body=_payload(exam_date="2027-04-10"))
    response = handlers.update_event(event, None)
    assert response["statusCode"] == 400
    assert response_json(response)["message"] == "A data do evento não pode ser alterada"
    assert event_repo.get_event(created["id"]).exam_date.isoformat() == "2027-03-20"


def test_rn016_list_most_recent_first(aws: None) -> None:
    older = _create(name="Exame 2026", exam_date="2026-11-20")
    newest = _create(name="Exame 2027", exam_date="2027-06-12")
    middle = _create(name="Exame março", exam_date="2027-03-20")
    response = handlers.list_events(api_event(EXAMINER), None)
    assert response["statusCode"] == 200
    ids = [item["id"] for item in response_json(response)]
    assert ids == [newest["id"], middle["id"], older["id"]]


def test_rn016_list_empty(aws: None) -> None:
    response = handlers.list_events(api_event(EXAMINER), None)
    assert response["statusCode"] == 200
    assert response_json(response) == []


def test_rn016_delete_without_exams(aws: None) -> None:
    created = _create()
    response = handlers.delete_event(api_event(EXAMINER, path={"id": created["id"]}), None)
    assert response["statusCode"] == 204
    assert event_repo.get_event(created["id"]) is None


def test_rn016_delete_blocked_when_event_has_exams(aws: None) -> None:
    created = _create()
    _insert_exam(created["id"])
    response = handlers.delete_event(api_event(EXAMINER, path={"id": created["id"]}), None)
    assert response["statusCode"] == 409
    assert response_json(response)["message"] == "Evento possui exames registrados"
    assert event_repo.get_event(created["id"]) is not None


def test_rn016_exams_of_other_event_do_not_block_delete(aws: None) -> None:
    created = _create()
    _insert_exam("other-event")
    response = handlers.delete_event(api_event(EXAMINER, path={"id": created["id"]}), None)
    assert response["statusCode"] == 204


# --- authorization and not found ------------------------------------------------

ALL_ROUTES = [
    handlers.list_events,
    handlers.create_event,
    handlers.get_event,
    handlers.update_event,
    handlers.delete_event,
]
ID_ROUTES = [handlers.get_event, handlers.update_event, handlers.delete_event]


@pytest.mark.parametrize("call", ALL_ROUTES)
def test_rn016_only_examiners(aws: None, call: Any) -> None:
    created = _create()
    event = api_event(GUARDIAN, path={"id": created["id"]}, body=_payload(name="Invasor"))
    response = call(event, None)
    assert response["statusCode"] == 403
    assert response_json(response)["message"] == "Esta área é dos examinadores"
    assert event_repo.get_event(created["id"]).name == created["name"]
    assert len(event_repo.list_all()) == 1


@pytest.mark.parametrize("call", ALL_ROUTES)
def test_rn016_requires_login(aws: None, call: Any) -> None:
    response = call(api_event(None, path={"id": "x"}, body=_payload()), None)
    assert response["statusCode"] == 401


@pytest.mark.parametrize("call", ID_ROUTES)
def test_rn016_unknown_event_returns_404(aws: None, call: Any) -> None:
    response = call(api_event(EXAMINER, path={"id": "missing"}, body=_payload()), None)
    assert response["statusCode"] == 404
    assert response_json(response)["message"] == "Evento não encontrado"


# --- validation -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"name": ""}, "Campo obrigatório: Nome"),
        ({"name": "   "}, "Campo obrigatório: Nome"),
        ({"name": None}, "Campo obrigatório: Nome"),
        ({"name": "x" * 81}, "Nome: máximo de 80 caracteres"),
        ({"exam_date": None}, "Campo obrigatório: Data do exame"),
        ({"exam_date": "20/03/2027"}, "Data do exame: data inválida (use AAAA-MM-DD)"),
        ({"exam_date": "2027-02-30"}, "Data do exame: data inválida (use AAAA-MM-DD)"),
        ({"status": "DONE"}, "Situação: valor inválido"),
    ],
)
def test_rn016_create_rejects_invalid_fields(
    aws: None, overrides: dict[str, Any], message: str
) -> None:
    response = handlers.create_event(api_event(EXAMINER, body=_payload(**overrides)), None)
    assert response["statusCode"] == 400
    assert response_json(response)["message"] == message
    assert event_repo.list_all() == []


def test_rn016_name_with_80_chars_is_accepted(aws: None) -> None:
    assert len(_create(name="x" * 80)["name"]) == 80


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"name": ""}, "Campo obrigatório: Nome"),
        ({"name": "x" * 81}, "Nome: máximo de 80 caracteres"),
        ({"status": "ARCHIVED"}, "Situação: valor inválido"),
        ({"exam_date": "invalid"}, "Data do exame: data inválida (use AAAA-MM-DD)"),
    ],
)
def test_rn016_update_rejects_invalid_fields(
    aws: None, overrides: dict[str, Any], message: str
) -> None:
    created = _create()
    event = api_event(EXAMINER, path={"id": created["id"]}, body=_payload(**overrides))
    response = handlers.update_event(event, None)
    assert response["statusCode"] == 400
    assert response_json(response)["message"] == message
    assert event_repo.get_event(created["id"]).name == created["name"]


def test_rn016_invalid_json_body(aws: None) -> None:
    event = api_event(EXAMINER)
    event["body"] = "not json"
    assert handlers.create_event(event, None)["statusCode"] == 400
