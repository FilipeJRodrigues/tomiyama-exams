"""QA coverage for requirement profiles, step 1 of #144 (RN017, decision of 2026-11-12).

Edges the delivery's own tests leave out: the profile in the query and in the
body with spaces, case and odd types; a legacy item moved to another belt by
the master; the migration racing an edit, a delete and a mark between its
scan and its write; and the master group without the examiner group.
"""

from typing import Any

import pytest
from conftest import (
    EXAMINER,
    MASTER,
    SCENARIO_REQUIREMENT,
    api_event,
    belt_id,
    response_json,
)

from domain.requirement_profiles import (
    MAIN_PROFILE_ID,
    MSG_MAIN_PROFILE_MASTER_ONLY,
    MSG_PROFILE_LOCKED,
    MSG_PROFILE_NOT_FOUND,
)
from domain.requirements import seed_requirements
from domain.users import MASTER_GROUP, User
from handlers import exams as exam_handlers
from handlers import requirements as handlers
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV

LEGACY_ID = "legacy-qa"


def _raw(requirement_id: str) -> dict[str, Any] | None:
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )


def _put_legacy(requirement_id: str = LEGACY_ID, **extra: Any) -> None:
    """An item written before profiles existed (no profile attributes)."""
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": requirement_id,
            "belt_id": belt_id("Cinza"),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": f"Item antigo {requirement_id}",
            "sort_order": 50,
            **extra,
        }
    )


def _payload(**overrides: Any) -> dict[str, Any]:
    return {
        "belt_id": belt_id("Cinza"),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Treino de quedas",
        "expected_answer": "Ukemi",
        "sort_order": 30,
        **overrides,
    }


def _strip_profile(requirement_id: str) -> None:
    tables.table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": requirement_id}, UpdateExpression="REMOVE profile_id, profile_belt"
    )


@pytest.fixture
def seeded_requirements(seeded: list) -> None:
    requirement_repo.seed_requirements(seed_requirements())


# --- profile in the query and in the body (RN017) ----------------------------


@pytest.mark.parametrize("value", ["   ", "\t"])
def test_rn017_qa_blank_query_profile_is_the_main_one(
    seeded_requirements: None, value: str
) -> None:
    query = {"profile_id": value, "belt_id": belt_id("Cinza")}
    response = handlers.list_requirements(api_event(EXAMINER, query=query), None)

    assert response["statusCode"] == 200
    assert len(response_json(response)) == 14


@pytest.mark.parametrize("value", ["Main", "main ", "main#", "x" * 500])
def test_rn017_qa_other_query_profiles_are_404(seeded_requirements: None, value: str) -> None:
    response = handlers.list_requirements(api_event(EXAMINER, query={"profile_id": value}), None)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": MSG_PROFILE_NOT_FOUND}


@pytest.mark.parametrize("value", [True, False, 0, 1.5, [], {}, ["main"]])
def test_rn017_qa_profile_of_odd_type_is_400_on_create_and_update(
    seeded_requirements: None, value: Any
) -> None:
    target = seed_requirements()[0]
    before = len(requirement_repo.list_all())
    stored = _raw(target.id)

    created = handlers.create_requirement(api_event(MASTER, body=_payload(profile_id=value)), None)
    updated = handlers.update_requirement(
        api_event(MASTER, path={"id": target.id}, body={**target.to_dict(), "profile_id": value}),
        None,
    )

    for response in (created, updated):
        assert response["statusCode"] == 400
        assert response_json(response) == {"message": "Perfil: valor inválido"}
    assert len(requirement_repo.list_all()) == before
    assert _raw(target.id) == stored


def test_rn017_qa_profile_too_long_is_400(seeded_requirements: None) -> None:
    response = handlers.create_requirement(
        api_event(MASTER, body=_payload(profile_id="x" * 65)), None
    )

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": "Perfil: máximo de 64 caracteres"}


def test_rn017_qa_body_profile_with_spaces_is_the_main_one(seeded_requirements: None) -> None:
    target = seed_requirements()[0]

    created = handlers.create_requirement(
        api_event(MASTER, body=_payload(profile_id="  main  ")), None
    )
    updated = handlers.update_requirement(
        api_event(
            MASTER,
            path={"id": target.id},
            body={**target.to_dict(), "profile_id": " main ", "description": "Outro"},
        ),
        None,
    )

    assert created["statusCode"] == 201
    assert response_json(created)["profile_id"] == MAIN_PROFILE_ID
    assert _raw(response_json(created)["id"])["profile_belt"] == f"main#{belt_id('Cinza')}"
    assert updated["statusCode"] == 200
    assert _raw(target.id)["profile_id"] == MAIN_PROFILE_ID


@pytest.mark.parametrize("value", ["MAIN", "Principal", "outro"])
def test_rn017_qa_update_to_another_profile_is_400_for_the_master(
    seeded_requirements: None, value: str
) -> None:
    target = seed_requirements()[0]
    stored = _raw(target.id)

    response = handlers.update_requirement(
        api_event(MASTER, path={"id": target.id}, body={**target.to_dict(), "profile_id": value}),
        None,
    )

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_PROFILE_LOCKED}
    assert _raw(target.id) == stored


