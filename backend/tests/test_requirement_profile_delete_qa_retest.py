"""QA coverage of the identity of the deletion mark (RN017, #144, step 3b-2, retest).

Edges of the ``delete_mark`` fix the step's own tests do not reach: a mark
stored without identity that is undone and written again with one, the status
a mark is undone to on each round of the route (stalled copy), a mark of
another request when the events cannot be read, the state left by a request
that gave up, a rival that confirms at a later time, and the internal fields
in every answer of the routes.
"""

import json
from collections.abc import Callable
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    CopyInvocations,
    api_event,
    assert_service_busy,
    belt_id,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain.errors import MSG_SERVICE_BUSY, ServiceUnavailableError
from domain.requirement_profiles import (
    MAIN_PROFILE_ID,
    MSG_PROFILE_IN_USE,
    MSG_PROFILES_BUSY,
    ProfileStatus,
    RequirementProfile,
    plan_deletion,
)
from domain.requirements import Requirement, RequirementKind
from handlers import events as event_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profile_delete as delete_worker
from handlers import requirement_profiles as handlers
from repository import events as event_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import EVENTS_TABLE_ENV, REQUIREMENTS_TABLE_ENV, SETTINGS_TABLE_ENV

NOW = "2026-11-13T12:00:00+00:00"
LATER = "2026-11-13T12:15:00+00:00"  # exactly COPY_STALL_SECONDS after NOW
MUCH_LATER = "2026-11-13T12:30:00+00:00"
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
    for number in (1, 2):
        requirement_repo.create_requirement(
            Requirement(
                f"m-{number}", CINZA, RequirementKind.THEORY, "Vocabulário", "Rei", "x", number
            )
        )


def _create(name: str = "Perfil do Sensei") -> dict[str, Any]:
    return handlers.create_profile(api_event(EXAMINER, body={"name": name}), None)


def _ready(name: str = "Perfil do Sensei") -> str:
    created = _create(name)
    assert created["statusCode"] == 202, created["body"]
    profile_id = response_json(created)["id"]
    outcome = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert outcome["outcome"] == "READY"
    return profile_id


def _delete(profile_id: str) -> dict[str, Any]:
    return handlers.delete_profile(api_event(EXAMINER, path={"id": profile_id}), None)


def _message(response: dict[str, Any]) -> tuple[int, str]:
    return response["statusCode"], response_json(response)["message"]


def _stored(profile_id: str) -> dict[str, Any]:
    item = tables.table(SETTINGS_TABLE_ENV).get_item(
        Key={"id": profile_repo.REQUIREMENT_PROFILES_ID}, ConsistentRead=True
    )["Item"]
    return item["profiles"][profile_id]


def _items(profile_id: str) -> list[str]:
    items = tables.paginate(tables.table(REQUIREMENTS_TABLE_ENV).scan, ConsistentRead=True)
    return sorted(item["id"] for item in items if item.get("profile_id") == profile_id)


def _mark(profile_id: str, now: str = NOW) -> tuple[RequirementProfile, ProfileStatus | None]:
    return profile_repo.begin_deletion(lambda stored: plan_deletion(stored, profile_id, now))


def _drop_identity(profile_id: str) -> None:
    """Leave the mark as one written by hand, without ``delete_mark``."""
    tables.table(SETTINGS_TABLE_ENV).update_item(
        Key={"id": profile_repo.REQUIREMENT_PROFILES_ID},
        UpdateExpression="REMOVE #profiles.#id.#mark",
        ExpressionAttributeNames={
            "#profiles": "profiles",
            "#id": profile_id,
            "#mark": "delete_mark",
        },
    )


def _event(profile_id: str) -> str:
    response = event_handlers.create_event(
        api_event(
            EXAMINER, body={"name": "Exame", "exam_date": "2027-03-20", "profile_id": profile_id}
        ),
        None,
    )
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)["id"]


def _delete_calls(invocations: CopyInvocations) -> list[str]:
    return [
        call["Payload"]["profile_id"]
        for call in invocations.calls
        if call["FunctionName"] == DELETE_FUNCTION
    ]


def _run_delete(profile_id: str) -> dict[str, Any]:
    return delete_worker.delete_profile_items(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )


