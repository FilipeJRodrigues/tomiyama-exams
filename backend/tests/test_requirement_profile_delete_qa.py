"""QA coverage of the deletion of a requirement profile (RN017, #144, step 3b-2).

Edges the step's own tests do not reach: odd ids in the path, the items of a
profile read while it is being deleted and after it is gone, what the removal
frees, an event that asks for a removed profile, and the undo of the mark of
a profile whose copy was stalled.
"""

from collections.abc import Callable
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    MASTER,
    CopyInvocations,
    api_event,
    assert_service_busy,
    belt_id,
    dynamodb_snapshot,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain.requirement_profiles import MAIN_PROFILE_ID, MAX_PROFILES, MSG_PROFILE_NOT_FOUND
from domain.requirements import Requirement, RequirementKind
from handlers import events as event_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profile_delete as delete_worker
from handlers import requirement_profiles as handlers
from handlers import requirements as requirement_handlers
from repository import events as event_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository.tables import EVENTS_TABLE_ENV

NOW = "2026-11-13T12:00:00+00:00"
LATER = "2026-11-13T12:15:00+00:00"  # exactly COPY_STALL_SECONDS after NOW
CINZA = belt_id("Cinza")
DELETE_FUNCTION = "test-delete-requirement-profile"


@pytest.fixture
def set_now(monkeypatch: pytest.MonkeyPatch) -> Callable[[str], None]:
    current = {"now": NOW}
    monkeypatch.setattr(dates, "utc_now_iso", lambda: current["now"])

    def move(value: str) -> None:
        current["now"] = value

    return move