def test_rn017_qa_null_profile_on_update_keeps_the_profile(seeded_requirements: None) -> None:
    target = seed_requirements()[0]

    response = handlers.update_requirement(
        api_event(
            MASTER,
            path={"id": target.id},
            body={**target.to_dict(), "profile_id": None, "description": "Outro"},
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert _raw(target.id)["profile_id"] == MAIN_PROFILE_ID
    assert _raw(target.id)["profile_belt"] == f"main#{target.belt_id}"


# --- permission ---------------------------------------------------------------


def test_rn017_qa_master_group_without_admin_is_not_an_examiner(
    seeded_requirements: None,
) -> None:
    master_only = User(sub="m-2", email="m2@example.com", groups=frozenset({MASTER_GROUP}))
    target = seed_requirements()[0]

    responses = [
        handlers.create_requirement(api_event(master_only, body=_payload()), None),
        handlers.update_requirement(
            api_event(master_only, path={"id": target.id}, body=target.to_dict()), None
        ),
        handlers.delete_requirement(api_event(master_only, path={"id": target.id}), None),
    ]

    assert [response["statusCode"] for response in responses] == [403, 403, 403]
    assert {response_json(r)["message"] for r in responses} == {"Esta área é dos examinadores"}
    assert requirement_repo.get_requirement(target.id) is not None


def test_rn017_qa_refused_examiner_edit_does_not_migrate_a_legacy_item(seeded: list) -> None:
    _put_legacy()
    before = _raw(LEGACY_ID)

    response = handlers.update_requirement(
        api_event(EXAMINER, path={"id": LEGACY_ID}, body=_payload(profile_id="main")), None
    )

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MAIN_PROFILE_MASTER_ONLY}
    assert _raw(LEGACY_ID) == before


def test_rn017_qa_master_moving_a_legacy_item_gets_the_new_profile_belt(seeded: list) -> None:
    _put_legacy()

    response = handlers.update_requirement(
        api_event(MASTER, path={"id": LEGACY_ID}, body=_payload(belt_id=belt_id("Azul"))), None
    )

    assert response["statusCode"] == 200
    assert _raw(LEGACY_ID)["profile_belt"] == f"main#{belt_id('Azul')}"
    in_index = tables.table(REQUIREMENTS_TABLE_ENV).query(
        IndexName=requirement_repo.BY_PROFILE_BELT_INDEX,
        KeyConditionExpression="profile_belt = :key",
        ExpressionAttributeValues={":key": f"main#{belt_id('Azul')}"},
    )["Items"]
    assert [item["id"] for item in in_index] == [LEGACY_ID]
    assert requirement_repo.migrate_to_main_profile() == 0
    assert _raw(LEGACY_ID)["profile_belt"] == f"main#{belt_id('Azul')}"


# --- migration racing other writers between its scan and its write ------------


def _run_between_scan_and_write(monkeypatch: pytest.MonkeyPatch, action: Any) -> None:
    """Run ``action`` once, right before the migration's first ``UpdateItem``."""
    real_table = requirement_repo.table
    done = {"ran": False}

    class Racing:
        def __init__(self, inner: Any) -> None:
            self.inner = inner

        def update_item(self, **kwargs: Any) -> Any:
            if not done["ran"]:
                done["ran"] = True
                action()
            return self.inner.update_item(**kwargs)

        def __getattr__(self, name: str) -> Any:
            return getattr(self.inner, name)

    monkeypatch.setattr(
        requirement_repo,
        "table",
        lambda env: Racing(real_table(env)) if env == REQUIREMENTS_TABLE_ENV else real_table(env),
    )


def test_rn017_qa_migration_after_a_master_move_keeps_the_new_belt(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_legacy()

    def master_moves_it() -> None:
        response = handlers.update_requirement(
            api_event(MASTER, path={"id": LEGACY_ID}, body=_payload(belt_id=belt_id("Azul"))),
            None,
        )
        assert response["statusCode"] == 200

    _run_between_scan_and_write(monkeypatch, master_moves_it)

    assert requirement_repo.migrate_to_main_profile() == 0
    stored = _raw(LEGACY_ID)
    assert (stored["belt_id"], stored["profile_belt"]) == (
        belt_id("Azul"),
        f"main#{belt_id('Azul')}",
    )


def test_rn017_qa_migration_after_a_delete_does_not_recreate(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_legacy()

    def master_deletes_it() -> None:
        response = handlers.delete_requirement(api_event(MASTER, path={"id": LEGACY_ID}), None)
        assert response["statusCode"] == 204

    _run_between_scan_and_write(monkeypatch, master_deletes_it)

    assert requirement_repo.migrate_to_main_profile() == 0
    assert _raw(LEGACY_ID) is None


def test_rn017_qa_migration_after_a_mark_keeps_the_answer_count(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    for item in requirement_repo.list_all():
        _strip_profile(item.id)

    def examiner_marks_it() -> None:
        response = exam_handlers.mark_answer(
            api_event(
                EXAMINER,
                path={
                    "id": "event-1",
                    "student_id": "student-1",
                    "requirement_id": SCENARIO_REQUIREMENT.id,
                },
                body={"correct": True},
            ),
            None,
        )
        assert response["statusCode"] == 200, response["body"]

    _run_between_scan_and_write(monkeypatch, examiner_marks_it)

    assert requirement_repo.migrate_to_main_profile() >= 1
    stored = _raw(SCENARIO_REQUIREMENT.id)
    assert stored["answer_count"] == 1
    assert stored["profile_id"] == MAIN_PROFILE_ID
