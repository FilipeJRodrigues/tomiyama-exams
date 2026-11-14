"""QA da etapa 3c do #144: ``Requirements`` sem o índice ``by_belt`` (RN006, RN007, RN017).

Cobertura que faltava nos testes da etapa:

- o caminho de proteção do perfil principal (``Scan`` da tabela antes do
  marcador v2) segue todas as páginas, e uma página barrada no meio responde
  503 sem devolver lista pela metade;
- um item movido **para fora** da faixa por código anterior aos perfis (com o
  ``profile_belt`` ainda apontando para a faixa antiga) fica fora da faixa
  antiga no caminho de proteção, inclusive na ordem padrão do ``POST``;
- outro perfil nunca usa o caminho de proteção (nem lê o marcador);
- a marcação e a desmarcação com a leitura dos itens barrada respondem 503,
  antes e depois do marcador (a marcação já gravada, como documenta o README);
- a cópia de um perfil com origem principal repete o ``Scan`` barrado e termina;
- nenhuma função, além das que rodam o caminho de proteção, recebe uma ação que
  cubra ``dynamodb:Scan`` (curinga incluído) na tabela ``Requirements``.
"""

import os
import re
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from cfnlint.decode import decode
from conftest import (
    EXAMINER,
    MASTER,
    SCENARIO_REQUIREMENT,
    SCENARIO_ROUTES,
    CopyInvocations,
    api_event,
    assert_service_busy,
    belt_id,
    make_student,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain.belts import SEED_BELTS
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam
from domain.requirement_profiles import MAIN_PROFILE_ID
from domain.requirements import Requirement, RequirementKind
from handlers import exams as exam_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as profile_handlers
from handlers import requirements as requirement_handlers
from repository import answers as answer_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV, SETTINGS_TABLE_ENV

TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
TARGET = "Cinza/Azul"  # faixa-alvo do aluno padrão (Cinza)
OTHER_BELT = "Cinza"
TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"
REQUIREMENTS_ARN = {"Fn::GetAtt": ["RequirementsTable", "Arn"]}


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


def _put_raw(requirement_id: str, belt: str, sort_order: int, **extra: Any) -> None:
    """Grava um item direto na tabela, como o código anterior aos perfis deixava."""
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": requirement_id,
            "belt_id": belt_id(belt),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": f"Item {requirement_id}",
            "expected_answer": "Resposta",
            "sort_order": sort_order,
            **extra,
        }
    )


def _item(requirement_id: str, belt: str, sort_order: int, **changes: Any) -> Requirement:
    return Requirement(
        id=requirement_id,
        belt_id=belt_id(belt),
        kind=RequirementKind.THEORY,
        category="Vocabulário",
        description=f"Item {requirement_id}",
        expected_answer="Resposta",
        sort_order=sort_order,
        **changes,
    )


class Calls:
    """Chamadas ``Query``/``Scan`` em ``Requirements`` e ``GetItem`` em ``Settings``."""

    def __init__(self) -> None:
        self.requirements: list[dict[str, Any]] = []
        self.settings: list[dict[str, Any]] = []

    def names(self) -> list[str]:
        return [
            f"{call['operation']} {call.get('IndexName', '')}".strip() for call in self.requirements
        ]


@pytest.fixture
def scan_pages_of_one(monkeypatch: pytest.MonkeyPatch) -> Calls:
    """Espia as leituras e força páginas de um item em todo ``Scan`` de ``Requirements``."""
    calls = Calls()
    original = BaseClient._make_api_call
    requirements = os.environ[REQUIREMENTS_TABLE_ENV]
    settings = os.environ[SETTINGS_TABLE_ENV]

    def spy(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name in {"Query", "Scan"} and api_params.get("TableName") == requirements:
            calls.requirements.append({"operation": operation_name, **api_params})
            if operation_name == "Scan":
                api_params = {**api_params, "Limit": 1}
        if operation_name == "GetItem" and api_params.get("TableName") == settings:
            calls.settings.append(dict(api_params))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", spy)
    return calls


@pytest.fixture
def exam(seeded: None) -> Exam:
    """Exame em andamento de Ana (Cinza → Cinza/Azul) num evento aberto do perfil principal."""
    exam_event = ExamEvent(
        id="event-1",
        name="Exame março/2027",
        exam_date=date(2027, 3, 20),
        status=EventStatus.OPEN,
        created_at=NOW,
        updated_at=NOW,
    )
    event_repo.create_event(exam_event)
    student = replace(make_student(), id="student-1", full_name="Ana")
    student_repo.create_student(student)
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": exam_event.id}, body={"student_id": student.id}), None
    )
    assert response["statusCode"] == 201, response["body"]
    stored = exam_repo.get_exam(exam_event.id, student.id)
    assert stored is not None
    return stored


