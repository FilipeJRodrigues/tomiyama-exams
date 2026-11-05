"""Id vazio ou longo demais no caminho chegava ao DynamoDB e a resposta era 500.

Erro observado: ``handlers.http.path_param`` devolve o parâmetro de caminho
como veio, e as rotas com ``{id}`` (e ``{student_id}``/``{requirement_id}``
nas subrotas do exame) o usam direto como chave no DynamoDB. O DynamoDB
recusa com ``ValidationException`` uma chave vazia, uma chave de partição
acima de 2048 bytes e uma chave de ordenação acima de 1024 bytes (``student_id``
é a chave de ordenação da tabela ``Exams``). O ``ClientError`` sai cru e o
``api_handler`` responde 500 "Erro interno. Tente de novo.".

O HTTP API entrega id vazio quando ele é o último trecho do caminho
(``GET /students/``, ``PUT /requirements/``, ``GET /events/x/exams/``,
``PUT /events/x/exams/s/answers/``: a rota casa e o autorizador responde 401
sem token), e entrega id longo em qualquer trecho. Um ``//`` no meio do
caminho não chega como id vazio (o caminho não casa com a rota). Mesmo assim,
o handler não deve depender disso: os testes cobrem id vazio em todos os
parâmetros.

Esperado: 404 com a mensagem do recurso que já existe ("Aluno não
encontrado", "Evento não encontrado", "Exame não encontrado", "Requisito não
encontrado", "Faixa não encontrada"), sem que o id inválido chegue ao
DynamoDB, em todos os métodos. A ordem da permissão continua a de hoje para
id inexistente: nas rotas só de examinador, o responsável recebe 403 antes de
qualquer leitura; em ``/students/{id}``, o responsável recebe o 404 (RN013).

O moto recusa a chave vazia no ``GetItem``, mas não valida o tamanho. O teste
simula o DynamoDB de verdade: qualquer chamada que leve o id inválido é
registrada e recusada com ``ValidationException``.

Issue: #92
"""

from collections.abc import Callable, Iterator
from typing import Any

import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    GUARDIAN,
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
MSG_EXAMINERS_ONLY = "Esta área é dos examinadores"

# Ids DynamoDB refuses in any key position.
INVALID_IDS = {
    "vazio": "",
    "2049 bytes": "a" * 2049,
    # 1025 characters, 2050 bytes in UTF-8: the limit is in bytes.
    "2050 bytes acentuados": "é" * 1025,
}
# ``student_id`` is the sort key of ``Exams``: above 1024 bytes is refused too.
INVALID_SORT_KEY_IDS = {**INVALID_IDS, "1025 bytes": "s" * 1025}

STUDENT_BODY = {
    "full_name": "Ana",
    "birth_date": "2018-05-10",
    "current_belt_id": seed_belt_id("Cinza"),
    "current_belt_since": "2026-03-14",
    "stripes": 0,
}
EVENT_BODY = {"name": "Exame março/2027", "exam_date": "2027-03-20", "status": "OPEN"}

Handler = Callable[[dict[str, Any], Any], dict[str, Any]]


def _contains(value: Any, bad_id: str) -> bool:
    """Tell whether ``bad_id`` is one of the strings inside ``value``."""
    if isinstance(value, str):
        return value == bad_id
    if isinstance(value, dict):
        return any(_contains(item, bad_id) for item in value.values())
    if isinstance(value, list | tuple | set | frozenset):
        return any(_contains(item, bad_id) for item in value)
    expression = getattr(value, "get_expression", None)
    if callable(expression):  # boto3 Key()/Attr() conditions
        return _contains(expression().get("values"), bad_id)
    return False


