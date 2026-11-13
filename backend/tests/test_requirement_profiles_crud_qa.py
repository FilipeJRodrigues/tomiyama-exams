"""QA edges of the requirement profiles, step 2 of #144 (RN017).

Cases the step's own tests leave out: what the copy takes from the main profile
when other profiles and items stored before the profiles exist, two runs of
the same copy interleaved, fields smuggled in the bodies, bodies of odd types,
ids above 1024 bytes in the rename and resume paths, the first create racing
another, a create racing a rename, the limit and a rename, and the copies of
items with answers.
"""

from typing import Any

import pytest
from conftest import (
    EXAMINER,
    GUARDIAN,
    MASTER,
    CopyInvocations,
    api_event,
    before_dynamodb_call,
    belt_id,
    dynamodb_snapshot,
    response_json,
)

from domain import dates
from domain.belts import SEED_BELTS
from domain.requirement_profiles import (
    MAIN_PROFILE_ID,
    MSG_PROFILE_LIMIT,
    MSG_PROFILE_NAME_TAKEN,
    MSG_PROFILE_NOT_FOUND,
)
from domain.requirements import Requirement, RequirementKind, copied_requirement_id
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as handlers
from handlers import requirements as requirement_handlers
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV, SETTINGS_TABLE_ENV

NOW = "2026-11-13T12:00:00+00:00"
CINZA = belt_id("Cinza")
AZUL = belt_id("Azul")

MAIN_ITEMS = (
    Requirement("m-cinza-1", CINZA, RequirementKind.THEORY, "Vocabulário", "Contar", "Ichi", 1),
    Requirement("m-cinza-2", CINZA, RequirementKind.PRACTICE, "Nage-waza", "O-soto", None, 2),
    Requirement("m-azul-1", AZUL, RequirementKind.PRACTICE, "Ukemi", "Mae-ukemi", None, 1),
)


@pytest.fixture
def main_items(
    seeded: list, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> tuple[Requirement, ...]:
    """Three main items; m-cinza-2 has answers; m-azul-1 is stored as before the profiles."""
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)
    for item in MAIN_ITEMS:
        requirement_repo.create_requirement(item)
    requirements = tables.table(REQUIREMENTS_TABLE_ENV)
    requirements.update_item(
        Key={"id": "m-cinza-2"},
        UpdateExpression="SET answer_count = :n",
        ExpressionAttributeValues={":n": 2},
    )
    requirements.update_item(
        Key={"id": "m-azul-1"}, UpdateExpression="REMOVE profile_id, profile_belt"
    )
    return MAIN_ITEMS


def _create(body: Any, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.create_profile(api_event(user, body=body), None)


def _created(name: str, **body: Any) -> dict[str, Any]:
    response = _create({"name": name, **body})
    assert response["statusCode"] == 202, response["body"]
    return response_json(response)


def _run(profile_id: str) -> dict[str, Any]:
    return copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )


def _ready(name: str, **body: Any) -> str:
    profile_id = _created(name, **body)["id"]
    assert _run(profile_id)["outcome"] == "READY"
    return profile_id


def _items_of(profile_id: str) -> list[Requirement]:
    return requirement_repo.list_profile_belts(profile_id, [belt.id for belt in SEED_BELTS])


def _stored_profiles() -> dict[str, Any]:
    item = (
        tables.table(SETTINGS_TABLE_ENV)
        .get_item(Key={"id": profile_repo.REQUIREMENT_PROFILES_ID}, ConsistentRead=True)
        .get("Item")
    )
    return (item or {}).get("profiles", {})


def _message(response: dict[str, Any]) -> tuple[int, str]:
    return response["statusCode"], response_json(response)["message"]


def _new_item(profile_id: str, description: str) -> dict[str, Any]:
    response = requirement_handlers.create_requirement(
        api_event(
            EXAMINER,
            body={
                "profile_id": profile_id,
                "belt_id": CINZA,
                "kind": "THEORY",
                "category": "Vocabulário",
                "description": description,
                "expected_answer": "Resposta",
            },
        ),
        None,
    )
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)


