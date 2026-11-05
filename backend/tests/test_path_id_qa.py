"""Path ids beyond the #92 regression: every id answers like an id that does not exist.

The README ("Id inválido no caminho") promises that an empty id, or one above
1024 UTF-8 bytes, answers exactly what a missing id answers, in the same order
(401 without token, 403 for the guardian on examiner routes, 404 with the
resource's message), never reaching DynamoDB. These tests compare both answers
route by route, for every user and for valid, missing, malformed and non-object
bodies; they also cover ids at exactly 1024 bytes (accepted, reaching
DynamoDB), ids with spaces and control characters, and the logs.

One exam scenario serves every request: no request here writes anything,
because every id is invalid or missing.
"""

import json
import logging
from collections.abc import Callable
from typing import Any

import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    GUARDIAN,
    OTHER_GUARDIAN,
    SCENARIO_EVENT_ID,
    SCENARIO_REQUIREMENT,
    SCENARIO_SENSEI,
    SCENARIO_STUDENT_ID,
    api_event,
    belt,
    response_json,
    scenario_requirement_body,
)

from domain.belts import seed_belt_id
from domain.events import MSG_EVENT_NOT_FOUND
from domain.exams import MSG_EXAM_NOT_FOUND
from domain.requirements import MSG_REQUIREMENT_NOT_FOUND
from domain.students import MSG_STUDENT_NOT_FOUND
from domain.users import User
from handlers import belts as belt_handlers
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import requirements as requirement_handlers
from handlers import students as student_handlers

MSG_BELT_NOT_FOUND = "Faixa não encontrada"
MISSING_ID = "nao-existe"
MAX_KEY_BYTES = 1024

Handler = Callable[[dict[str, Any], Any], dict[str, Any]]

STUDENT_BODY = {
    "full_name": "Ana",
    "birth_date": "2018-05-10",
    "current_belt_id": seed_belt_id("Cinza"),
    "current_belt_since": "2026-03-14",
    "stripes": 0,
}
EVENT_BODY = {"name": "Exame março/2027", "exam_date": "2027-03-20", "status": "OPEN"}
EXAM_PATH = {
    "id": SCENARIO_EVENT_ID,
    "student_id": SCENARIO_STUDENT_ID,
    "requirement_id": SCENARIO_REQUIREMENT.id,
}


def _routes() -> list[tuple[str, Handler, dict[str, str], dict[str, str], Any]]:
    """(route, handler, valid path, message per path parameter, valid body)."""
    student = {"id": SCENARIO_STUDENT_ID}
    event = {"id": SCENARIO_EVENT_ID}
    requirement = {"id": SCENARIO_REQUIREMENT.id}
    exam = {key: EXAM_PATH[key] for key in ("id", "student_id")}
    exam_messages = {"id": MSG_EVENT_NOT_FOUND, "student_id": MSG_EXAM_NOT_FOUND}
    answer_messages = {**exam_messages, "requirement_id": MSG_REQUIREMENT_NOT_FOUND}
    on_student = {"id": MSG_STUDENT_NOT_FOUND}
    on_event = {"id": MSG_EVENT_NOT_FOUND}
    on_requirement = {"id": MSG_REQUIREMENT_NOT_FOUND}
    return [
        ("GET /students/{id}", student_handlers.get_student, student, on_student, None),
        ("PUT /students/{id}", student_handlers.update_student, student, on_student, STUDENT_BODY),
        ("DELETE /students/{id}", student_handlers.delete_student, student, on_student, None),
        (
            "GET /students/{id}/exams",
            student_handlers.list_student_exams,
            student,
            on_student,
            None,
        ),
        ("GET /events/{id}", event_handlers.get_event, event, on_event, None),
        ("PUT /events/{id}", event_handlers.update_event, event, on_event, EVENT_BODY),
        ("DELETE /events/{id}", event_handlers.delete_event, event, on_event, None),
        (
            "POST /events/{id}/exams",
            exam_handlers.confirm_attendance,
            event,
            on_event,
            {"student_id": "student-2"},
        ),
        ("GET /events/{id}/exams", exam_handlers.list_event_exams, event, on_event, None),
        (
            "PUT /requirements/{id}",
            requirement_handlers.update_requirement,
            requirement,
            on_requirement,
            scenario_requirement_body(description="Item editado"),
        ),
        (
            "DELETE /requirements/{id}",
            requirement_handlers.delete_requirement,
            requirement,
            on_requirement,
            None,
        ),
        (
            "PUT /belts/{id}",
            belt_handlers.update_belt,
            {"id": belt("Cinza").id},
            {"id": MSG_BELT_NOT_FOUND},
            belt("Cinza").to_dict(),
        ),
        (
            "GET /events/{id}/exams/{student_id}",
            exam_handlers.get_exam_sheet,
            exam,
            exam_messages,
            None,
        ),
        (
            "PUT .../answers/{requirement_id}",
            exam_handlers.mark_answer,
            EXAM_PATH,
            answer_messages,
            {"correct": True},
        ),
        (
            "DELETE .../answers/{requirement_id}",
            exam_handlers.unmark_answer,
            EXAM_PATH,
            answer_messages,
            None,
        ),
        (
            "POST .../decision",
            exam_handlers.decide_exam,
            exam,
            exam_messages,
            {"result": "APPROVED"},
        ),
    ]