@pytest.fixture
def strict_dynamodb(monkeypatch: pytest.MonkeyPatch) -> Callable[[str], list[dict[str, Any]]]:
    """Refuse, like DynamoDB, every call that carries the invalid id; return those calls."""

    def watch(bad_id: str) -> list[dict[str, Any]]:
        calls: list[dict[str, Any]] = []
        original = BaseClient._make_api_call

        def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
            if self.meta.service_model.service_name == "dynamodb" and _contains(api_params, bad_id):
                calls.append({"operation": operation_name, **api_params})
                raise ClientError(
                    {
                        "Error": {
                            "Code": "ValidationException",
                            "Message": "One or more parameter values were invalid",
                        }
                    },
                    operation_name,
                )
            return original(self, operation_name, api_params)

        monkeypatch.setattr(BaseClient, "_make_api_call", patched)
        return calls

    return watch


def _call(
    handler: Handler, user: User, path: dict[str, str], body: dict[str, Any] | None = None
) -> dict[str, Any]:
    return handler(api_event(user, path=path, body=body), None)


def _exam_path(**changes: str) -> dict[str, str]:
    return {"id": SCENARIO_EVENT_ID, "student_id": SCENARIO_STUDENT_ID, **changes}


def _answer_path(**changes: str) -> dict[str, str]:
    return {**_exam_path(), "requirement_id": SCENARIO_REQUIREMENT.id, **changes}


# (route, handler, user, body, message) for routes whose only path parameter is ``id``.
SINGLE_ID_ROUTES: list[tuple[str, Handler, User, dict[str, Any] | None, str]] = [
    ("GET /students/{id}", student_handlers.get_student, EXAMINER, None, MSG_STUDENT_NOT_FOUND),
    (
        "PUT /students/{id}",
        student_handlers.update_student,
        EXAMINER,
        STUDENT_BODY,
        MSG_STUDENT_NOT_FOUND,
    ),
    (
        "DELETE /students/{id}",
        student_handlers.delete_student,
        EXAMINER,
        None,
        MSG_STUDENT_NOT_FOUND,
    ),
    (
        "GET /students/{id}/exams",
        student_handlers.list_student_exams,
        EXAMINER,
        None,
        MSG_STUDENT_NOT_FOUND,
    ),
    ("GET /events/{id}", event_handlers.get_event, EXAMINER, None, MSG_EVENT_NOT_FOUND),
    ("PUT /events/{id}", event_handlers.update_event, EXAMINER, EVENT_BODY, MSG_EVENT_NOT_FOUND),
    ("DELETE /events/{id}", event_handlers.delete_event, EXAMINER, None, MSG_EVENT_NOT_FOUND),
    (
        "POST /events/{id}/exams",
        exam_handlers.confirm_attendance,
        EXAMINER,
        {"student_id": SCENARIO_STUDENT_ID},
        MSG_EVENT_NOT_FOUND,
    ),
    (
        "GET /events/{id}/exams",
        exam_handlers.list_event_exams,
        EXAMINER,
        None,
        MSG_EVENT_NOT_FOUND,
    ),
    (
        "PUT /requirements/{id}",
        requirement_handlers.update_requirement,
        EXAMINER,
        None,  # filled in the test (needs the seeded belts)
        MSG_REQUIREMENT_NOT_FOUND,
    ),
    (
        "DELETE /requirements/{id}",
        requirement_handlers.delete_requirement,
        EXAMINER,
        None,
        MSG_REQUIREMENT_NOT_FOUND,
    ),
    ("PUT /belts/{id}", belt_handlers.update_belt, EXAMINER, None, MSG_BELT_NOT_FOUND),
]

# (route, handler, user, body) of the exam subroutes.
EXAM_ROUTES: list[tuple[str, Handler, User, dict[str, Any] | None]] = [
    ("GET /events/{id}/exams/{student_id}", exam_handlers.get_exam_sheet, EXAMINER, None),
    ("PUT .../answers/{requirement_id}", exam_handlers.mark_answer, EXAMINER, {"correct": True}),
    ("DELETE .../answers/{requirement_id}", exam_handlers.unmark_answer, EXAMINER, None),
    ("POST .../decision", exam_handlers.decide_exam, SCENARIO_SENSEI, {"result": "APPROVED"}),
]
ANSWER_ROUTES = [route for route in EXAM_ROUTES if "answers" in route[0]]