def test_rn017_read_under_a_mark_without_identity_does_not_confirm_a_later_mark_with_one(
    main_items: None, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The request meets a mark stored without ``delete_mark`` and reads the
    # events (none). Meanwhile that mark is undone, an event chooses the
    # profile and another request marks it again (with an identity). "No
    # identity" must not match the new mark: the request reads again, finds
    # the event and refuses.
    profile_id = _ready()
    items = _items(profile_id)
    _mark(profile_id)
    _drop_identity(profile_id)
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []

    def read_events(asked_id: str) -> bool:
        found = real_read(asked_id)
        reads.append(found)
        if len(reads) == 1:
            assert profile_repo.cancel_deletion(profile_id, None, ProfileStatus.READY)
            _event(profile_id)
            assert _mark(profile_id)[0].delete_mark
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)

    assert _message(_delete(profile_id)) == (409, MSG_PROFILE_IN_USE)
    assert reads == [False, True]
    stored = _stored(profile_id)
    assert stored["status"] == "READY"
    assert not {"delete_checked", "delete_mark", "delete_updated_at"} & set(stored)
    assert _delete_calls(copy_invocations) == []
    assert _run_delete(profile_id)["outcome"] != "DELETED"
    assert _items(profile_id) == items


def test_rn017_mark_with_identity_is_not_touched_by_a_request_that_holds_none(
    main_items: None, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    mark = _mark(profile_id)[0].delete_mark
    marked = _stored(profile_id)

    assert not profile_repo.confirm_deletion(profile_id, None, LATER)
    assert not profile_repo.cancel_deletion(profile_id, None, ProfileStatus.READY)
    assert not profile_repo.confirm_deletion(profile_id, "", LATER)
    assert not profile_repo.confirm_deletion(profile_id, str(mark).upper(), LATER)

    assert _stored(profile_id) == marked
    # And the other way round: a mark without identity is not matched by any token.
    _drop_identity(profile_id)
    bare = _stored(profile_id)
    assert not profile_repo.confirm_deletion(profile_id, mark, LATER)
    assert not profile_repo.cancel_deletion(profile_id, mark, ProfileStatus.READY)
    assert _stored(profile_id) == bare


def test_rn017_stalled_copy_goes_back_to_copying_on_a_later_round_of_the_route(
    main_items: None,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Round 1: the request marks a stalled copy; another request undoes the
    # mark while it reads the events, so its confirmation fails. Round 2: it
    # marks again and the events cannot be read. The undo of the second mark
    # puts the profile back COPYING (never READY: it has part of its items).
    profile_id = response_json(_create())["id"]
    set_now(LATER)
    before = _stored(profile_id)
    assert before["status"] == "COPYING"
    real_read = event_repo.any_event_uses_profile
    marks: list[str] = []

    def read_events(asked_id: str) -> bool:
        marks.append(_stored(profile_id)["delete_mark"])
        if len(marks) == 1:
            found = real_read(asked_id)
            assert profile_repo.cancel_deletion(profile_id, marks[0], ProfileStatus.COPYING)
            return found
        raise ServiceUnavailableError(MSG_SERVICE_BUSY)

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)
    response = _delete(profile_id)

    assert _message(response) == (503, MSG_SERVICE_BUSY)
    assert len(marks) == 2 and marks[0] != marks[1]
    assert _stored(profile_id) == before
    assert _delete_calls(copy_invocations) == []
    resumed = handlers.resume_copy(api_event(EXAMINER, path={"id": profile_id}), None)
    assert resumed["statusCode"] == 202


def test_rn017_events_that_cannot_be_read_leave_the_mark_of_another_request_alone(
    main_items: None, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The mark is of another request (still unconfirmed): this one does not
    # undo it when its own read fails, and the next DELETE decides it.
    profile_id = _ready()
    _mark(profile_id)
    marked = _stored(profile_id)
    stub = throttle_dynamodb(monkeypatch, "Scan", EVENTS_TABLE_ENV)

    response = _delete(profile_id)
    stub.active = False

    assert_service_busy(response, stub)
    assert _stored(profile_id) == marked
    assert _delete_calls(copy_invocations) == []
    again = _delete(profile_id)
    assert again["statusCode"] == 202, again["body"]
    stored = _stored(profile_id)
    assert (stored["delete_checked"], stored["delete_mark"]) == (True, marked["delete_mark"])
    assert _delete_calls(copy_invocations) == [profile_id]


@pytest.mark.parametrize("event_uses_it", [False, True])
def test_rn017_request_that_gave_up_leaves_a_profile_the_next_delete_decides(
    main_items: None,
    copy_invocations: CopyInvocations,
    monkeypatch: pytest.MonkeyPatch,
    event_uses_it: bool,
) -> None:
    profile_id = _ready()
    if event_uses_it:
        _event(profile_id)
    items = _items(profile_id)
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []

    def read_events(asked_id: str) -> bool:
        found = real_read(asked_id)
        reads.append(found)
        assert profile_repo.cancel_deletion(
            profile_id, _stored(profile_id)["delete_mark"], ProfileStatus.READY
        )
        _mark(profile_id)
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)
    assert _message(_delete(profile_id)) == (409, MSG_PROFILES_BUSY)
    monkeypatch.setattr(event_repo, "any_event_uses_profile", real_read)

    assert reads == [event_uses_it] * handlers._DELETE_ATTEMPTS
    left = _stored(profile_id)
    assert left["status"] == "DELETING" and "delete_checked" not in left
    assert _delete_calls(copy_invocations) == []
    assert _run_delete(profile_id)["outcome"] != "DELETED"
    assert _items(profile_id) == items

    # The next DELETE, alone, decides under the mark that was left.
    response = _delete(profile_id)
    stored = _stored(profile_id)
    if event_uses_it:
        assert _message(response) == (409, MSG_PROFILE_IN_USE)
        assert stored["status"] == "READY" and "delete_mark" not in stored
        assert _delete_calls(copy_invocations) == []
        assert _items(profile_id) == items
    else:
        assert response["statusCode"] == 202, response["body"]
        assert (stored["delete_checked"], stored["delete_mark"]) == (True, left["delete_mark"])
        assert _delete_calls(copy_invocations) == [profile_id]
        assert _run_delete(profile_id)["outcome"] == "DELETED"


def test_rn017_rival_that_confirmed_later_is_answered_without_a_second_start(
    main_items: None, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The request keeps the time it started with for every round. A rival
    # that undid its mark, marked again and confirmed at a later time has a
    # sign of life "in the future" of this request: not stalled, nothing
    # claimed, nothing started, and the rival's stamp is kept.
    profile_id = _ready()
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []
    rival: dict[str, Any] = {}

    def read_events(asked_id: str) -> bool:
        found = real_read(asked_id)
        reads.append(found)
        assert profile_repo.cancel_deletion(
            profile_id, _stored(profile_id)["delete_mark"], ProfileStatus.READY
        )
        rival["mark"] = _mark(profile_id, MUCH_LATER)[0].delete_mark
        assert profile_repo.confirm_deletion(profile_id, rival["mark"], MUCH_LATER)
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)
    response = _delete(profile_id)

    assert reads == [False]
    assert response["statusCode"] == 202, response["body"]
    body = response_json(response)
    assert (body["status"], body["delete_updated_at"], body["delete_stalled"]) == (
        "DELETING",
        MUCH_LATER,
        False,
    )
    stored = _stored(profile_id)
    assert (stored["delete_checked"], stored["delete_mark"], stored["delete_updated_at"]) == (
        True,
        rival["mark"],
        MUCH_LATER,
    )
    assert _delete_calls(copy_invocations) == []  # the rival starts its own


def test_rn017_internal_fields_of_the_mark_are_in_no_answer(
    main_items: None, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    answers: list[dict[str, Any]] = []

    def keep(response: dict[str, Any]) -> dict[str, Any]:
        answers.append(response)
        return response

    def path(profile_id: str, **more: Any) -> dict[str, Any]:
        return api_event(EXAMINER, path={"id": profile_id}, **more)

    profile_id = _ready()
    used = _ready("Em uso")
    _event(used)
    marks: list[str] = []

    def seen() -> None:
        keep(handlers.list_profiles(api_event(EXAMINER), None))
        keep(handlers.get_profile(path(profile_id), None))
        keep(handlers.rename_profile(path(profile_id, body={"name": "Outro nome"}), None))
        keep(handlers.resume_copy(path(profile_id), None))

    # Unconfirmed mark (a request stopped there).
    marks.append(str(_mark(profile_id)[0].delete_mark))
    seen()
    # Refused (an event uses it) and undone; then marked, confirmed, repeated and resumed.
    assert keep(_delete(used))["statusCode"] == 409
    assert keep(_delete(profile_id))["statusCode"] == 202
    marks.append(_stored(profile_id)["delete_mark"])
    seen()
    assert keep(_delete(profile_id))["statusCode"] == 202
    set_now(MUCH_LATER)
    assert keep(_delete(profile_id))["statusCode"] == 202  # stalled: resumed
    seen()
    # A new profile copied while another is being deleted, and the main one.
    keep(handlers.create_profile(api_event(EXAMINER, body={"name": "Novo"}), None))
    keep(handlers.get_profile(path(MAIN_PROFILE_ID), None))

    assert len(answers) >= 16
    for response in answers:
        text = response["body"]
        assert "delete_mark" not in text and "delete_checked" not in text, text
        assert not any(mark in text for mark in marks), text
        json.loads(text)
    # The mark is stored (the check above is not vacuous).
    assert _stored(profile_id)["delete_mark"] in marks