USERS: dict[str, User | None] = {
    "sem token": None,
    "responsável dono": GUARDIAN,
    "outro responsável": OTHER_GUARDIAN,
    "examinador": EXAMINER,
    "sensei": SCENARIO_SENSEI,
}
BODIES = ("válido", "ausente", "malformado", "lista")

INVALID_IDS = {
    "vazio": "",
    "1025 bytes": "a" * 1025,
    "1026 bytes acentuados": "é" * 513,
    "1028 bytes emoji": "\U0001f94b" * 257,
    "2049 bytes": "a" * 2049,
    "surrogate": "\ud800",
    "surrogate no meio": "ab\udc00cd",
}
LIMIT_IDS = {
    "1 byte": "x",
    "1024 bytes": "a" * 1024,
    "1024 bytes acentuados": "é" * 512,
    "1024 bytes emoji": "\U0001f94b" * 256,
}
ODD_IDS = {
    "espaço": " ",
    "tab": "\t",
    "quebra de linha": "\n",
    "nulo": "\x00",
    "controle": "\x01\x1f\x7f",
    "espaço no meio": "a b",
    "espaço no fim": "{valid} ",
    "espaço no início": " {valid}",
    "maiúsculas": "{VALID}",
    "barra": "{valid}/",
    "ponto ponto barra": "../{valid}",
    "percent-encoded": "%2F",
    "nulo no fim": "{valid}\x00",
}


def _contains(value: Any, bad_id: str) -> bool:
    if isinstance(value, str):
        return value == bad_id
    if isinstance(value, dict):
        return any(_contains(item, bad_id) for item in value.values())
    if isinstance(value, list | tuple | set | frozenset):
        return any(_contains(item, bad_id) for item in value)
    expression = getattr(value, "get_expression", None)
    if callable(expression):
        return _contains(expression().get("values"), bad_id)
    return False


def _too_long(value: Any) -> bool:
    """Tell whether any string inside ``value`` is empty or above 1024 UTF-8 bytes."""
    if isinstance(value, str):
        try:
            size = len(value.encode("utf-8"))
        except UnicodeEncodeError:
            return True
        return size == 0 or size > MAX_KEY_BYTES
    if isinstance(value, dict):
        return any(_too_long(item) for item in value.values())
    if isinstance(value, list | tuple | set | frozenset):
        return any(_too_long(item) for item in value)
    expression = getattr(value, "get_expression", None)
    if callable(expression):
        return _too_long(expression().get("values"))
    return False


_KEY_PARAMS = ("Key", "Keys", "KeyConditionExpression", "RequestItems", "TransactItems")


class Watch:
    """Record DynamoDB calls carrying ``bad`` (refused as DynamoDB would)."""

    def __init__(self) -> None:
        self.bad: str | None = None
        self.strict_sizes = False
        self.calls: list[str] = []
        self.size_refusals: list[str] = []


@pytest.fixture
def watch(monkeypatch: pytest.MonkeyPatch) -> Watch:
    state = Watch()
    original = BaseClient._make_api_call

    def refuse(operation_name: str) -> ClientError:
        error = {"Code": "ValidationException", "Message": "One or more parameter values"}
        return ClientError({"Error": error}, operation_name)

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if self.meta.service_model.service_name == "dynamodb":
            if state.bad is not None and _contains(api_params, state.bad):
                state.calls.append(operation_name)
                if not state.strict_sizes:
                    raise refuse(operation_name)
            if state.strict_sizes and any(
                _too_long(api_params.get(name)) for name in _KEY_PARAMS if name in api_params
            ):
                state.size_refusals.append(operation_name)
                raise refuse(operation_name)
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return state


def _request(handler: Handler, user: User | None, path: dict[str, str], body: str, valid: Any):
    event = api_event(user, path=path, body=valid if body == "válido" else None)
    if body == "malformado":
        event["body"] = "{"
    elif body == "lista":
        event["body"] = "[]"
    return handler(event, None)