# Examiner-only routes: the guardian gets 403 before any read (order kept).
EXAMINER_ONLY_ROUTES: list[tuple[str, Handler, Callable[[str], dict[str, str]]]] = [
    ("GET /students/{id}/exams", student_handlers.list_student_exams, lambda bad: {"id": bad}),
    ("GET /events/{id}", event_handlers.get_event, lambda bad: {"id": bad}),
    ("PUT /events/{id}", event_handlers.update_event, lambda bad: {"id": bad}),
    ("DELETE /events/{id}", event_handlers.delete_event, lambda bad: {"id": bad}),
    ("POST /events/{id}/exams", exam_handlers.confirm_attendance, lambda bad: {"id": bad}),
    ("GET /events/{id}/exams", exam_handlers.list_event_exams, lambda bad: {"id": bad}),
    ("PUT /requirements/{id}", requirement_handlers.update_requirement, lambda bad: {"id": bad}),
    (
        "DELETE /requirements/{id}",
        requirement_handlers.delete_requirement,
        lambda bad: {"id": bad},
    ),
    ("PUT /belts/{id}", belt_handlers.update_belt, lambda bad: {"id": bad}),
    (
        "GET /events/{id}/exams/{student_id}",
        exam_handlers.get_exam_sheet,
        lambda bad: _exam_path(student_id=bad),
    ),
    (
        "PUT .../answers/{requirement_id}",
        exam_handlers.mark_answer,
        lambda bad: _answer_path(requirement_id=bad),
    ),
    (
        "POST .../decision",
        exam_handlers.decide_exam,
        lambda bad: _exam_path(id=bad),
    ),
]


def _assert_not_found(response: dict[str, Any], message: str, calls: list[dict[str, Any]]) -> None:
    assert not calls, (
        f"o id inválido chegou ao DynamoDB em {[call['operation'] for call in calls]} "
        f"(resposta {response['statusCode']}: {response.get('body')})"
    )
    assert response["statusCode"] == 404, response.get("body")
    assert response_json(response) == {"message": message}


def _ids(mapping: dict[str, str]) -> Iterator[Any]:
    for label, value in mapping.items():
        yield pytest.param(value, id=label)


@pytest.mark.usefixtures("exam_scenario")
@pytest.mark.parametrize("bad_id", list(_ids(INVALID_IDS)))
@pytest.mark.parametrize(
    ("route", "handler", "user", "body", "message"),
    [pytest.param(*route, id=route[0]) for route in SINGLE_ID_ROUTES],
)
def test_invalid_id_answers_404_without_dynamodb(
    strict_dynamodb: Callable[[str], list[dict[str, Any]]],
    route: str,
    handler: Handler,
    user: User,
    body: dict[str, Any] | None,
    message: str,
    bad_id: str,
) -> None:
    if route == "PUT /requirements/{id}":
        body = scenario_requirement_body(description="Item editado")
    elif route == "PUT /belts/{id}":
        body = belt("Cinza").to_dict()
    calls = strict_dynamodb(bad_id)
    _assert_not_found(_call(handler, user, {"id": bad_id}, body), message, calls)


@pytest.mark.usefixtures("exam_scenario")
@pytest.mark.parametrize("bad_id", list(_ids(INVALID_IDS)))
@pytest.mark.parametrize(
    ("route", "handler", "user", "body"),
    [pytest.param(*route, id=route[0]) for route in EXAM_ROUTES],
)
def test_invalid_event_id_in_exam_routes_answers_404(
    strict_dynamodb: Callable[[str], list[dict[str, Any]]],
    route: str,
    handler: Handler,
    user: User,
    body: dict[str, Any] | None,
    bad_id: str,
) -> None:
    calls = strict_dynamodb(bad_id)
    path = _answer_path(id=bad_id) if "answers" in route else _exam_path(id=bad_id)
    _assert_not_found(_call(handler, user, path, body), MSG_EVENT_NOT_FOUND, calls)


