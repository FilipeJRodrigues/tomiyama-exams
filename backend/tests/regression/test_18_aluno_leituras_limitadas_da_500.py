"""PUT e DELETE de aluno com leitura limitada pelo DynamoDB respondiam 500, e não 503.

Erro observado: no ``PUT /students/{id}`` (``handlers.students.update_student``)
e no ``DELETE /students/{id}`` (``handlers.students.delete_student``), as
leituras ``repository.exams.student_has_exams`` (``Query`` no GSI
``by_student`` de ``Exams``) e ``repository.belts.list_belts`` (``Scan`` em
``Belts``, só no PUT) não tratam o limite de capacidade: um
``ProvisionedThroughputExceededException``, ``ThrottlingException`` ou
``RequestLimitExceeded`` que persiste depois das tentativas do botocore sai
como ``ClientError`` cru e vira 500 "Erro interno". O mesmo acontece no
``DeleteItem`` condicionado de ``repository.students.delete_student``: só o
``ConditionalCheckFailedException`` é traduzido.

Esperado (contrato do ``backend/README.md``: "limite de capacidade do DynamoDB
que persistiu ... vale também para GET e DELETE /students/{id}"): 503 "Sistema
ocupado no momento. Tente de novo em instantes.", como já fazem a leitura do
aluno, a do marcador e a gravação do PUT, e nada é gravado: o aluno continua
igual (PUT) ou continua existindo (DELETE).

O ``DELETE`` não lê as faixas, então a combinação DELETE + ``list_belts`` não
existe no código. O ``GET /students/{id}``, que o mesmo trecho do README cobre,
também lê ``list_belts`` sem tratamento e entra aqui.

Issue: #18
"""

from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, GUARDIAN, api_event, belt_id, make_student

from domain.errors import MSG_SERVICE_BUSY
from domain.students import Student
from domain.users import User
from handlers import students as student_handlers
from repository import belts as belt_repo
from repository import exams as exam_repo
from repository import students as student_repo
from repository.tables import BELTS_TABLE_ENV, EXAMS_TABLE_ENV, STUDENTS_TABLE_ENV, table

THROTTLING_CODES = [
    "ProvisionedThroughputExceededException",
    "ThrottlingException",
    "RequestLimitExceeded",
]
USERS = pytest.mark.parametrize("user", [EXAMINER, GUARDIAN], ids=["examiner", "guardian"])


class _ThrottledTable:
    """The real table, with ``operation`` always throttled with ``code``."""

    def __init__(self, real: Any, operation: str, code: str, calls: list[str]) -> None:
        self._real = real
        self._operation = operation
        self._code = code
        self._calls = calls

    def __getattr__(self, name: str) -> Any:
        if name != self._operation:
            return getattr(self._real, name)

        def throttled(**kwargs: Any) -> Any:
            self._calls.append(name)
            raise ClientError({"Error": {"Code": self._code, "Message": "x"}}, name)

        return throttled


def _throttle(
    monkeypatch: pytest.MonkeyPatch, module: Any, env: str, operation: str, code: str
) -> list[str]:
    """Throttle ``operation`` on the ``env`` table as seen by ``module``; return the calls."""
    calls: list[str] = []
    real_table = module.table
    monkeypatch.setattr(
        module,
        "table",
        lambda name: (
            _ThrottledTable(real_table(name), operation, code, calls)
            if name == env
            else real_table(name)
        ),
    )
    return calls


def _body(student: Student, **changes: Any) -> dict[str, Any]:
    body = {
        "full_name": student.full_name,
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "federation_id": student.federation_id,
        "active": student.active,
    }
    return {**body, **changes}


def _stored(student_id: str) -> dict[str, Any] | None:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id}).get("Item")


# ``(module, table env, operation)`` of each unprotected read of the PUT.
PUT_READS = {
    "student_has_exams": (exam_repo, EXAMS_TABLE_ENV, "query"),
    "list_belts": (belt_repo, BELTS_TABLE_ENV, "scan"),
}


@pytest.mark.parametrize("code", THROTTLING_CODES)
@pytest.mark.parametrize("read", sorted(PUT_READS))
@pytest.mark.parametrize("graduation_changed", [False, True], ids=["same", "new_belt"])
@USERS
def test_rn013_throttled_read_on_student_update_is_503(
    seeded: None,
    monkeypatch: pytest.MonkeyPatch,
    user: User,
    graduation_changed: bool,
    read: str,
    code: str,
) -> None:
    student = make_student()
    student_repo.create_student(student)
    before = _stored(student.id)

    module, env, operation = PUT_READS[read]
    calls = _throttle(monkeypatch, module, env, operation, code)

    changes: dict[str, Any] = {"full_name": "Ana Maria"}
    if graduation_changed:
        changes["current_belt_id"] = belt_id("Azul")
    response = student_handlers.update_student(
        api_event(user, path={"id": student.id}, body=_body(student, **changes)), None
    )

    assert calls, f"{read} was not called"
    assert response["statusCode"] == 503, response["body"]
    assert MSG_SERVICE_BUSY in response["body"]
    assert _stored(student.id) == before


@pytest.mark.parametrize("code", THROTTLING_CODES)
@USERS
def test_rn018_throttled_exams_query_on_student_delete_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, user: User, code: str
) -> None:
    student = make_student()
    student_repo.create_student(student)
    before = _stored(student.id)

    calls = _throttle(monkeypatch, exam_repo, EXAMS_TABLE_ENV, "query", code)

    response = student_handlers.delete_student(api_event(user, path={"id": student.id}), None)

    assert calls, "student_has_exams was not called"
    assert response["statusCode"] == 503, response["body"]
    assert MSG_SERVICE_BUSY in response["body"]
    assert _stored(student.id) == before


@pytest.mark.parametrize("code", THROTTLING_CODES)
@USERS
def test_rn018_throttled_conditional_delete_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, user: User, code: str
) -> None:
    student = make_student()
    student_repo.create_student(student)
    before = _stored(student.id)

    calls = _throttle(monkeypatch, student_repo, STUDENTS_TABLE_ENV, "delete_item", code)

    response = student_handlers.delete_student(api_event(user, path={"id": student.id}), None)

    assert calls, "delete_item was not called"
    assert response["statusCode"] == 503, response["body"]
    assert MSG_SERVICE_BUSY in response["body"]
    assert _stored(student.id) == before


@pytest.mark.parametrize("code", THROTTLING_CODES)
@USERS
def test_throttled_belts_scan_on_student_detail_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, user: User, code: str
) -> None:
    student = make_student()
    student_repo.create_student(student)

    calls = _throttle(monkeypatch, belt_repo, BELTS_TABLE_ENV, "scan", code)

    response = student_handlers.get_student(api_event(user, path={"id": student.id}), None)

    assert calls, "list_belts was not called"
    assert response["statusCode"] == 503, response["body"]
    assert MSG_SERVICE_BUSY in response["body"]