@pytest.fixture
def main_items(exam: Exam) -> list[str]:
    """Itens do principal na faixa-alvo (fora de ordem, com e sem perfil) e ruído.

    Devolve os ids do principal na faixa-alvo, na ordem da folha.
    """
    requirement_repo.create_requirement(_item("m3", TARGET, 3))
    _put_raw("legacy", TARGET, 2)
    requirement_repo.create_requirement(_item("m1", TARGET, 1))
    _put_raw(
        "moved-in",
        TARGET,
        4,
        profile_id=MAIN_PROFILE_ID,
        profile_belt=f"{MAIN_PROFILE_ID}#{belt_id(OTHER_BELT)}",
    )
    requirement_repo.create_requirement(_item("other-profile", TARGET, 1, profile_id="p2"))
    requirement_repo.create_requirement(_item("other-belt", OTHER_BELT, 1))
    return ["m1", "legacy", "m3", "moved-in"]


def _sheet(exam: Exam) -> dict[str, Any]:
    response = exam_handlers.get_exam_sheet(
        api_event(EXAMINER, path={"id": exam.event_id, "student_id": exam.student_id}), None
    )
    assert response["statusCode"] == 200, response["body"]
    return response_json(response)


# --- o Scan do caminho de proteção segue todas as páginas -------------------------------


def test_rn017_qa_fallback_scan_follows_every_page(
    main_items: list[str], exam: Exam, scan_pages_of_one: Calls
) -> None:
    one_belt = requirement_repo.list_profile_belt(MAIN_PROFILE_ID, belt_id(TARGET))
    scans_one_belt = scan_pages_of_one.names().count("Scan")
    belts = requirement_repo.list_profile_belts(
        MAIN_PROFILE_ID, [belt_id(TARGET), belt_id(OTHER_BELT)]
    )
    sheet = _sheet(exam)

    # 6 itens na tabela, um por página: 6 páginas com item e a última vazia.
    assert scans_one_belt >= 6
    assert all(name == "Scan" for name in scan_pages_of_one.names())
    assert [item.id for item in one_belt] == main_items
    assert [item.id for item in belts] == [*main_items, "other-belt"]
    assert [item["id"] for item in sheet["items"]] == main_items
    assert sheet["summary"]["THEORY"]["total"] == len(main_items)