def _answer(response: dict[str, Any]) -> tuple[int, Any]:
    return response["statusCode"], response_json(response) if response.get("body") else None


@pytest.mark.usefixtures("exam_scenario")
def test_invalid_path_id_answers_like_a_missing_id(watch: Watch) -> None:
    problems: list[str] = []
    for route, handler, valid_path, messages, valid_body in _routes():
        for name in messages:
            for user_label, user in USERS.items():
                for body in BODIES:
                    reference = _answer(
                        _request(handler, user, {**valid_path, name: MISSING_ID}, body, valid_body)
                    )
                    for id_label, bad_id in INVALID_IDS.items():
                        watch.bad, watch.calls = bad_id, []
                        got = _answer(
                            _request(handler, user, {**valid_path, name: bad_id}, body, valid_body)
                        )
                        watch.bad = None
                        where = f"{route} [{name}={id_label}] {user_label}, corpo {body}"
                        if watch.calls:
                            problems.append(f"{where}: chegou ao DynamoDB em {watch.calls}")
                        if got != reference:
                            problems.append(f"{where}: {got} em vez de {reference}")
    assert not problems, "\n".join(problems)


@pytest.mark.usefixtures("exam_scenario")
def test_path_id_at_the_limit_is_read_and_answers_like_a_missing_id(watch: Watch) -> None:
    """1024 bytes is a valid key everywhere; nothing may grow it past the DynamoDB limit."""
    watch.strict_sizes = True
    problems: list[str] = []
    for route, handler, valid_path, messages, valid_body in _routes():
        for name, message in messages.items():
            for user_label, user in USERS.items():
                reference = _answer(
                    _request(handler, user, {**valid_path, name: MISSING_ID}, "válido", valid_body)
                )
                for id_label, value in LIMIT_IDS.items():
                    watch.bad, watch.calls, watch.size_refusals = value, [], []
                    got = _answer(
                        _request(handler, user, {**valid_path, name: value}, "válido", valid_body)
                    )
                    watch.bad = None
                    where = f"{route} [{name}={id_label}] {user_label}"
                    if watch.size_refusals:
                        problems.append(f"{where}: chave inválida em {watch.size_refusals}")
                    if got != reference:
                        problems.append(f"{where}: {got} em vez de {reference}")
                    reads_by_key = route != "PUT /belts/{id}" and user in (
                        EXAMINER,
                        SCENARIO_SENSEI,
                    )
                    if reads_by_key and got == (404, {"message": message}) and not watch.calls:
                        problems.append(f"{where}: o id válido nem foi lido no DynamoDB")
    assert not problems, "\n".join(problems)


@pytest.mark.usefixtures("exam_scenario")
def test_path_id_with_spaces_or_control_chars_answers_like_a_missing_id(watch: Watch) -> None:
    problems: list[str] = []
    for route, handler, valid_path, messages, valid_body in _routes():
        for name in messages:
            valid = valid_path[name]
            for user_label, user in USERS.items():
                reference = _answer(
                    _request(handler, user, {**valid_path, name: MISSING_ID}, "válido", valid_body)
                )
                for id_label, template in ODD_IDS.items():
                    value = template.replace("{valid}", valid).replace("{VALID}", valid.upper())
                    got = _answer(
                        _request(handler, user, {**valid_path, name: value}, "válido", valid_body)
                    )
                    if got != reference:
                        where = f"{route} [{name}={id_label!r}] {user_label}"
                        problems.append(f"{where}: {got} em vez de {reference}")
    assert not problems, "\n".join(problems)


@pytest.mark.usefixtures("exam_scenario")
def test_invalid_path_id_logs_no_error_and_not_the_id(
    watch: Watch, caplog: pytest.LogCaptureFixture
) -> None:
    long_id = "z" * 1025
    caplog.set_level(logging.DEBUG)
    for _, handler, valid_path, messages, valid_body in _routes():
        for name in messages:
            for user in (EXAMINER, SCENARIO_SENSEI, GUARDIAN):
                _request(handler, user, {**valid_path, name: long_id}, "válido", valid_body)
    assert not [record for record in caplog.records if record.levelno >= logging.WARNING]
    assert not [record for record in caplog.records if long_id in record.getMessage()]
    rejected = [
        r.getMessage() for r in caplog.records if "Request rejected (404)" in r.getMessage()
    ]
    assert rejected
    assert json.dumps(rejected, ensure_ascii=False).count("não encontrad") == len(rejected)