# --- what the copy takes ------------------------------------------------------


def test_rn017_qa_copy_of_main_leaves_out_the_other_profiles_items(main_items: tuple) -> None:
    first = _ready("Primeiro")
    _new_item(first, "Só do primeiro")

    second = _ready("Segundo")

    copies = _items_of(second)
    assert sorted(item.id for item in copies) == sorted(
        copied_requirement_id(second, item.id) for item in main_items
    )
    assert {item.profile_id for item in copies} == {second}
    assert "Só do primeiro" not in {item.description for item in copies}


def test_rn017_qa_copy_of_main_takes_the_items_stored_before_the_profiles(
    main_items: tuple,
) -> None:
    profile_id = _ready("Perfil")

    copy_id = copied_requirement_id(profile_id, "m-azul-1")
    stored = tables.table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": copy_id})["Item"]
    assert (stored["profile_id"], stored["profile_belt"]) == (profile_id, f"{profile_id}#{AZUL}")
    # The source stays as it was (the migration, not the copy, gives it a profile).
    source = tables.table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": "m-azul-1"})["Item"]
    assert "profile_id" not in source


def test_rn017_qa_copy_of_another_profile_follows_its_items_not_main(main_items: tuple) -> None:
    source = _ready("Origem")
    added = _new_item(source, "Só da origem")
    removed = copied_requirement_id(source, "m-cinza-1")
    deleted = requirement_handlers.delete_requirement(
        api_event(EXAMINER, path={"id": removed}), None
    )
    assert deleted["statusCode"] == 204

    target = _ready("Destino", source_profile_id=source)

    ids = {item.id for item in _items_of(target)}
    assert copied_requirement_id(target, added["id"]) in ids
    assert copied_requirement_id(target, removed) not in ids
    assert copied_requirement_id(target, "m-cinza-1") not in ids
    assert len(ids) == len(main_items)