@pytest.fixture
def main_items(
    seeded: list, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    for number in (1, 2, 3):
        requirement_repo.create_requirement(
            Requirement(
                f"m-{number}", CINZA, RequirementKind.THEORY, "Vocabulário", "Rei", "x", number
            )
        )


def _create(name: str, **body: Any) -> dict[str, Any]:
    return handlers.create_profile(api_event(EXAMINER, body={"name": name, **body}), None)


def _ready(name: str = "Perfil do Sensei") -> str:
    created = _create(name)
    assert created["statusCode"] == 202, created["body"]
    profile_id = response_json(created)["id"]
    outcome = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert outcome["outcome"] == "READY"
    return profile_id


def _delete(profile_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.delete_profile(api_event(user, path={"id": profile_id}), None)


def _run_delete(profile_id: str) -> dict[str, Any]:
    return delete_worker.delete_profile_items(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )


def _message(response: dict[str, Any]) -> tuple[int, str]:
    return response["statusCode"], response_json(response)["message"]


def _list_items(profile_id: str) -> dict[str, Any]:
    return requirement_handlers.list_requirements(
        api_event(EXAMINER, query={"profile_id": profile_id}), None
    )


@pytest.mark.parametrize(
    "odd_id",
    [
        "MAIN",
        "Main",
        " main ",
        "main ",
        "#",
        ".",
        "..",
        "a.b",
        "profiles.main",
        "#profiles",
        " ",
        "x" * 1024,
        "x" * 1025,
        "ção ✓",
        "requirement_profiles",
        "version",
    ],
)
@pytest.mark.parametrize("user", [EXAMINER, MASTER])
def test_rn017_delete_with_an_odd_id_in_the_path_is_404_and_writes_nothing(
    main_items: None, copy_invocations: CopyInvocations, odd_id: str, user: Any
) -> None:
    # Only the exact id "main" is the main profile (403); anything else that
    # is not a stored profile is a 404, whatever characters it has: the id
    # goes into the expression as a name placeholder, never as a path.
    _ready()
    before = dynamodb_snapshot()
    calls = len(copy_invocations.calls)

    response = _delete(odd_id, user)

    assert _message(response) == (404, MSG_PROFILE_NOT_FOUND)
    assert dynamodb_snapshot() == before
    assert len(copy_invocations.calls) == calls


def test_rn017_items_of_a_profile_being_deleted_are_listed_until_it_is_gone(
    main_items: None, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    assert _delete(profile_id)["statusCode"] == 202

    # DELETING: still readable (the screen shows them read-only).
    listed = _list_items(profile_id)
    assert listed["statusCode"] == 200
    assert len(response_json(listed)) == 3
    assert {item["profile_id"] for item in response_json(listed)} == {profile_id}

    assert _run_delete(profile_id)["outcome"] == "DELETED"

    # Gone: the profile's 404, and the main profile's items are untouched.
    assert _message(_list_items(profile_id)) == (404, MSG_PROFILE_NOT_FOUND)
    main = response_json(_list_items(MAIN_PROFILE_ID))
    assert sorted(item["id"] for item in main) == ["m-1", "m-2", "m-3"]


def test_rn017_removal_frees_the_name_and_the_place_only_at_the_end(
    main_items: None, copy_invocations: CopyInvocations
) -> None:
    names = [f"Perfil {number}" for number in range(MAX_PROFILES - 1)]
    ids = [_ready(name) for name in names]
    assert _delete(ids[0])["statusCode"] == 202

    # While DELETING: the limit is full and the name is taken.
    assert _create("Outro nome")["statusCode"] == 409
    assert _create(names[0])["statusCode"] == 409

    assert _run_delete(ids[0])["outcome"] == "DELETED"

    # Removed: the same name is created again, with a new id and its own items.
    again = _create(names[0])
    assert again["statusCode"] == 202, again["body"]
    new_id = response_json(again)["id"]
    assert new_id not in ids
    outcome = copy_worker.copy_profile(
        new_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert (outcome["outcome"], outcome["written"]) == ("READY", 3)
    assert len(response_json(_list_items(new_id))) == 3
    # And the limit is full again.
    assert _create("Mais um")["statusCode"] == 409


@pytest.mark.parametrize("route", ["create", "change"])
def test_rn017_event_cannot_choose_a_removed_profile(
    main_items: None, copy_invocations: CopyInvocations, route: str
) -> None:
    profile_id = _ready()
    body = {"name": "Exame", "exam_date": "2027-03-20"}
    created = event_handlers.create_event(api_event(EXAMINER, body=body), None)
    assert created["statusCode"] == 201
    event_id = response_json(created)["id"]
    assert _delete(profile_id)["statusCode"] == 202
    assert _run_delete(profile_id)["outcome"] == "DELETED"

    chosen = {**body, "profile_id": profile_id}
    if route == "create":
        response = event_handlers.create_event(api_event(EXAMINER, body=chosen), None)
    else:
        response = event_handlers.update_event(
            api_event(EXAMINER, path={"id": event_id}, body=chosen), None
        )

    assert _message(response) == (404, MSG_PROFILE_NOT_FOUND)
    assert not event_repo.any_event_uses_profile(profile_id)
    assert [event.profile_id for event in event_repo.list_all()] == [MAIN_PROFILE_ID]


def test_rn017_mark_of_a_stalled_copy_is_undone_back_to_copying_not_ready(
    main_items: None,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A profile whose copy stalled has part of its items: if the events
    # cannot be read, the undo puts it back COPYING (resumable), never READY.
    created = _create("Perfil do Sensei")
    profile_id = response_json(created)["id"]
    set_now(LATER)
    before = profile_repo.get_profile(profile_id)
    stub = throttle_dynamodb(monkeypatch, "Scan", EVENTS_TABLE_ENV)

    response = _delete(profile_id)
    stub.active = False

    assert_service_busy(response, stub)
    after = profile_repo.get_profile(profile_id)
    assert after == before
    assert after is not None and after.status.value == "COPYING"
    assert [
        call for call in copy_invocations.calls if call["FunctionName"] == DELETE_FUNCTION
    ] == []
    # Still stalled, so the copy may be resumed, or the deletion asked again.
    resumed = handlers.resume_copy(api_event(EXAMINER, path={"id": profile_id}), None)
    assert resumed["statusCode"] == 202
