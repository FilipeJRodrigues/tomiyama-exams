"""Requirements: Appendix A seed and RN017 (examiner-only management)."""

import importlib.util
import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from conftest import EXAMINER, GUARDIAN, MASTER, api_event, belt_id, response_json

from domain.belts import SEED_BELTS
from domain.errors import ValidationError
from domain.requirements import (
    RequirementKind,
    build_requirement,
    seed_requirement_id,
    seed_requirements,
)
from handlers import requirements as handlers
from repository import requirements as requirement_repo

BACKEND_DIR = Path(__file__).resolve().parent.parent
BELTS_BY_ID = {belt.id: belt for belt in SEED_BELTS}

# (total, theory, practice) per belt, from the Appendix A headings.
EXPECTED_COUNTS = {
    "Branca/Cinza": (6, 2, 4),
    "Cinza": (14, 5, 9),
    "Cinza/Azul": (24, 11, 13),
    "Azul": (34, 18, 16),
    "Azul/Amarela": (45, 26, 19),
    "Amarela": (58, 29, 29),
    "Amarela/Laranja": (74, 33, 41),
    "Laranja": (83, 35, 48),
    "Verde": (99, 39, 60),
    "Roxa": (116, 41, 75),
    "Marrom": (139, 42, 97),
}


def _load_build_script() -> Any:
    path = BACKEND_DIR / "scripts" / "build_requirements_seed.py"
    spec = importlib.util.spec_from_file_location("build_requirements_seed", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def seeded_requirements(seeded: list) -> None:
    requirement_repo.seed_requirements(seed_requirements())


# --- seed data --------------------------------------------------------------


def test_seed_file_matches_requirements_doc() -> None:
    """The committed JSON is what the script generates from the current doc."""
    script = _load_build_script()
    parsed = script.parse_appendix(script.SOURCE.read_text(encoding="utf-8"))
    committed = json.loads(script.TARGET.read_text(encoding="utf-8"))
    assert parsed == committed


def test_seed_has_692_items_with_counts_per_belt() -> None:
    items = seed_requirements()
    assert len(items) == 692
    names = {belt.id: belt.name for belt in SEED_BELTS}
    for belt_name, (total, theory, practice) in EXPECTED_COUNTS.items():
        kinds = Counter(item.kind for item in items if names[item.belt_id] == belt_name)
        assert (
            sum(kinds.values()),
            kinds[RequirementKind.THEORY],
            kinds[RequirementKind.PRACTICE],
        ) == (
            total,
            theory,
            practice,
        ), belt_name


def test_seed_ids_are_unique_and_deterministic() -> None:
    items = seed_requirements()
    assert len({item.id for item in items}) == len(items)
    assert items[0].id == seed_requirement_id("Branca/Cinza", 1)


def test_seed_keeps_expected_answers() -> None:
    first = seed_requirements()[0]
    assert first.belt_id == belt_id("Branca/Cinza")
    assert (first.kind, first.category, first.description, first.expected_answer) == (
        RequirementKind.PRACTICE,
        "Fundamentos",
        "Demonstrar saudação em pé",
        "Ritsurei",
    )
    no_answer = next(item for item in seed_requirements() if item.description == "Deashi barai")
    assert no_answer.expected_answer is None


def test_seed_runs_once_and_never_recreates_deleted_items(seeded: list) -> None:
    items = seed_requirements()
    assert requirement_repo.seed_requirements(items) == 692
    requirement_repo.delete_requirement(items[0].id)

    assert requirement_repo.seed_requirements(items) == 0
    assert requirement_repo.get_requirement(items[0].id) is None


def test_seed_resumes_after_partial_run(seeded: list) -> None:
    items = seed_requirements()
    requirement_repo.create_requirement(items[0])
    assert requirement_repo.seed_requirements(items) == 691


# --- domain -----------------------------------------------------------------


def _payload(**overrides: Any) -> dict[str, Any]:
    data = {
        "belt_id": belt_id("Cinza"),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Treino de quedas",
        "expected_answer": "Ukemi",
        "sort_order": 3,
    }
    data.update(overrides)
    return data


def test_rn017_valid_requirement() -> None:
    req = build_requirement(_payload(), BELTS_BY_ID, requirement_id="r1", default_sort_order=9)
    assert (req.kind, req.sort_order, req.expected_answer) == (RequirementKind.THEORY, 3, "Ukemi")


def test_rn017_default_sort_order_and_blank_answer() -> None:
    payload = _payload(expected_answer="  ")
    del payload["sort_order"]
    req = build_requirement(payload, BELTS_BY_ID, requirement_id="r1", default_sort_order=9)
    assert (req.sort_order, req.expected_answer) == (9, None)


def test_rn017_belt_must_exist() -> None:
    with pytest.raises(ValidationError, match="Faixa: faixa não encontrada"):
        build_requirement(
            _payload(belt_id="nope"), BELTS_BY_ID, requirement_id="r1", default_sort_order=1
        )


@pytest.mark.parametrize(
    "overrides",
    [{"kind": "ORAL"}, {"category": ""}, {"category": "x" * 61}, {"description": None}],
)
def test_rn017_rejects_invalid_fields(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        build_requirement(
            _payload(**overrides), BELTS_BY_ID, requirement_id="r1", default_sort_order=1
        )


# --- routes -----------------------------------------------------------------


@pytest.mark.parametrize(
    "call",
    [
        handlers.list_requirements,
        handlers.create_requirement,
        handlers.update_requirement,
        handlers.delete_requirement,
    ],
)
def test_rn017_only_examiners(seeded_requirements: None, call: Any) -> None:
    event = api_event(GUARDIAN, path={"id": seed_requirements()[0].id}, body=_payload())
    response = call(event, None)
    assert response["statusCode"] == 403
    assert response_json(response)["message"] == "Esta área é dos examinadores"


def test_rn017_list_brown_belt_is_complete_and_ordered(seeded_requirements: None) -> None:
    event = api_event(EXAMINER, query={"belt_id": belt_id("Marrom")})
    body = response_json(handlers.list_requirements(event, None))
    assert len(body) == 139
    assert [item["sort_order"] for item in body] == list(range(1, 140))


def test_rn017_list_filters_by_kind(seeded_requirements: None) -> None:
    event = api_event(EXAMINER, query={"belt_id": belt_id("Cinza/Azul"), "kind": "THEORY"})
    body = response_json(handlers.list_requirements(event, None))
    assert len(body) == 11
    assert {item["kind"] for item in body} == {"THEORY"}


def test_rn017_list_all_in_graduation_order(seeded_requirements: None) -> None:
    body = response_json(handlers.list_requirements(api_event(EXAMINER), None))
    assert len(body) == 692
    order = {belt.id: belt.sort_order for belt in SEED_BELTS}
    keys = [(order[item["belt_id"]], item["sort_order"]) for item in body]
    assert keys == sorted(keys)


def test_rn017_list_invalid_filters(seeded_requirements: None) -> None:
    bad_kind = api_event(EXAMINER, query={"kind": "ORAL"})
    assert handlers.list_requirements(bad_kind, None)["statusCode"] == 400
    bad_belt = api_event(EXAMINER, query={"belt_id": "nope"})
    assert handlers.list_requirements(bad_belt, None)["statusCode"] == 404


def test_rn017_create_appends_to_belt(seeded_requirements: None) -> None:
    payload = _payload()
    del payload["sort_order"]
    # Items of the main profile: only the admin master writes them (#144).
    response = handlers.create_requirement(api_event(MASTER, body=payload), None)
    assert response["statusCode"] == 201
    created = response_json(response)
    assert created["sort_order"] == 15  # Cinza has 14 seeded items
    assert requirement_repo.get_requirement(created["id"]) is not None


def test_rn017_create_with_unknown_belt(seeded_requirements: None) -> None:
    event = api_event(EXAMINER, body=_payload(belt_id="nope"))
    assert handlers.create_requirement(event, None)["statusCode"] == 400


def test_rn017_update_and_delete(seeded_requirements: None) -> None:
    target = seed_requirements()[0]
    event = api_event(MASTER, path={"id": target.id}, body=_payload(description="Novo texto"))
    response = handlers.update_requirement(event, None)
    assert response["statusCode"] == 200
    assert requirement_repo.get_requirement(target.id).description == "Novo texto"

    response = handlers.delete_requirement(api_event(MASTER, path={"id": target.id}), None)
    assert response["statusCode"] == 204
    response = handlers.delete_requirement(api_event(MASTER, path={"id": target.id}), None)
    assert response["statusCode"] == 404