def test_rn017_qa_two_interleaved_runs_write_each_item_once(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _created("Perfil")["id"]
    original = requirement_repo.put_copy
    outcomes: dict[str, Any] = {}

    def other_run_first(*args: Any, **kwargs: Any) -> bool:
        if "other" not in outcomes:
            # Another run (a Lambda retry or a resume) reads, copies and finishes
            # between this run's read and its first write.
            monkeypatch.setattr(requirement_repo, "put_copy", original)
            outcomes["other"] = _run(profile_id)
            monkeypatch.setattr(requirement_repo, "put_copy", other_run_first)
        return original(*args, **kwargs)

    monkeypatch.setattr(requirement_repo, "put_copy", other_run_first)
    late = _run(profile_id)

    assert outcomes["other"]["outcome"] == "READY"
    assert outcomes["other"]["written"] == len(main_items)
    assert (late["outcome"], late["written"]) == ("ALREADY_READY", 0)
    assert len(_items_of(profile_id)) == len(main_items)
    stored = _stored_profiles()[profile_id]
    assert (stored["status"], stored["copied_items"], stored["total_items"]) == ("READY", 3, 3)


def test_rn017_qa_copy_invoked_for_the_main_profile_writes_nothing(main_items: tuple) -> None:
    before = dynamodb_snapshot()

    result = copy_worker.handler({"profile_id": MAIN_PROFILE_ID}, None)

    assert result == {"profile_id": MAIN_PROFILE_ID, "outcome": "NOT_FOUND"}
    assert dynamodb_snapshot() == before


# --- copies of items with answers -----------------------------------------------


def test_rn017_qa_copy_of_an_item_with_answers_changes_belt_kind_and_is_deleted(
    main_items: tuple,
) -> None:
    profile_id = _ready("Perfil")
    copy_id = copied_requirement_id(profile_id, "m-cinza-2")  # the source has answers
    current = requirement_repo.get_requirement(copy_id).to_dict()

    moved = requirement_handlers.update_requirement(
        api_event(
            EXAMINER,
            path={"id": copy_id},
            body={**current, "belt_id": AZUL, "kind": "THEORY"},
        ),
        None,
    )
    deleted = requirement_handlers.delete_requirement(
        api_event(EXAMINER, path={"id": copy_id}), None
    )

    assert moved["statusCode"] == 200, moved["body"]
    assert (response_json(moved)["belt_id"], response_json(moved)["kind"]) == (AZUL, "THEORY")
    assert deleted["statusCode"] == 204
    # The main item keeps its answers counter and its belt.
    source = tables.table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": "m-cinza-2"})["Item"]
    assert (source["answer_count"], source["belt_id"]) == (2, CINZA)


# --- bodies -----------------------------------------------------------------------


def test_rn017_qa_create_ignores_fields_other_than_name_and_source(main_items: tuple) -> None:
    response = _create(
        {
            "name": "Perfil",
            "id": MAIN_PROFILE_ID,
            "is_main": True,
            "status": "READY",
            "copied_items": 999,
            "total_items": 999,
            "created_by": "outro",
            "copy_updated_at": "2000-01-01T00:00:00+00:00",
        }
    )

    body = response_json(response)
    assert response["statusCode"] == 202
    assert body["id"] != MAIN_PROFILE_ID
    assert (body["is_main"], body["status"], body["copied_items"]) == (False, "COPYING", None)
    assert (body["created_by"], body["copy_updated_at"], body["copy_stalled"]) == (
        EXAMINER.sub,
        NOW,
        False,
    )
    assert set(_stored_profiles()) == {body["id"]}


def test_rn017_qa_rename_writes_only_the_name(main_items: tuple) -> None:
    created = _created("Perfil")
    before = _stored_profiles()[created["id"]]

    response = handlers.rename_profile(
        api_event(
            EXAMINER,
            path={"id": created["id"]},
            body={
                "name": "Novo nome",
                "status": "READY",
                "source_profile_id": "outro",
                "is_main": True,
                "copy_updated_at": None,
            },
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert _stored_profiles()[created["id"]] == {**before, "name": "Novo nome"}


@pytest.mark.parametrize(
    ("name", "status"),
    [
        ("  " + "x" * 60 + "  ", 202),  # trimmed before the length
        ("x" * 61, 400),
        ("Perfil do Sensei", 409),  # no-break space folds to a space
        ("  perfil do sensei ", 409),
    ],
)
def test_rn017_qa_profile_name_edges(main_items: tuple, name: str, status: int) -> None:
    _created("Perfil do Sensei")

    assert _create({"name": name})["statusCode"] == status


@pytest.mark.parametrize(
    "body",
    [
        None,
        "texto",
        [],
        [{"name": "Perfil"}],
        {"name": {"x": 1}},
        {"name": ["Perfil"]},
        {"name": True},
        {"name": "\t\n "},
        {"name": "Perfil", "source_profile_id": True},
        {"name": "Perfil", "source_profile_id": {"id": "main"}},
        {"name": "Perfil", "source_profile_id": ["main"]},
    ],
)
@pytest.mark.parametrize("route", ["create", "rename"])
def test_rn017_qa_odd_bodies_are_400_and_write_nothing(
    main_items: tuple, copy_invocations: CopyInvocations, route: str, body: Any
) -> None:
    existing = _created("Existente")["id"]
    before = dynamodb_snapshot()
    calls = list(copy_invocations.calls)

    if route == "create":
        response = _create(body)
    else:
        response = handlers.rename_profile(
            api_event(EXAMINER, path={"id": existing}, body=body), None
        )

    if route == "rename" and isinstance(body, dict) and body.get("name") == "Perfil":
        # Rename reads only the name: whatever comes in source_profile_id is ignored.
        assert response["statusCode"] == 200, response["body"]
        assert _stored_profiles()[existing]["source_profile_id"] == MAIN_PROFILE_ID
    else:
        assert response["statusCode"] == 400, response["body"]
        assert dynamodb_snapshot() == before
    assert copy_invocations.calls == calls


@pytest.mark.parametrize("route", ["rename", "resume"])
@pytest.mark.parametrize(("user", "status"), [(EXAMINER, 404), (GUARDIAN, 403)])
def test_rn017_qa_path_id_above_1024_bytes(
    main_items: tuple, route: str, user: Any, status: int
) -> None:
    _created("Perfil")
    huge = "á" * 513  # 1026 bytes in UTF-8
    before = dynamodb_snapshot()
    event = api_event(user, path={"id": huge}, body={"name": "Outro"})

    call = handlers.rename_profile if route == "rename" else handlers.resume_copy
    response = call(event, None)

    assert response["statusCode"] == status
    if status == 404:
        assert response_json(response)["message"] == MSG_PROFILE_NOT_FOUND
    assert dynamodb_snapshot() == before


# --- concurrency and the limit ---------------------------------------------------


def test_rn017_qa_two_first_creates_at_the_same_time_both_stored(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    rival: dict[str, Any] = {}

    def rival_creates() -> None:
        rival["response"] = _create({"name": "Rival"})

    # Both read no profiles item; the rival's PutItem is stored first.
    before_dynamodb_call(monkeypatch, "PutItem", SETTINGS_TABLE_ENV, rival_creates)
    response = _create({"name": "Meu"})

    assert rival["response"]["statusCode"] == 202
    assert response["statusCode"] == 202, response["body"]
    names = sorted(profile["name"] for profile in _stored_profiles().values())
    assert names == ["Meu", "Rival"]
    assert len(copy_invocations.calls) == 2


def test_rn017_qa_two_first_creates_with_the_same_name_store_one(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    rival: dict[str, Any] = {}

    def rival_creates() -> None:
        rival["response"] = _create({"name": "Mesmo"})

    before_dynamodb_call(monkeypatch, "PutItem", SETTINGS_TABLE_ENV, rival_creates)
    response = _create({"name": "mesmo"})

    assert rival["response"]["statusCode"] == 202
    assert _message(response) == (409, MSG_PROFILE_NAME_TAKEN)
    assert [profile["name"] for profile in _stored_profiles().values()] == ["Mesmo"]
    assert len(copy_invocations.calls) == 1


def test_rn017_qa_create_racing_a_rename_to_the_same_name(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    existing = _created("Antigo")["id"]
    rival: dict[str, Any] = {}

    def rival_renames() -> None:
        rival["response"] = handlers.rename_profile(
            api_event(EXAMINER, path={"id": existing}, body={"name": "Disputado"}), None
        )

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, rival_renames)
    response = _create({"name": "DISPUTADO"})

    assert rival["response"]["statusCode"] == 200
    assert _message(response) == (409, MSG_PROFILE_NAME_TAKEN)
    assert [profile["name"] for profile in _stored_profiles().values()] == ["Disputado"]


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
def test_rn017_qa_rename_still_works_at_the_limit(main_items: tuple, user: Any) -> None:
    first = _created("Primeiro")["id"]
    _ready("Segundo")
    assert _message(_create({"name": "Terceiro"})) == (409, MSG_PROFILE_LIMIT)

    response = handlers.rename_profile(
        api_event(user, path={"id": first}, body={"name": "Terceiro"}), None
    )

    assert response["statusCode"] == 200
    assert response_json(response)["name"] == "Terceiro"


def test_rn017_qa_limit_counts_after_a_failed_start(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    copy_invocations.error_code = "ServiceException"
    _created("Primeiro")
    _created("Segundo")
    copy_invocations.error_code = None

    assert _message(_create({"name": "Terceiro"})) == (409, MSG_PROFILE_LIMIT)


# --- the requirements of a profile from a copy that ran in the background ----------


def test_rn017_qa_items_open_after_ready_for_every_examiner(main_items: tuple) -> None:
    profile_id = _created("Perfil")["id"]
    assert _run(profile_id)["outcome"] == "READY"

    for user in (EXAMINER, MASTER):
        created = requirement_handlers.create_requirement(
            api_event(
                user,
                body={
                    "profile_id": f"  {profile_id}  ",
                    "belt_id": AZUL,
                    "kind": "PRACTICE",
                    "category": "Ukemi",
                    "description": f"Item de {user.sub}",
                },
            ),
            None,
        )
        assert created["statusCode"] == 201, created["body"]
        assert response_json(created)["profile_id"] == profile_id