def test_rn017_qa_fallback_scan_throttled_on_a_later_page_answers_503(
    main_items: list[str], exam: Exam, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Páginas de um item, e só as páginas seguintes à primeira barradas: a
    # rota não devolve a lista pela metade, responde 503.
    original = BaseClient._make_api_call
    requirements = os.environ[REQUIREMENTS_TABLE_ENV]

    def small_pages(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name == "Scan" and api_params.get("TableName") == requirements:
            api_params = {**api_params, "Limit": 1}
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", small_pages)
    stub = throttle_dynamodb(
        monkeypatch,
        "Scan",
        REQUIREMENTS_TABLE_ENV,
        matches=lambda params: "ExclusiveStartKey" in params,
    )

    response = exam_handlers.get_exam_sheet(
        api_event(EXAMINER, path={"id": exam.event_id, "student_id": exam.student_id}), None
    )
    listed = requirement_handlers.list_requirements(
        api_event(EXAMINER, query={"belt_id": belt_id(TARGET)}), None
    )
    stub.active = False

    assert_service_busy(response, stub)
    assert listed["statusCode"] == 503, listed["body"]


# --- item movido para FORA da faixa com a chave antiga ----------------------------------


def test_rn017_qa_fallback_leaves_out_an_item_moved_out_of_the_belt(
    main_items: list[str],
) -> None:
    # Código anterior aos perfis moveu o item para Cinza sem atualizar o
    # profile_belt, que ainda aponta para a faixa-alvo: o índice o mostraria
    # na faixa errada; o Scan, que filtra por belt_id, não.
    _put_raw(
        "moved-out",
        OTHER_BELT,
        99,
        profile_id=MAIN_PROFILE_ID,
        profile_belt=f"{MAIN_PROFILE_ID}#{belt_id(TARGET)}",
    )

    in_index = requirement_repo._query_profile_belt(MAIN_PROFILE_ID, belt_id(TARGET))
    target = requirement_repo.list_profile_belt(MAIN_PROFILE_ID, belt_id(TARGET))
    other = requirement_repo.list_profile_belt(MAIN_PROFILE_ID, belt_id(OTHER_BELT))
    created = requirement_handlers.create_requirement(
        api_event(
            MASTER,
            body={
                "belt_id": belt_id(TARGET),
                "kind": "THEORY",
                "category": "Vocabulário",
                "description": "Item novo do principal",
            },
        ),
        None,
    )

    assert "moved-out" in {item.id for item in in_index}  # o que o caminho protege
    assert [item.id for item in target] == main_items
    assert {item.id for item in other} == {"other-belt", "moved-out"}
    # A ordem padrão ignora o 99 do item que saiu da faixa: 4 + 1.
    assert created["statusCode"] == 201, created["body"]
    assert response_json(created)["sort_order"] == len(main_items) + 1


# --- outro perfil nunca usa o caminho de proteção ---------------------------------------


def test_rn017_qa_before_the_marker_another_profile_never_scans_nor_reads_the_marker(
    main_items: list[str], scan_pages_of_one: Calls
) -> None:
    scan_pages_of_one.requirements.clear()
    scan_pages_of_one.settings.clear()

    one = requirement_repo.list_profile_belt("p2", belt_id(TARGET))
    every = requirement_repo.list_profile_belts("p2", [belt.id for belt in SEED_BELTS])

    assert [item.id for item in one] == ["other-profile"]
    assert [item.id for item in every] == ["other-profile"]
    query = f"Query {requirement_repo.BY_PROFILE_BELT_INDEX}"
    assert scan_pages_of_one.names() == [query] * (1 + len(SEED_BELTS))
    assert scan_pages_of_one.settings == []


# --- marcação e desmarcação com a leitura dos itens barrada → 503 -----------------------


@pytest.mark.parametrize(
    "route", ["PUT .../answers/{requirement_id}", "DELETE .../answers/{requirement_id}"]
)
@pytest.mark.parametrize("migrated", [False, True], ids=["antes do marcador", "depois"])
def test_rn006_qa_mark_and_unmark_with_the_items_read_throttled_answer_503(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, route: str, migrated: bool
) -> None:
    if migrated:
        requirement_repo.migrate_profile_belts()
        stub = throttle_dynamodb(
            monkeypatch,
            "Query",
            REQUIREMENTS_TABLE_ENV,
            matches=lambda params: params.get("IndexName") == "by_profile_belt",
        )
    else:
        stub = throttle_dynamodb(monkeypatch, "Scan", REQUIREMENTS_TABLE_ENV)

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    exam = exam_repo.get_exam("event-1", "student-1")
    assert exam is not None
    answers = answer_repo.list_by_exam(exam.id)
    # A marcação grava antes de ler o resumo (exceção documentada no README):
    # o 503 vem com ela gravada; a desmarcação de um item sem marca não grava.
    if route.startswith("PUT"):
        assert set(answers) == {SCENARIO_REQUIREMENT.id}
    else:
        assert answers == {}


# --- a cópia com origem principal repete o Scan barrado ---------------------------------


def test_rn017_qa_copy_of_main_retries_a_throttled_scan_and_completes(
    main_items: list[str], copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": "Novo"}), None)
    assert created["statusCode"] == 202, created["body"]
    profile_id = response_json(created)["id"]
    original = BaseClient._make_api_call
    requirements = os.environ[REQUIREMENTS_TABLE_ENV]
    throttled: list[int] = []

    def throttle_first_scans(
        self: BaseClient, operation_name: str, api_params: dict[str, Any]
    ) -> Any:
        if (
            operation_name == "Scan"
            and api_params.get("TableName") == requirements
            and len(throttled) < 3
        ):
            throttled.append(1)
            raise ClientError(
                {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
                operation_name,
            )
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", throttle_first_scans)

    result = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )

    assert len(throttled) == 3
    assert result["outcome"] == "READY", result
    # Os 4 itens do principal na faixa-alvo e o de Cinza; nunca o do outro perfil.
    assert result["copied"] == len(main_items) + 1
    copied = requirement_repo.list_profile_belt(profile_id, belt_id(TARGET))
    assert sorted(item.description for item in copied) == sorted(
        f"Item {item_id}" for item_id in main_items
    )


# --- template: só as funções do caminho de proteção alcançam Scan em Requirements -------


def _covers_scan(action: str) -> bool:
    pattern = re.escape(action).replace(r"\*", ".*").replace(r"\?", ".")
    return re.fullmatch(pattern, "dynamodb:Scan", re.IGNORECASE) is not None


def _reaches_requirements_table(resource: Any) -> bool:
    if resource == REQUIREMENTS_ARN or resource == "*":
        return True
    text = str(resource)
    # Um Sub com o ARN da tabela seguido de curinga também alcança a tabela.
    return "RequirementsTable" in text and "/index/" not in text


def test_rn017_qa_no_other_function_gets_an_action_covering_scan_on_requirements() -> None:
    template, errors = decode(str(TEMPLATE))
    assert not errors, errors
    explicit_scanners: set[str] = set()
    for name, resource in template["Resources"].items():
        if resource["Type"] != "AWS::Serverless::Function":
            continue
        for policy in resource["Properties"].get("Policies", []):
            if not isinstance(policy, dict):
                continue
            for statement in policy.get("Statement", []):
                actions = statement.get("Action", [])
                actions = [actions] if isinstance(actions, str) else list(actions)
                resources = statement.get("Resource", [])
                resources = resources if isinstance(resources, list) else [resources]
                if any(_covers_scan(action) for action in actions) and any(
                    _reaches_requirements_table(item) for item in resources
                ):
                    explicit_scanners.add(name)
                    # Sempre a ação exata e só a tabela: nunca curinga.
                    assert actions == ["dynamodb:Scan"], (name, statement)
                    assert resources == [REQUIREMENTS_ARN], (name, statement)

    assert explicit_scanners == {
        "GetExamSheetFunction",
        "MarkAnswerFunction",
        "UnmarkAnswerFunction",
        "CopyRequirementProfileFunction",
    }