@pytest.mark.usefixtures("exam_scenario")
@pytest.mark.parametrize("bad_id", list(_ids(INVALID_SORT_KEY_IDS)))
@pytest.mark.parametrize(
    ("route", "handler", "user", "body"),
    [pytest.param(*route, id=route[0]) for route in EXAM_ROUTES],
)
def test_invalid_student_id_in_exam_routes_answers_404(
    strict_dynamodb: Callable[[str], list[dict[str, Any]]],
    route: str,
    handler: Handler,
    user: User,
    body: dict[str, Any] | None,
    bad_id: str,
) -> None:
    calls = strict_dynamodb(bad_id)
    path = _answer_path(student_id=bad_id) if "answers" in route else _exam_path(student_id=bad_id)
    _assert_not_found(_call(handler, user, path, body), MSG_EXAM_NOT_FOUND, calls)


@pytest.mark.usefixtures("exam_scenario")
@pytest.mark.parametrize("bad_id", list(_ids(INVALID_IDS)))
@pytest.mark.parametrize(
    ("route", "handler", "user", "body"),
    [pytest.param(*route, id=route[0]) for route in ANSWER_ROUTES],
)
def test_invalid_requirement_id_in_answer_routes_answers_404(
    strict_dynamodb: Callable[[str], list[dict[str, Any]]],
    route: str,
    handler: Handler,
    user: User,
    body: dict[str, Any] | None,
    bad_id: str,
) -> None:
    calls = strict_dynamodb(bad_id)
    path = _answer_path(requirement_id=bad_id)
    _assert_not_found(_call(handler, user, path, body), MSG_REQUIREMENT_NOT_FOUND, calls)


@pytest.mark.usefixtures("exam_scenario")
@pytest.mark.parametrize("bad_id", list(_ids(INVALID_IDS)))
@pytest.mark.parametrize(
    ("route", "handler", "body"),
    [
        pytest.param("GET", student_handlers.get_student, None, id="GET /students/{id}"),
        pytest.param("PUT", student_handlers.update_student, STUDENT_BODY, id="PUT /students/{id}"),
        pytest.param("DELETE", student_handlers.delete_student, None, id="DELETE /students/{id}"),
    ],
)
def test_rn013_guardian_gets_404_for_invalid_student_id(
    strict_dynamodb: Callable[[str], list[dict[str, Any]]],
    route: str,
    handler: Handler,
    body: dict[str, Any] | None,
    bad_id: str,
) -> None:
    calls = strict_dynamodb(bad_id)
    _assert_not_found(_call(handler, GUARDIAN, {"id": bad_id}, body), MSG_STUDENT_NOT_FOUND, calls)


@pytest.mark.usefixtures("exam_scenario")
@pytest.mark.parametrize("bad_id", list(_ids(INVALID_IDS)))
@pytest.mark.parametrize(
    ("route", "handler", "path_of"),
    [pytest.param(*route, id=route[0]) for route in EXAMINER_ONLY_ROUTES],
)
def test_guardian_still_gets_403_first_on_examiner_routes(
    strict_dynamodb: Callable[[str], list[dict[str, Any]]],
    route: str,
    handler: Handler,
    path_of: Callable[[str], dict[str, str]],
    bad_id: str,
) -> None:
    calls = strict_dynamodb(bad_id)
    response = _call(handler, GUARDIAN, path_of(bad_id), {"correct": True})
    assert not calls
    assert response["statusCode"] == 403, response.get("body")
    assert response_json(response) == {"message": MSG_EXAMINERS_ONLY}
