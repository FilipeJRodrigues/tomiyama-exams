"""Deleting a requirement profile, step 3b-2 of #144 (RN017, decision 5 of the card).

"A profile may be deleted only if no event uses it; the main one is never
deleted." Any examiner deletes a profile other than the main one. The items
are deleted in the background: the profile goes to ``DELETING`` (still
holding its name and its place in the limit), the route answers 202 and the
profile leaves the stored profiles when no item is left.

The order of the writes closes the races: the profile leaves ``READY`` in a
write conditioned on the ``version`` and the status read, and only then are
the events read. An event starts using a profile only in a transaction that
checks it is ``READY``, so that read finds every event that uses it.
"""

from collections.abc import Callable
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import (
    EXAMINER,
    GUARDIAN,
    MASTER,
    CopyInvocations,
    api_event,
    assert_service_busy,
    before_dynamodb_call,
    belt_id,
    dynamodb_snapshot,
    make_student,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain import requirement_profiles as profile_rules
from domain.belts import SEED_BELTS
from domain.errors import ConflictError, ForbiddenError, NotFoundError
from domain.events import MSG_EVENT_HAS_EXAMS, MSG_EVENT_PROFILE_DELETING, MSG_EVENT_PROFILE_LOCKED
from domain.requirement_profiles import (
    COPY_STALL_SECONDS,
    MAIN_PROFILE,
    MAIN_PROFILE_ID,
    MAX_PROFILES,
    MSG_DELETE_COPY_IN_PROGRESS,
    MSG_MAIN_PROFILE_DELETE,
    MSG_PROFILE_DELETING,
    MSG_PROFILE_IN_USE,
    MSG_PROFILE_IS_COPY_SOURCE,
    MSG_PROFILE_ITEMS_DELETING,
    MSG_PROFILE_LIMIT,
    MSG_PROFILE_NAME_TAKEN,
    MSG_PROFILE_NOT_FOUND,
    MSG_PROFILES_BUSY,
    MSG_SOURCE_PROFILE_DELETING,
    ProfileStatus,
    RequirementProfile,
    check_can_delete,
    plan_deletion,
)
from domain.requirements import Requirement, RequirementKind, copied_requirement_id
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profile_delete as delete_worker
from handlers import requirement_profiles as handlers
from handlers import requirements as requirement_handlers
from repository import events as event_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository import tables
from repository.requirements import ProfileItemDeletion
from repository.tables import (
    EVENTS_TABLE_ENV,
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    DeadlineExceededError,
)

NOW = "2026-11-13T12:00:00+00:00"
LATER = "2026-11-13T12:15:00+00:00"  # exactly COPY_STALL_SECONDS after NOW
ALMOST = "2026-11-13T12:14:59+00:00"
MUCH_LATER = "2026-11-13T12:30:00+00:00"
TODAY = date(2026, 11, 1)
CINZA = belt_id("Cinza")
AZUL = belt_id("Azul")
DELETE_FUNCTION = "test-delete-requirement-profile"
# Decision 5 of #144 and the task's wording.
MAIN_MESSAGE = "O perfil principal não pode ser excluído"
IN_USE_MESSAGE = "O perfil é usado por um evento e não pode ser excluído"

MAIN_ITEMS = (
    Requirement(
        "m-cinza-1", CINZA, RequirementKind.THEORY, "Vocabulário", "Contar até 3", "Ichi", 1
    ),
    Requirement("m-cinza-2", CINZA, RequirementKind.PRACTICE, "Nage-waza", "O-soto-gari", None, 2),
    Requirement("m-cinza-3", CINZA, RequirementKind.THEORY, "Histórico", "Fundador", "Kano", 3),
    Requirement("m-azul-1", AZUL, RequirementKind.PRACTICE, "Ukemi", "Mae-ukemi", None, 1),
    Requirement("m-azul-2", AZUL, RequirementKind.THEORY, "Vocabulário", "Hajime", "Começar", 2),
)


class FakeClock:
    """Monotonic clock moved only by ``sleep``."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def set_now(monkeypatch: pytest.MonkeyPatch) -> Callable[[str], None]:
    """Freeze ``dates.utc_now_iso`` at NOW; the returned function moves it."""
    current = {"now": NOW}
    monkeypatch.setattr(dates, "utc_now_iso", lambda: current["now"])
    monkeypatch.setattr(dates, "today", lambda: TODAY)

    def move(value: str) -> None:
        current["now"] = value

    return move


@pytest.fixture
def main_items(
    seeded: list, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> tuple[Requirement, ...]:
    """Five items of the main profile (Cinza and Azul), one of them with answers."""
    for item in MAIN_ITEMS:
        requirement_repo.create_requirement(item)
    tables.table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": "m-cinza-2"},
        UpdateExpression="SET answer_count = :n",
        ExpressionAttributeValues={":n": 3},
    )
    return MAIN_ITEMS


@pytest.fixture
def room_for_one_more(monkeypatch: pytest.MonkeyPatch) -> None:
    """Raise the limit of profiles by one, for rules that need a third stored profile."""
    monkeypatch.setattr(profile_rules, "MAX_PROFILES", MAX_PROFILES + 1)


# --- helpers ------------------------------------------------------------------


def _create(body: Any, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.create_profile(api_event(user, body=body), None)


def _created(name: str = "Perfil do Sensei", **body: Any) -> dict[str, Any]:
    response = _create({"name": name, **body})
    assert response["statusCode"] == 202, response["body"]
    return response_json(response)


def _run_copy(profile_id: str, **options: Any) -> dict[str, Any]:
    options.setdefault("items_per_second", 1_000_000)
    options.setdefault("sleep", lambda _seconds: None)
    return copy_worker.copy_profile(profile_id, **options)


def _ready(name: str = "Perfil do Sensei", **body: Any) -> str:
    created = _created(name, **body)
    assert _run_copy(created["id"])["outcome"] == "READY"
    return created["id"]


def _delete(profile_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.delete_profile(api_event(user, path={"id": profile_id}), None)


def _deleting(name: str = "Perfil do Sensei") -> str:
    """A ready profile whose deletion was asked for and confirmed (not run yet)."""
    profile_id = _ready(name)
    response = _delete(profile_id)
    assert response["statusCode"] == 202, response["body"]
    return profile_id


def _run_delete(profile_id: str, **options: Any) -> dict[str, Any]:
    options.setdefault("items_per_second", 1_000_000)
    options.setdefault("sleep", lambda _seconds: None)
    return delete_worker.delete_profile_items(profile_id, **options)


def _get(profile_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.get_profile(api_event(user, path={"id": profile_id}), None)


def _listed() -> list[dict[str, Any]]:
    return response_json(handlers.list_profiles(api_event(EXAMINER), None))


def _message(response: dict[str, Any]) -> tuple[int, str]:
    return response["statusCode"], response_json(response)["message"]


def _profiles_item() -> dict[str, Any]:
    return tables.table(SETTINGS_TABLE_ENV).get_item(
        Key={"id": profile_repo.REQUIREMENT_PROFILES_ID}, ConsistentRead=True
    )["Item"]


def _stored(profile_id: str) -> dict[str, Any] | None:
    return _profiles_item()["profiles"].get(profile_id)


def _raw(requirement_id: str) -> dict[str, Any] | None:
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )


def _raw_items(profile_id: str) -> list[dict[str, Any]]:
    """Every stored item of a profile, read from the table (not the index)."""
    items = tables.paginate(tables.table(REQUIREMENTS_TABLE_ENV).scan, ConsistentRead=True)
    return sorted(
        (item for item in items if item.get("profile_id", MAIN_PROFILE_ID) == profile_id),
        key=lambda item: item["id"],
    )


def _item_body(profile_id: str, **changes: Any) -> dict[str, Any]:
    return {
        "belt_id": CINZA,
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Rei",
        "expected_answer": "Saudação",
        "profile_id": profile_id,
        **changes,
    }


def _event_body(**overrides: Any) -> dict[str, Any]:
    return {"name": "Exame março/2027", "exam_date": "2027-03-20", **overrides}


def _post_event(**overrides: Any) -> dict[str, Any]:
    return event_handlers.create_event(api_event(EXAMINER, body=_event_body(**overrides)), None)


def _event(**overrides: Any) -> str:
    response = _post_event(**overrides)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)["id"]


def _put_event(event_id: str, **overrides: Any) -> dict[str, Any]:
    return event_handlers.update_event(
        api_event(EXAMINER, path={"id": event_id}, body=_event_body(**overrides)), None
    )


def _delete_calls(invocations: CopyInvocations) -> list[str]:
    """The profile ids of the invocations of the delete function, in order."""
    for call in invocations.calls:
        assert call["InvocationType"] == "Event"
    return [
        call["Payload"]["profile_id"]
        for call in invocations.calls
        if call["FunctionName"] == DELETE_FUNCTION
    ]


# --- model ----------------------------------------------------------------------


def test_rn017_deletion_is_stalled_after_fifteen_minutes_without_sign_of_life() -> None:
    deleting = RequirementProfile(
        id="p1", name="A", is_main=False, status=ProfileStatus.DELETING, delete_updated_at=NOW
    )

    assert COPY_STALL_SECONDS == 15 * 60
    assert not deleting.is_delete_stalled(ALMOST)
    assert deleting.is_delete_stalled(LATER)
    # Never started (no sign of life): stalled at once.
    never = RequirementProfile(id="p2", name="B", is_main=False, status=ProfileStatus.DELETING)
    assert never.is_delete_stalled(NOW)
    # Only a profile being deleted is ever stalled in its deletion, and it is not a stalled copy.
    assert not MAIN_PROFILE.is_delete_stalled(LATER)
    assert not replace(deleting, status=ProfileStatus.COPYING).is_delete_stalled(LATER)
    assert not never.is_copy_stalled(LATER)


def test_rn017_main_profile_is_never_deletable() -> None:
    with pytest.raises(ForbiddenError, match=MAIN_MESSAGE):
        check_can_delete(MAIN_PROFILE_ID)
    check_can_delete("p1")
    assert MSG_MAIN_PROFILE_DELETE == MAIN_MESSAGE
    assert MSG_PROFILE_IN_USE == IN_USE_MESSAGE


def test_rn017_plan_deletion_checks_the_copy_and_the_copies_from_it() -> None:
    ready = RequirementProfile(id="a", name="A", is_main=False)
    live = RequirementProfile(
        id="b", name="B", is_main=False, status=ProfileStatus.COPYING, copy_updated_at=NOW
    )
    from_a = replace(live, id="c", name="C", source_profile_id="a")

    with pytest.raises(NotFoundError, match=MSG_PROFILE_NOT_FOUND):
        plan_deletion({}, "a", NOW)
    planned = plan_deletion({"a": ready}, "a", NOW)
    assert (planned.status, planned.delete_updated_at, planned.delete_checked) == (
        ProfileStatus.DELETING,
        NOW,
        False,
    )
    # Its own copy: refused while alive, allowed once stalled.
    with pytest.raises(ConflictError, match=MSG_DELETE_COPY_IN_PROGRESS):
        plan_deletion({"b": live}, "b", ALMOST)
    assert plan_deletion({"b": live}, "b", LATER).status is ProfileStatus.DELETING
    # A copy from it, alive or stalled (it may be resumed), refuses the deletion.
    for now in (NOW, LATER):
        with pytest.raises(ConflictError, match="copiado para outro perfil"):
            plan_deletion({"a": ready, "c": from_a}, "a", now)
    # Once that copy is ready, or is itself being deleted, nothing reads the items.
    for status in (ProfileStatus.READY, ProfileStatus.DELETING):
        others = {"a": ready, "c": replace(from_a, status=status)}
        assert plan_deletion(others, "a", NOW).status is ProfileStatus.DELETING
    # Already being deleted: returned as stored, with its own sign of life.
    deleting = replace(
        ready, status=ProfileStatus.DELETING, delete_updated_at=NOW, delete_checked=True
    )
    assert plan_deletion({"a": deleting}, "a", LATER) is deleting


def test_rn017_delete_fields_are_stored_and_read_back() -> None:
    profile = RequirementProfile(
        id="p1",
        name="A",
        is_main=False,
        status=ProfileStatus.DELETING,
        delete_updated_at=NOW,
        delete_checked=True,
    )

    item = profile.to_item()
    assert (item["status"], item["delete_updated_at"], item["delete_checked"]) == (
        "DELETING",
        NOW,
        True,
    )
    assert RequirementProfile.from_item("p1", item) == profile
    # A profile that is not being deleted stores neither field.
    plain = RequirementProfile(id="p2", name="B", is_main=False).to_item()
    assert "delete_checked" not in plain and "delete_updated_at" not in plain
    # The confirmation is not part of the JSON.
    body = profile.to_dict(NOW)
    assert "delete_checked" not in body
    assert (body["delete_updated_at"], body["delete_stalled"], body["copy_stalled"]) == (
        NOW,
        False,
        False,
    )


# --- DELETE /requirement-profiles/{id}: refusals --------------------------------


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
def test_rn017_main_profile_is_never_deleted(
    main_items: tuple, copy_invocations: CopyInvocations, user: Any
) -> None:
    _ready()
    before = dynamodb_snapshot()

    response = _delete(MAIN_PROFILE_ID, user)

    assert _message(response) == (403, MAIN_MESSAGE)
    assert dynamodb_snapshot() == before
    assert _delete_calls(copy_invocations) == []


@pytest.mark.parametrize(
    ("user", "status"), [(GUARDIAN, 403), (None, 401)], ids=["guardian", "anonymous"]
)
@pytest.mark.parametrize("target", ["stored", "main", "unknown"])
def test_rn017_delete_profile_is_for_examiners_only(
    main_items: tuple, copy_invocations: CopyInvocations, user: Any, status: int, target: str
) -> None:
    profile_id = {"stored": _ready(), "main": MAIN_PROFILE_ID, "unknown": "nao-existe"}[target]
    before = dynamodb_snapshot()

    response = _delete(profile_id, user)

    # The role comes before everything else: the main profile and an unknown id included.
    assert response["statusCode"] == status
    assert dynamodb_snapshot() == before
    assert _delete_calls(copy_invocations) == []


@pytest.mark.parametrize("profile_id", ["nao-existe", "main ", "MAIN", " ", "x" * 1025])
def test_rn017_delete_unknown_profile_is_404(
    main_items: tuple, copy_invocations: CopyInvocations, profile_id: str
) -> None:
    _ready()
    before = dynamodb_snapshot()

    assert _message(_delete(profile_id)) == (404, MSG_PROFILE_NOT_FOUND)
    assert dynamodb_snapshot() == before
    assert _delete_calls(copy_invocations) == []


def test_rn017_delete_without_any_stored_profile_is_404(seeded: list) -> None:
    assert _message(_delete("nao-existe")) == (404, MSG_PROFILE_NOT_FOUND)


@pytest.mark.parametrize("status", ["OPEN", "CLOSED"])
def test_rn017_profile_used_by_an_event_is_not_deleted(
    main_items: tuple, copy_invocations: CopyInvocations, status: str
) -> None:
    profile_id = _ready()
    other = _ready("Outro perfil")
    _event(name="Do outro perfil", profile_id=other)
    _event(name="Do perfil", profile_id=profile_id, status=status)
    items = _raw_items(profile_id)
    stored = _stored(profile_id)

    response = _delete(profile_id)

    assert _message(response) == (409, IN_USE_MESSAGE)
    # Nothing deleted, and the profile is READY again, as it was.
    assert _raw_items(profile_id) == items
    assert _stored(profile_id) == stored
    assert response_json(_get(profile_id))["status"] == "READY"
    assert _delete_calls(copy_invocations) == []
    # It works as before: its items change and another event may choose it.
    created = requirement_handlers.create_requirement(
        api_event(EXAMINER, body=_item_body(profile_id)), None
    )
    assert created["statusCode"] == 201
    assert _post_event(name="Outro evento", profile_id=profile_id)["statusCode"] == 201


def test_rn017_events_of_other_profiles_and_old_events_do_not_block_the_deletion(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    other = _ready("Outro perfil")
    _event(name="Do principal")
    _event(name="Do outro perfil", profile_id=other)
    # Events stored before the profiles existed: no profile_id, or a blank one (main).
    events = tables.table(EVENTS_TABLE_ENV)
    for event_id, extra in (("antigo-1", {}), ("antigo-2", {"profile_id": ""})):
        events.put_item(
            Item={
                "id": event_id,
                "name": "Exame antigo",
                "exam_date": "2026-03-20",
                "status": "CLOSED",
                "created_at": NOW,
                "updated_at": NOW,
                **extra,
            }
        )

    response = _delete(profile_id)

    assert response["statusCode"] == 202, response["body"]
    assert _delete_calls(copy_invocations) == [profile_id]


def test_rn017_event_that_left_the_profile_no_longer_blocks_the_deletion(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    moved = _event(name="Trocou de perfil", profile_id=profile_id)
    removed = _event(name="Excluído", profile_id=profile_id)
    assert _message(_delete(profile_id)) == (409, IN_USE_MESSAGE)

    assert _put_event(moved, profile_id=MAIN_PROFILE_ID)["statusCode"] == 200
    deleted = event_handlers.delete_event(api_event(EXAMINER, path={"id": removed}), None)
    assert deleted["statusCode"] == 204

    assert _delete(profile_id)["statusCode"] == 202


def test_rn017_event_with_exams_keeps_its_profile_so_a_free_profile_has_no_answers(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    # The premise of deleting the items without looking at their answers: an
    # exam (and so an answer) pins its event to the profile, and the event
    # pins the profile.
    profile_id = _ready()
    event_id = _event(name="Com exame", profile_id=profile_id)
    student_repo.create_student(make_student())
    attended = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": "student-1"}), None
    )
    assert attended["statusCode"] == 201, attended["body"]

    moved = _put_event(event_id, profile_id=MAIN_PROFILE_ID)
    removed = event_handlers.delete_event(api_event(EXAMINER, path={"id": event_id}), None)

    assert _message(moved) == (409, MSG_EVENT_PROFILE_LOCKED)
    assert _message(removed) == (409, MSG_EVENT_HAS_EXAMS)
    assert _message(_delete(profile_id)) == (409, IN_USE_MESSAGE)
    assert response_json(_get(profile_id))["status"] == "READY"


def test_rn017_profile_being_copied_to_another_is_not_deleted(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    source = _ready("Origem")
    copy = _created("Cópia da origem", source_profile_id=source)["id"]
    before = dynamodb_snapshot()

    assert _message(_delete(source)) == (409, MSG_PROFILE_IS_COPY_SOURCE)
    # Also when that copy is stalled: it may still be resumed.
    set_now(LATER)
    assert _message(_delete(source)) == (409, MSG_PROFILE_IS_COPY_SOURCE)
    assert dynamodb_snapshot() == before
    assert _delete_calls(copy_invocations) == []

    # Once the copy has finished, the source may go.
    assert _run_copy(copy)["outcome"] == "READY"
    assert _delete(source)["statusCode"] == 202
    assert len(_raw_items(copy)) == len(MAIN_ITEMS)


def test_rn017_deleting_the_stalled_copy_frees_its_source(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    source = _ready("Origem")
    copy = _created("Cópia da origem", source_profile_id=source)["id"]
    set_now(LATER)

    assert _delete(copy)["statusCode"] == 202
    # The copy is on its way out: it no longer reads the source's items.
    assert _delete(source)["statusCode"] == 202
    assert _delete_calls(copy_invocations) == [copy, source]


def test_rn017_profile_whose_copy_is_running_is_not_deleted(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    profile_id = _created()["id"]
    set_now(ALMOST)
    before = dynamodb_snapshot()

    response = _delete(profile_id)

    assert _message(response) == (409, MSG_DELETE_COPY_IN_PROGRESS)
    assert dynamodb_snapshot() == before
    assert _delete_calls(copy_invocations) == []


@pytest.mark.parametrize("stalled", ["quiet for 15 min", "never started"])
def test_rn017_profile_whose_copy_stalled_is_deleted(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    stalled: str,
) -> None:
    if stalled == "never started":
        copy_invocations.error_code = "TooManyRequestsException"
        profile_id = _created()["id"]
        copy_invocations.error_code = None
    else:
        profile_id = _created()["id"]
        clock = FakeClock()
        with pytest.raises(DeadlineExceededError):
            _run_copy(profile_id, items_per_second=1, deadline=1.5, sleep=clock.sleep, clock=clock)
        assert len(_raw_items(profile_id)) == 2  # a copy that stopped halfway
        set_now(LATER)

    response = _delete(profile_id)

    assert response["statusCode"] == 202, response["body"]
    assert response_json(response)["status"] == "DELETING"
    assert _run_delete(profile_id)["outcome"] == "DELETED"
    assert _raw_items(profile_id) == []
    assert [profile["id"] for profile in _listed()] == [MAIN_PROFILE_ID]
    # The place is free again.
    assert _create({"name": "Outro"})["statusCode"] == 202


def test_rn017_delete_profile_order_of_checks(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    source = _ready("Origem")
    _event(name="Do perfil", profile_id=source)
    _created("Cópia da origem", source_profile_id=source)

    # 401/403 of the role, 403 of the main profile, 404, then the 409s: the
    # copy from it comes before the event that uses it.
    assert _delete(MAIN_PROFILE_ID, GUARDIAN)["statusCode"] == 403
    assert _message(_delete(MAIN_PROFILE_ID)) == (403, MAIN_MESSAGE)
    assert _message(_delete("nao-existe")) == (404, MSG_PROFILE_NOT_FOUND)
    assert _message(_delete(source)) == (409, MSG_PROFILE_IS_COPY_SOURCE)


# --- DELETE /requirement-profiles/{id}: 202 and the DELETING status --------------


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
def test_rn017_any_examiner_deletes_a_profile_in_the_background(
    main_items: tuple, copy_invocations: CopyInvocations, user: Any
) -> None:
    profile_id = _ready()  # created by EXAMINER: anyone deletes it, not only its creator
    ready = response_json(_get(profile_id))
    items = _raw_items(profile_id)
    version = _profiles_item()["version"]

    response = _delete(profile_id, user)

    body = response_json(response)
    assert response["statusCode"] == 202
    # The same format as the POST's 202: the profile, now DELETING.
    assert body == {
        **ready,
        "status": "DELETING",
        "delete_updated_at": NOW,
        "delete_stalled": False,
    }
    assert set(body) == {
        "id",
        "name",
        "is_main",
        "status",
        "source_profile_id",
        "created_by",
        "created_at",
        "copy_updated_at",
        "copied_items",
        "total_items",
        "copy_stalled",
        "delete_updated_at",
        "delete_stalled",
    }
    # The items go in the background: one asynchronous invocation, nothing deleted yet.
    assert copy_invocations.calls[-1] == {
        "FunctionName": DELETE_FUNCTION,
        "InvocationType": "Event",
        "Payload": {"profile_id": profile_id},
    }
    assert _delete_calls(copy_invocations) == [profile_id]
    assert _raw_items(profile_id) == items
    stored = _stored(profile_id)
    assert (stored["status"], stored["delete_checked"], stored["delete_updated_at"]) == (
        "DELETING",
        True,
        NOW,
    )
    assert _profiles_item()["version"] == version + 1
    # GET shows it, alone and in the list.
    assert response_json(_get(profile_id)) == body
    assert [(profile["id"], profile["status"]) for profile in _listed()] == [
        (MAIN_PROFILE_ID, "READY"),
        (profile_id, "DELETING"),
    ]


def test_rn017_main_profile_shows_no_deletion(main_items: tuple) -> None:
    main = _listed()[0]

    assert (main["id"], main["delete_updated_at"], main["delete_stalled"]) == (
        MAIN_PROFILE_ID,
        None,
        False,
    )


def test_rn017_profile_being_deleted_still_counts_in_the_limit_and_holds_its_name(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ready("Fica")
    profile_id = _deleting("Sai")

    # Main + "Fica" + "Sai" (DELETING): the limit of three is reached.
    assert _message(_create({"name": "Novo"})) == (409, MSG_PROFILE_LIMIT)
    assert _message(_create({"name": "sai"})) == (409, MSG_PROFILE_LIMIT)
    # With room, the name is still taken.
    monkeypatch.setattr(profile_rules, "MAX_PROFILES", MAX_PROFILES + 1)
    assert _message(_create({"name": "SAÍ"})) == (409, MSG_PROFILE_NAME_TAKEN)
    monkeypatch.setattr(profile_rules, "MAX_PROFILES", MAX_PROFILES)

    version = _profiles_item()["version"]
    assert _run_delete(profile_id)["outcome"] == "DELETED"

    # Removed from the stored profiles with version + 1: the name and the place are free.
    assert _stored(profile_id) is None
    assert _profiles_item()["version"] == version + 1
    assert _message(_get(profile_id)) == (404, MSG_PROFILE_NOT_FOUND)
    created = _create({"name": "Sai"})
    assert created["statusCode"] == 202
    assert sorted(profile["name"] for profile in _listed()) == ["Fica", "Principal", "Sai"]


def test_rn017_items_of_a_profile_being_deleted_cannot_change(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()
    copy_id = copied_requirement_id(profile_id, "m-cinza-1")
    copy = _raw(copy_id)
    before = dynamodb_snapshot()

    for user in (EXAMINER, MASTER):
        created = requirement_handlers.create_requirement(
            api_event(user, body=_item_body(profile_id)), None
        )
        edited = requirement_handlers.update_requirement(
            api_event(
                user,
                path={"id": copy_id},
                body={**_item_body(profile_id), "description": "X", "sort_order": 1},
            ),
            None,
        )
        deleted = requirement_handlers.delete_requirement(
            api_event(user, path={"id": copy_id}), None
        )
        for response in (created, edited, deleted):
            assert _message(response) == (409, MSG_PROFILE_ITEMS_DELETING)
    assert dynamodb_snapshot() == before
    assert _raw(copy_id) == copy
    # Listing stays open: what is left of the profile.
    listed = requirement_handlers.list_requirements(
        api_event(EXAMINER, query={"profile_id": profile_id}), None
    )
    assert listed["statusCode"] == 200
    assert len(response_json(listed)) == len(MAIN_ITEMS)


def test_rn017_profile_being_deleted_is_not_renamed_copied_from_nor_resumed(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()
    before = dynamodb_snapshot()
    invocations = len(copy_invocations.calls)

    renamed = handlers.rename_profile(
        api_event(EXAMINER, path={"id": profile_id}, body={"name": "Outro nome"}), None
    )
    same_name = handlers.rename_profile(
        api_event(EXAMINER, path={"id": profile_id}, body={"name": "Perfil do Sensei"}), None
    )
    copied = _create({"name": "Cópia", "source_profile_id": profile_id})
    resumed = handlers.resume_copy(api_event(EXAMINER, path={"id": profile_id}), None)

    assert _message(renamed) == (409, MSG_PROFILE_DELETING)
    assert _message(same_name) == (409, MSG_PROFILE_DELETING)
    assert _message(copied) == (409, MSG_SOURCE_PROFILE_DELETING)
    assert _message(resumed) == (409, MSG_PROFILE_DELETING)
    assert dynamodb_snapshot() == before
    assert len(copy_invocations.calls) == invocations


def test_rn017_profile_being_deleted_is_not_chosen_by_an_event(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()
    event_id = _event(name="Do principal")
    before = dynamodb_snapshot()

    created = _post_event(name="Novo", profile_id=profile_id)
    changed = _put_event(event_id, profile_id=profile_id)

    assert MSG_EVENT_PROFILE_DELETING == (
        "O perfil está sendo excluído e não pode ser usado em um evento."
    )
    assert _message(created) == (409, MSG_EVENT_PROFILE_DELETING)
    assert _message(changed) == (409, MSG_EVENT_PROFILE_DELETING)
    assert dynamodb_snapshot() == before


@pytest.mark.parametrize("route", ["create", "change"])
def test_rn017_event_write_that_meets_the_deletion_says_the_profile_is_being_deleted(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    # The handler read the profile READY; the deletion is marked before the
    # event's transaction, whose ConditionCheck then refuses the event.
    profile_id = _ready()
    event_id = _event(name="Do principal")
    deleted: dict[str, Any] = {}

    def delete_now() -> None:
        deleted["response"] = _delete(profile_id)

    before_dynamodb_call(monkeypatch, "TransactWriteItems", EVENTS_TABLE_ENV, delete_now)
    if route == "create":
        response = _post_event(name="Novo", profile_id=profile_id)
    else:
        response = _put_event(event_id, profile_id=profile_id)

    assert deleted["response"]["statusCode"] == 202
    assert _message(response) == (409, MSG_EVENT_PROFILE_DELETING)
    assert not event_repo.any_event_uses_profile(profile_id)
    assert _run_delete(profile_id)["outcome"] == "DELETED"


# --- DELETE repeated -------------------------------------------------------------


def test_rn017_delete_repeated_while_the_deletion_is_alive_is_202_and_starts_nothing(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    profile_id = _deleting()
    set_now(ALMOST)
    before = dynamodb_snapshot()

    response = _delete(profile_id, MASTER)

    body = response_json(response)
    assert response["statusCode"] == 202
    assert (body["status"], body["delete_updated_at"], body["delete_stalled"]) == (
        "DELETING",
        NOW,
        False,
    )
    assert dynamodb_snapshot() == before
    assert _delete_calls(copy_invocations) == [profile_id]


def test_rn017_delete_repeated_on_a_stalled_deletion_resumes_it(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    profile_id = _deleting()
    set_now(LATER)
    stalled = response_json(_get(profile_id))
    assert (stalled["status"], stalled["delete_stalled"]) == ("DELETING", True)

    response = _delete(profile_id)

    body = response_json(response)
    assert response["statusCode"] == 202
    assert (body["delete_updated_at"], body["delete_stalled"]) == (LATER, False)
    assert _stored(profile_id)["delete_updated_at"] == LATER
    assert _delete_calls(copy_invocations) == [profile_id, profile_id]
    # Alive again: one more DELETE starts nothing.
    assert _delete(profile_id)["statusCode"] == 202
    assert _delete_calls(copy_invocations) == [profile_id, profile_id]


def test_rn017_resumed_deletion_does_not_read_the_events_again(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Confirmed once, the deletion is never cancelled: items may be gone already.
    profile_id = _deleting()
    set_now(LATER)
    stub = throttle_dynamodb(monkeypatch, "Scan", EVENTS_TABLE_ENV)

    assert _delete(profile_id)["statusCode"] == 202
    assert stub.calls == []


def test_rn017_two_repeated_deletes_at_the_same_time_start_one_deletion(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_id = _deleting()
    set_now(LATER)
    rival: dict[str, Any] = {}

    def resume_first() -> None:
        rival["response"] = _delete(profile_id)

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, resume_first)
    response = _delete(profile_id)

    assert rival["response"]["statusCode"] == 202
    assert response["statusCode"] == 202
    assert response_json(response)["delete_stalled"] is False
    assert _delete_calls(copy_invocations) == [profile_id, profile_id]  # the first and one resume


def test_rn017_deletion_that_could_not_start_is_202_stalled_and_resumed_at_once(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    copy_invocations.error_code = "TooManyRequestsException"

    response = _delete(profile_id)

    body = response_json(response)
    assert response["statusCode"] == 202
    assert (body["status"], body["delete_updated_at"], body["delete_stalled"]) == (
        "DELETING",
        None,
        True,
    )
    stored = _stored(profile_id)
    assert "delete_updated_at" not in stored
    assert stored["delete_checked"] is True
    assert response_json(_get(profile_id))["delete_stalled"] is True

    # Repeating the DELETE resumes it at once, without waiting for the stall time...
    resumed_without_lambda = _delete(profile_id)
    assert _message(resumed_without_lambda)[0] == 503  # ...unless it still cannot be started
    assert response_json(_get(profile_id))["delete_stalled"] is True
    copy_invocations.error_code = None
    resumed = _delete(profile_id)
    assert resumed["statusCode"] == 202
    assert response_json(resumed)["delete_stalled"] is False
    assert _delete_calls(copy_invocations) == [profile_id]


def test_rn017_deletion_whose_start_and_mark_both_fail_shows_stalled_later(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_id = _ready()
    copy_invocations.error_code = "TooManyRequestsException"
    stub = throttle_dynamodb(
        monkeypatch,
        "UpdateItem",
        SETTINGS_TABLE_ENV,
        matches=lambda params: params["UpdateExpression"].startswith("REMOVE #profiles.#id.#del"),
    )

    response = _delete(profile_id)

    body = response_json(response)
    assert len(stub.calls) == 1
    assert response["statusCode"] == 202
    assert (body["delete_updated_at"], body["delete_stalled"]) == (NOW, False)
    stub.active = False
    set_now(LATER)
    assert response_json(_get(profile_id))["delete_stalled"] is True


def test_rn017_delete_repeated_after_the_profile_is_gone_is_404(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()
    assert _run_delete(profile_id)["outcome"] == "DELETED"

    assert _message(_delete(profile_id)) == (404, MSG_PROFILE_NOT_FOUND)


def test_rn017_resume_that_finds_the_deletion_finished_is_404(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_id = _deleting()
    set_now(LATER)
    before_dynamodb_call(
        monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, lambda: _run_delete(profile_id)
    )

    assert _message(_delete(profile_id)) == (404, MSG_PROFILE_NOT_FOUND)
    assert _delete_calls(copy_invocations) == [profile_id]


# --- races -----------------------------------------------------------------------


@pytest.mark.parametrize("route", ["create", "change"])
def test_rn017_event_that_takes_the_profile_before_the_mark_is_found_by_the_deletion(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    # The deletion read the profiles (no event yet); an event takes the
    # profile; the mark is written; the events, read after it, show the event.
    profile_id = _ready()
    event_id = _event(name="Do principal")
    items = _raw_items(profile_id)
    taken: dict[str, Any] = {}

    def take_profile() -> None:
        if route == "create":
            taken["response"] = _post_event(name="Novo", profile_id=profile_id)
        else:
            taken["response"] = _put_event(event_id, profile_id=profile_id)

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, take_profile)
    response = _delete(profile_id)

    assert taken["response"]["statusCode"] in (200, 201), taken["response"]["body"]
    assert _message(response) == (409, IN_USE_MESSAGE)
    assert response_json(_get(profile_id))["status"] == "READY"
    assert "delete_updated_at" not in _stored(profile_id)
    assert _raw_items(profile_id) == items
    assert _delete_calls(copy_invocations) == []


@pytest.mark.parametrize("route", ["create", "change"])
def test_rn017_event_cannot_take_the_profile_after_the_mark(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    # The mark is written; while the deletion reads the events, an event tries
    # to take the profile and is refused, so the deletion misses nothing.
    profile_id = _ready()
    event_id = _event(name="Do principal")
    refused: dict[str, Any] = {}

    def take_profile() -> None:
        if route == "create":
            refused["response"] = _post_event(name="Novo", profile_id=profile_id)
        else:
            refused["response"] = _put_event(event_id, profile_id=profile_id)

    before_dynamodb_call(monkeypatch, "Scan", EVENTS_TABLE_ENV, take_profile)
    response = _delete(profile_id)

    assert _message(refused["response"]) == (409, MSG_EVENT_PROFILE_DELETING)
    assert response["statusCode"] == 202
    assert not event_repo.any_event_uses_profile(profile_id)
    assert _delete_calls(copy_invocations) == [profile_id]


def test_rn017_event_that_already_uses_the_profile_and_is_edited_meanwhile_still_blocks(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An edit of the name or status does not check the profile again: the
    # event keeps the profile, and the read of the events finds it.
    profile_id = _ready()
    event_id = _event(name="Do perfil", profile_id=profile_id)
    edited: dict[str, Any] = {}

    def edit_event() -> None:
        edited["response"] = _put_event(event_id, name="Renomeado", status="CLOSED")

    before_dynamodb_call(monkeypatch, "Scan", EVENTS_TABLE_ENV, edit_event)
    response = _delete(profile_id)

    assert edited["response"]["statusCode"] == 200
    assert _message(response) == (409, IN_USE_MESSAGE)
    assert response_json(_get(profile_id))["status"] == "READY"


def test_rn017_copy_created_from_the_profile_before_the_mark_refuses_the_deletion(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Creating a profile and marking a deletion dispute the same version.
    source = _ready("Origem")
    rival: dict[str, Any] = {}

    def copy_from_it() -> None:
        rival["response"] = _create({"name": "Cópia", "source_profile_id": source})

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, copy_from_it)
    response = _delete(source)

    assert rival["response"]["statusCode"] == 202
    assert _message(response) == (409, MSG_PROFILE_IS_COPY_SOURCE)
    assert _stored(source)["status"] == "READY"
    assert _delete_calls(copy_invocations) == []
    # The copy runs to the end from an intact source.
    copy = response_json(rival["response"])["id"]
    assert _run_copy(copy)["outcome"] == "READY"
    assert len(_raw_items(copy)) == len(MAIN_ITEMS)


def test_rn017_copy_from_the_profile_after_the_mark_is_refused(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _ready("Origem")
    rival: dict[str, Any] = {}

    def copy_from_it() -> None:
        rival["response"] = _create({"name": "Cópia", "source_profile_id": source})

    before_dynamodb_call(monkeypatch, "Scan", EVENTS_TABLE_ENV, copy_from_it)
    response = _delete(source)

    assert _message(rival["response"]) == (409, MSG_SOURCE_PROFILE_DELETING)
    assert response["statusCode"] == 202
    assert list(_profiles_item()["profiles"]) == [source]


def test_rn017_create_that_read_the_profile_ready_loses_to_the_mark(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The POST read the source READY; the deletion is marked (version + 1)
    # before the POST's write, which fails and reads again.
    source = _ready("Origem")
    deleted: dict[str, Any] = {}

    def delete_now() -> None:
        deleted["response"] = _delete(source)

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, delete_now)
    response = _create({"name": "Cópia", "source_profile_id": source})

    assert deleted["response"]["statusCode"] == 202
    assert _message(response) == (409, MSG_SOURCE_PROFILE_DELETING)
    assert list(_profiles_item()["profiles"]) == [source]
    assert [call["FunctionName"] for call in copy_invocations.calls].count(DELETE_FUNCTION) == 1


@pytest.mark.parametrize("moment", ["before the mark", "while reading the events"])
def test_rn017_two_deletes_at_the_same_time_start_one_deletion(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    monkeypatch: pytest.MonkeyPatch,
    moment: str,
) -> None:
    profile_id = _ready()
    rival: dict[str, Any] = {}

    def delete_too() -> None:
        rival["response"] = _delete(profile_id)

    if moment == "before the mark":
        before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, delete_too)
    else:
        before_dynamodb_call(monkeypatch, "Scan", EVENTS_TABLE_ENV, delete_too)
    response = _delete(profile_id)

    assert rival["response"]["statusCode"] == 202
    assert response["statusCode"] == 202
    assert response_json(response)["status"] == "DELETING"
    assert _delete_calls(copy_invocations) == [profile_id]
    assert _run_delete(profile_id)["outcome"] == "DELETED"


def test_rn017_rename_that_read_the_profile_ready_loses_to_the_mark(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _ready()
    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, lambda: _delete(profile_id))

    response = handlers.rename_profile(
        api_event(EXAMINER, path={"id": profile_id}, body={"name": "Outro nome"}), None
    )

    assert _message(response) == (409, MSG_PROFILE_DELETING)
    assert _stored(profile_id)["name"] == "Perfil do Sensei"


def test_rn017_copy_that_finishes_before_the_mark_is_seen_by_the_deletion(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    # The deletion of a stalled copy is conditioned on the copy still being
    # stalled: a resume (a new sign of life) between the read and the mark
    # makes the mark fail, and the fresh read answers that the copy is running.
    profile_id = _created()["id"]
    set_now(LATER)
    stale = profile_repo.get_profiles()
    planned = plan_deletion(stale.profiles, profile_id, LATER)
    assert profile_repo.claim_stalled_copy(profile_id, LATER, profile_rules.stall_threshold(LATER))

    with pytest.raises(profile_repo._StaleVersionError):
        profile_repo._write_deleting(stale, planned)
    assert _message(_delete(profile_id)) == (409, MSG_DELETE_COPY_IN_PROGRESS)
    assert _stored(profile_id)["status"] == "COPYING"


def test_rn017_undo_that_fails_leaves_the_profile_unconfirmed_and_the_next_delete_decides(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _ready()
    event_id = _event(name="Do perfil", profile_id=profile_id)
    items = _raw_items(profile_id)
    stub = throttle_dynamodb(
        monkeypatch,
        "UpdateItem",
        SETTINGS_TABLE_ENV,
        matches=lambda params: (
            ":previous" in params["ExpressionAttributeValues"]
            and ":deleting" in params["ExpressionAttributeValues"]
            and "#version" not in params["ExpressionAttributeNames"]
        ),
    )

    response = _delete(profile_id)
    stub.active = False

    # The undo was throttled: 503, and the profile is DELETING but unconfirmed.
    assert_service_busy(response, stub)
    stored = _stored(profile_id)
    assert stored["status"] == "DELETING"
    assert "delete_checked" not in stored
    # Nothing is deleted without the confirmation, whoever invokes the function.
    assert _delete_calls(copy_invocations) == []
    assert _run_delete(profile_id) == {"profile_id": profile_id, "outcome": "NOT_CONFIRMED"}
    assert _raw_items(profile_id) == items

    # It is not stuck: the next DELETE reads the events again, at once.
    assert _message(_delete(profile_id)) == (409, IN_USE_MESSAGE)
    assert _stored(profile_id)["status"] == "READY"
    assert _raw_items(profile_id) == items
    # And once no event uses it, the DELETE goes through.
    removed = event_handlers.delete_event(api_event(EXAMINER, path={"id": event_id}), None)
    assert removed["statusCode"] == 204
    assert _delete(profile_id)["statusCode"] == 202
    assert _run_delete(profile_id)["outcome"] == "DELETED"


def test_rn017_unconfirmed_deletion_goes_on_when_the_event_left_meanwhile(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _ready()
    event_id = _event(name="Do perfil", profile_id=profile_id)
    stub = throttle_dynamodb(monkeypatch, "Scan", EVENTS_TABLE_ENV)
    undo = throttle_dynamodb(
        monkeypatch,
        "UpdateItem",
        SETTINGS_TABLE_ENV,
        matches=lambda params: (
            ":previous" in params["ExpressionAttributeValues"]
            and "#version" not in params["ExpressionAttributeNames"]
        ),
    )
    assert _delete(profile_id)["statusCode"] == 503
    stub.active = False
    undo.active = False
    assert "delete_checked" not in _stored(profile_id)
    assert _stored(profile_id)["status"] == "DELETING"

    assert _put_event(event_id, profile_id=MAIN_PROFILE_ID)["statusCode"] == 200
    response = _delete(profile_id)

    assert response["statusCode"] == 202
    assert _stored(profile_id)["delete_checked"] is True
    assert _delete_calls(copy_invocations) == [profile_id]


def test_rn017_events_that_cannot_be_read_undo_the_mark(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _ready()
    stored = _stored(profile_id)
    items = _raw_items(profile_id)
    stub = throttle_dynamodb(monkeypatch, "Scan", EVENTS_TABLE_ENV)

    response = _delete(profile_id)
    stub.active = False

    assert_service_busy(response, stub)
    assert _stored(profile_id) == stored  # READY again, no trace of the deletion
    assert _raw_items(profile_id) == items
    assert _delete_calls(copy_invocations) == []


@pytest.mark.parametrize("operation", ["GetItem", "UpdateItem"])
def test_rn017_delete_profile_answers_503_when_settings_is_throttled(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    profile_id = _ready()
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, operation, SETTINGS_TABLE_ENV)

    response = _delete(profile_id)
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before
    assert _delete_calls(copy_invocations) == []


def test_rn017_profile_write_that_meets_a_transaction_is_tried_again(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An event being written holds the profiles item (ConditionCheck) for an instant.
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    profile_id = _ready()
    conflicts = {"count": 0}

    def first_two(_params: dict[str, Any]) -> bool:
        conflicts["count"] += 1
        return conflicts["count"] <= 2

    stub = throttle_dynamodb(
        monkeypatch,
        "UpdateItem",
        SETTINGS_TABLE_ENV,
        code="TransactionConflictException",
        matches=first_two,
    )

    assert _delete(profile_id)["statusCode"] == 202
    assert len(stub.calls) == 2


def test_rn017_profile_write_held_by_transactions_for_too_long_is_409(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    profile_id = _ready()
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(
        monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, code="TransactionConflictException"
    )

    response = _delete(profile_id)
    stub.active = False

    assert _message(response) == (409, MSG_PROFILES_BUSY)
    assert len(stub.calls) == profile_repo._CONFLICT_ATTEMPTS
    assert dynamodb_snapshot() == before


# --- the events read by the deletion ---------------------------------------------


def test_rn017_events_are_read_consistently_and_on_every_page(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _ready()
    for index in range(4):
        _event(name=f"Do principal {index}")
    _event(name="Do perfil", profile_id=profile_id)
    events_table = tables.table(EVENTS_TABLE_ENV).name
    scans: list[dict[str, Any]] = []
    original = BaseClient._make_api_call

    def one_item_per_page(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name == "Scan" and api_params.get("TableName") == events_table:
            scans.append(dict(api_params))
            api_params = {**api_params, "Limit": 1}
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", one_item_per_page)

    assert event_repo.any_event_uses_profile(profile_id)
    assert not event_repo.any_event_uses_profile("outro-perfil")

    assert len(scans) > 5  # every page was read, whichever holds the event
    assert all(scan.get("ConsistentRead") is True for scan in scans)
    # The main profile is not stored in events written before the profiles: never a match.
    assert not event_repo.any_event_uses_profile("")


# --- the background deletion ------------------------------------------------------


def test_rn017_deletion_removes_every_item_of_the_profile_and_only_them(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    other = _ready("Outro perfil")  # same belts, same number of items
    profile_id = _ready("Sai")
    own = requirement_handlers.create_requirement(
        api_event(EXAMINER, body=_item_body(profile_id)), None
    )
    assert own["statusCode"] == 201
    assert len(_raw_items(profile_id)) == len(MAIN_ITEMS) + 1
    main_before = _raw_items(MAIN_PROFILE_ID)
    other_before = _raw_items(other)
    assert _delete(profile_id)["statusCode"] == 202

    result = _run_delete(profile_id)

    assert result == {
        "profile_id": profile_id,
        "outcome": "DELETED",
        "deleted": len(MAIN_ITEMS) + 1,
        "kept": 0,
    }
    assert _raw_items(profile_id) == []
    # The main profile (answer_count included) and the other profile are untouched.
    assert _raw_items(MAIN_PROFILE_ID) == main_before
    assert _raw("m-cinza-2")["answer_count"] == 3
    assert _raw_items(other) == other_before
    assert len(other_before) == len(MAIN_ITEMS)
    assert list(_profiles_item()["profiles"]) == [other]
    assert response_json(_get(other))["status"] == "READY"


def test_rn017_deletion_that_runs_twice_does_nothing_more(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()
    assert _run_delete(profile_id)["outcome"] == "DELETED"
    after = dynamodb_snapshot()

    again = _run_delete(profile_id)

    assert again == {"profile_id": profile_id, "outcome": "NOT_FOUND"}
    assert dynamodb_snapshot() == after


def test_rn017_deletion_stopped_at_the_deadline_resumes_where_it_stopped(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()
    clock = FakeClock()

    with pytest.raises(DeadlineExceededError):
        _run_delete(profile_id, items_per_second=1, deadline=2.5, sleep=clock.sleep, clock=clock)

    # Three items went (at 0, 1 and 2 s); the profile is still there, DELETING.
    assert len(_raw_items(profile_id)) == len(MAIN_ITEMS) - 3
    assert _stored(profile_id)["status"] == "DELETING"
    result = _run_delete(profile_id)
    assert (result["outcome"], result["deleted"]) == ("DELETED", len(MAIN_ITEMS) - 3)
    assert _raw_items(profile_id) == []
    assert _stored(profile_id) is None


def test_rn017_deletion_paces_its_deletes_and_waits_before_the_last_pass(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()
    clock = FakeClock()

    result = _run_delete(profile_id, items_per_second=2, sleep=clock.sleep, clock=clock)

    assert result["outcome"] == "DELETED"
    # Five items, half a second apart; then nothing found, the wait, and nothing again.
    assert clock.sleeps == [0.5] * 4 + [delete_worker.SETTLE_SECONDS]
    assert delete_worker.SETTLE_SECONDS > 10  # longer than the timeout of the API functions


def test_rn017_deletion_pace_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    assert delete_worker._items_per_second() == 2.0
    monkeypatch.setenv(delete_worker.ITEMS_PER_SECOND_ENV, "10")
    assert delete_worker._items_per_second() == 10.0
    for invalid in ("", "abc", "0", "-1"):
        monkeypatch.setenv(delete_worker.ITEMS_PER_SECOND_ENV, invalid)
        assert delete_worker._items_per_second() == 2.0


def test_rn017_profile_is_removed_only_when_no_item_is_left(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    # An item written by a request that read the profile READY just before the
    # mark shows up after the first empty pass: it is deleted too, and the
    # profile leaves only after two passes in a row that find nothing.
    profile_id = _deleting()
    late = Requirement(
        "late-item", CINZA, RequirementKind.THEORY, "Vocabulário", "Atrasado", None, 9, profile_id
    )
    waits: list[float] = []

    def sleep(seconds: float) -> None:
        if seconds == delete_worker.SETTLE_SECONDS:
            waits.append(seconds)
            if len(waits) == 1:
                assert _stored(profile_id)["status"] == "DELETING"  # not removed yet
                requirement_repo.create_requirement(late)

    result = _run_delete(profile_id, sleep=sleep)

    assert (result["outcome"], result["deleted"]) == ("DELETED", len(MAIN_ITEMS) + 1)
    assert len(waits) == 2
    assert _raw("late-item") is None
    assert _raw_items(profile_id) == []


def test_rn017_deletion_ignores_items_the_index_still_lists_after_they_are_gone(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _deleting()
    original = requirement_repo.list_stored_profile_belt_ids

    def lagging(profile: str, belt: str) -> list[str]:
        ids = original(profile, belt)
        return [*ids, "ja-excluido"] if belt == CINZA else ids

    monkeypatch.setattr(requirement_repo, "list_stored_profile_belt_ids", lagging)

    result = _run_delete(profile_id)

    assert result == {
        "profile_id": profile_id,
        "outcome": "DELETED",
        "deleted": len(MAIN_ITEMS),
        "kept": 0,
    }


def test_rn017_deletion_never_deletes_an_item_of_another_profile(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    # Even if the index lists it under this profile (a wrong profile_belt).
    other = _ready("Outro perfil")
    profile_id = _deleting("Sai")
    requirements = tables.table(REQUIREMENTS_TABLE_ENV)
    for item_id, owner in (("de-outro", other), ("do-principal", MAIN_PROFILE_ID)):
        requirements.put_item(
            Item={
                "id": item_id,
                "belt_id": CINZA,
                "kind": "THEORY",
                "category": "Vocabulário",
                "description": "Não é deste perfil",
                "sort_order": 50,
                "profile_id": owner,
                "profile_belt": f"{profile_id}#{CINZA}",
            }
        )
    requirements.put_item(
        Item={
            "id": "sem-perfil",
            "belt_id": CINZA,
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": "Item de antes dos perfis",
            "sort_order": 51,
            "profile_belt": f"{profile_id}#{CINZA}",
        }
    )

    result = _run_delete(profile_id)

    assert result == {
        "profile_id": profile_id,
        "outcome": "BLOCKED",
        "deleted": len(MAIN_ITEMS),
        "kept": 3,
    }
    for item_id in ("de-outro", "do-principal", "sem-perfil"):
        assert _raw(item_id) is not None
    assert len(_raw_items(other)) == len(MAIN_ITEMS) + 1
    # The profile is not removed while something is listed under it.
    assert _stored(profile_id)["status"] == "DELETING"


def test_rn017_item_with_answers_is_kept_and_the_profile_is_not_removed(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    # Should not happen (see the premise test above). If it does, the item is
    # not deleted blindly: the run ends BLOCKED and the profile stays DELETING.
    profile_id = _deleting()
    answered = copied_requirement_id(profile_id, "m-cinza-1")
    tables.table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": answered},
        UpdateExpression="SET answer_count = :n",
        ExpressionAttributeValues={":n": 1},
    )
    set_now(ALMOST)

    result = _run_delete(profile_id)

    assert result == {
        "profile_id": profile_id,
        "outcome": "BLOCKED",
        "deleted": len(MAIN_ITEMS) - 1,
        "kept": 1,
    }
    assert [item["id"] for item in _raw_items(profile_id)] == [answered]
    assert _raw(answered)["answer_count"] == 1
    assert _stored(profile_id)["status"] == "DELETING"
    # Once the answers are gone (unmarked), a repeated DELETE finishes the job.
    tables.table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": answered},
        UpdateExpression="SET answer_count = :n",
        ExpressionAttributeValues={":n": 0},
    )
    set_now(MUCH_LATER)
    assert _delete(profile_id)["statusCode"] == 202
    assert _run_delete(profile_id)["outcome"] == "DELETED"


def test_rn017_delete_profile_item_tells_what_it_did(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    copy_id = copied_requirement_id(profile_id, "m-cinza-1")

    assert (
        requirement_repo.delete_profile_item("m-cinza-1", profile_id)
        is ProfileItemDeletion.OTHER_PROFILE
    )
    assert (
        requirement_repo.delete_profile_item("nao-existe", profile_id) is ProfileItemDeletion.GONE
    )
    assert requirement_repo.delete_profile_item(copy_id, profile_id) is ProfileItemDeletion.DELETED
    assert requirement_repo.delete_profile_item(copy_id, profile_id) is ProfileItemDeletion.GONE
    assert _raw("m-cinza-1") is not None
    # The main profile's items are never deleted in bulk.
    with pytest.raises(ValueError, match="main profile"):
        requirement_repo.delete_profile_item("m-cinza-1", MAIN_PROFILE_ID)
    with pytest.raises(ValueError, match="main profile"):
        requirement_repo.list_stored_profile_belt_ids(MAIN_PROFILE_ID, CINZA)


def test_rn017_deletion_retries_throttled_deletes(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    profile_id = _deleting()
    throttled = {"count": 0}

    def first_two(_params: dict[str, Any]) -> bool:
        throttled["count"] += 1
        return throttled["count"] <= 2

    stub = throttle_dynamodb(monkeypatch, "DeleteItem", REQUIREMENTS_TABLE_ENV, matches=first_two)
    conflicts: list[int] = []  # one delete meets a marking transaction once
    conflict = throttle_dynamodb(
        monkeypatch,
        "DeleteItem",
        REQUIREMENTS_TABLE_ENV,
        code="TransactionConflictException",
        matches=lambda _params: not conflicts and not conflicts.append(1),
    )

    result = _run_delete(profile_id)

    assert len(stub.calls) == 2
    assert len(conflict.calls) == 1
    assert (result["outcome"], result["deleted"]) == ("DELETED", len(MAIN_ITEMS))


def test_rn017_deletion_does_nothing_unless_the_profile_is_a_confirmed_deleting(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    ready = _ready("Pronto")
    copying = _created("Copiando")["id"]
    before = dynamodb_snapshot()

    assert _run_delete(ready) == {"profile_id": ready, "outcome": "NOT_DELETING"}
    assert _run_delete(copying) == {"profile_id": copying, "outcome": "NOT_DELETING"}
    assert _run_delete(MAIN_PROFILE_ID) == {
        "profile_id": MAIN_PROFILE_ID,
        "outcome": "MAIN_PROFILE",
    }
    assert _run_delete("nao-existe") == {"profile_id": "nao-existe", "outcome": "NOT_FOUND"}
    assert dynamodb_snapshot() == before
    # Marked but not confirmed (the route has not read the events yet).
    marked, previous = profile_repo.begin_deletion(lambda stored: plan_deletion(stored, ready, NOW))
    assert (marked.status, marked.delete_checked, previous) == (
        ProfileStatus.DELETING,
        False,
        ProfileStatus.READY,
    )
    assert _run_delete(ready) == {"profile_id": ready, "outcome": "NOT_CONFIRMED"}
    assert len(_raw_items(ready)) == len(MAIN_ITEMS)


def test_rn017_deletion_stops_when_another_run_removed_the_profile(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(delete_worker, "PROGRESS_EVERY_ITEMS", 1)
    profile_id = _deleting()
    original = requirement_repo.delete_profile_item
    calls = {"count": 0}

    def other_run_finishes(*args: Any, **kwargs: Any) -> ProfileItemDeletion:
        result = original(*args, **kwargs)
        calls["count"] += 1
        if calls["count"] == 1:
            assert profile_repo.remove_profile(profile_id)
        return result

    monkeypatch.setattr(requirement_repo, "delete_profile_item", other_run_finishes)

    result = _run_delete(profile_id)

    assert result == {"profile_id": profile_id, "outcome": "STOPPED", "deleted": 1, "kept": 0}
    assert calls["count"] == 1


def test_rn017_deletion_handler_ignores_a_bad_event_and_an_unknown_profile(seeded: list) -> None:
    assert delete_worker.handler({}, None) == {"outcome": "INVALID_EVENT"}
    assert delete_worker.handler({"profile_id": 7}, None) == {"outcome": "INVALID_EVENT"}
    assert delete_worker.handler("main", None) == {"outcome": "INVALID_EVENT"}
    assert delete_worker.handler({"profile_id": "nao-existe"}, None) == {
        "profile_id": "nao-existe",
        "outcome": "NOT_FOUND",
    }


def test_rn017_deletion_handler_stops_before_the_lambda_timeout(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _deleting()

    class Context:
        @staticmethod
        def get_remaining_time_in_millis() -> int:
            # Less than the safety margin: no time left to delete anything.
            return (delete_worker.SAFETY_MARGIN_SECONDS - 1) * 1000

    with pytest.raises(DeadlineExceededError):
        delete_worker.handler({"profile_id": profile_id}, Context())
    assert len(_raw_items(profile_id)) == len(MAIN_ITEMS)
    assert _stored(profile_id)["status"] == "DELETING"


def test_rn017_deletion_writes_its_sign_of_life_only_while_deleting(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    ready = _ready("Pronto")
    profile_id = _deleting("Sai")
    set_now(ALMOST)

    assert profile_repo.record_deletion_progress(profile_id, ALMOST)
    assert _stored(profile_id)["delete_updated_at"] == ALMOST
    # A ready profile gets no trace of a deletion, and is never removed.
    assert not profile_repo.record_deletion_progress(ready, ALMOST)
    assert not profile_repo.remove_profile(ready)
    assert not profile_repo.claim_stalled_deletion(ready, ALMOST, ALMOST)
    assert "delete_updated_at" not in _stored(ready)
    # Alive: a resume does not claim it; stalled: only one claim wins.
    assert not profile_repo.claim_stalled_deletion(
        profile_id, LATER, profile_rules.stall_threshold(LATER)
    )
    threshold = profile_rules.stall_threshold(MUCH_LATER)
    assert profile_repo.claim_stalled_deletion(profile_id, MUCH_LATER, threshold)
    assert not profile_repo.claim_stalled_deletion(profile_id, MUCH_LATER, threshold)


# --- a copy that wakes up after the deletion --------------------------------------


def test_rn017_copy_that_wakes_up_after_the_deletion_writes_nothing_and_revives_nothing(
    main_items: tuple, copy_invocations: CopyInvocations, set_now: Callable[[str], None]
) -> None:
    profile_id = _created()["id"]
    set_now(LATER)  # the copy stalled without copying anything
    assert _delete(profile_id)["statusCode"] == 202
    marked = dynamodb_snapshot()

    # A late run of the copy (a queued event, a Lambda retry) while DELETING.
    late = _run_copy(profile_id)

    assert (late["outcome"], late["written"]) == ("STOPPED", 0)
    assert not profile_repo.mark_ready(profile_id, LATER, 5, 5)
    assert not profile_repo.record_copy_progress(profile_id, LATER, 1, 5)
    assert dynamodb_snapshot() == marked
    assert _stored(profile_id)["status"] == "DELETING"

    assert _run_delete(profile_id)["outcome"] == "DELETED"
    gone = dynamodb_snapshot()

    # And after the profile is gone.
    assert _run_copy(profile_id) == {"profile_id": profile_id, "outcome": "NOT_FOUND"}
    assert not profile_repo.mark_ready(profile_id, LATER, 5, 5)
    assert dynamodb_snapshot() == gone
    assert _raw_items(profile_id) == []


def test_rn017_copy_caught_running_by_the_deletion_stops_and_its_items_are_deleted(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A run of the copy that already passed its first progress check when the
    # profile went to DELETING stops at its next progress, and what it wrote
    # in between is deleted with the rest.
    monkeypatch.setattr(copy_worker, "PROGRESS_EVERY_ITEMS", 2)
    profile_id = _created()["id"]
    original = requirement_repo.put_copy
    puts = {"count": 0}

    def deletion_arrives(*args: Any, **kwargs: Any) -> bool:
        written = original(*args, **kwargs)
        puts["count"] += 1
        if puts["count"] == 1:
            set_now(MUCH_LATER)
            # Forced past the stall check, as if the copy had been quiet for long.
            tables.table(SETTINGS_TABLE_ENV).update_item(
                Key={"id": profile_repo.REQUIREMENT_PROFILES_ID},
                UpdateExpression="REMOVE #profiles.#id.#updated",
                ExpressionAttributeNames={
                    "#profiles": "profiles",
                    "#id": profile_id,
                    "#updated": "copy_updated_at",
                },
            )
            assert _delete(profile_id)["statusCode"] == 202
        return written

    monkeypatch.setattr(requirement_repo, "put_copy", deletion_arrives)

    stopped = _run_copy(profile_id)

    assert (stopped["outcome"], stopped["written"]) == ("STOPPED", 2)
    assert len(_raw_items(profile_id)) == 2
    assert _stored(profile_id)["status"] == "DELETING"
    result = _run_delete(profile_id)
    assert (result["outcome"], result["deleted"]) == ("DELETED", 2)
    assert _raw_items(profile_id) == []
    assert [belt.id for belt in SEED_BELTS]  # the belts are untouched
    assert len(_raw_items(MAIN_PROFILE_ID)) == len(MAIN_ITEMS)


# --- the identity of the mark (delete_mark) ----------------------------------------
#
# The events read by a request vouch only for the mark it held then. A mark
# undone and written again is another mark: the profile was READY in between
# and an event may have chosen it.


def _mark(profile_id: str) -> tuple[RequirementProfile, ProfileStatus | None]:
    return profile_repo.begin_deletion(lambda stored: plan_deletion(stored, profile_id, NOW))


def test_rn017_every_mark_has_its_own_identity_dropped_when_it_is_undone(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    ready = _stored(profile_id)

    first, previous = _mark(profile_id)
    assert previous is ProfileStatus.READY
    assert first.delete_mark and _stored(profile_id)["delete_mark"] == first.delete_mark
    # Internal: never in an answer.
    assert "delete_mark" not in first.to_dict(NOW)
    assert "delete_mark" not in response_json(_get(profile_id))
    # A request that meets the mark gets the same one and writes nothing.
    met, met_previous = _mark(profile_id)
    assert (met.delete_mark, met_previous) == (first.delete_mark, None)

    assert profile_repo.cancel_deletion(profile_id, first.delete_mark, ProfileStatus.READY)
    assert _stored(profile_id) == ready  # no trace of the mark

    # Same second, same request time: still another identity.
    second, _previous = _mark(profile_id)
    assert second.delete_mark and second.delete_mark != first.delete_mark
    assert second.delete_updated_at == first.delete_updated_at


def test_rn017_cancel_with_an_old_mark_does_not_undo_the_new_mark(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    old, _previous = _mark(profile_id)
    assert profile_repo.cancel_deletion(profile_id, old.delete_mark, ProfileStatus.READY)
    new, _previous = _mark(profile_id)
    marked = _stored(profile_id)

    assert not profile_repo.cancel_deletion(profile_id, old.delete_mark, ProfileStatus.READY)
    assert not profile_repo.cancel_deletion(profile_id, None, ProfileStatus.READY)

    assert _stored(profile_id) == marked  # still DELETING, under the new mark
    assert marked["status"] == "DELETING" and marked["delete_mark"] == new.delete_mark
    # The request that holds the new mark still undoes it.
    assert profile_repo.cancel_deletion(profile_id, new.delete_mark, ProfileStatus.READY)
    assert _stored(profile_id)["status"] == "READY"


def test_rn017_confirmation_with_an_old_mark_does_not_confirm_the_new_mark(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    old, _previous = _mark(profile_id)
    assert profile_repo.cancel_deletion(profile_id, old.delete_mark, ProfileStatus.READY)
    new, _previous = _mark(profile_id)
    marked = _stored(profile_id)

    assert not profile_repo.confirm_deletion(profile_id, old.delete_mark, LATER)
    assert not profile_repo.confirm_deletion(profile_id, None, LATER)

    assert _stored(profile_id) == marked
    assert "delete_checked" not in marked
    assert _run_delete(profile_id) == {"profile_id": profile_id, "outcome": "NOT_CONFIRMED"}
    # The request that holds the new mark confirms it, once; then it is never undone.
    assert profile_repo.confirm_deletion(profile_id, new.delete_mark, LATER)
    assert not profile_repo.confirm_deletion(profile_id, new.delete_mark, LATER)
    assert not profile_repo.cancel_deletion(profile_id, new.delete_mark, ProfileStatus.READY)
    stored = _stored(profile_id)
    assert (stored["status"], stored["delete_checked"]) == ("DELETING", True)


def test_rn017_stale_read_that_found_an_event_does_not_undo_a_newer_mark(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # This request marks and finds an event. Before it undoes its mark,
    # another request undoes it, the event leaves the profile and a third
    # request marks the profile again (and is still reading the events). The
    # old read must not undo the new mark with a 409: the request reads the
    # events again under the new mark, finds none and goes on.
    profile_id = _ready()
    event_id = _event(name="Do perfil", profile_id=profile_id)
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []
    marks: list[str | None] = []

    def read_events(asked_id: str) -> bool:
        found = real_read(asked_id)
        reads.append(found)
        if len(reads) == 1:
            marks.append(_stored(profile_id)["delete_mark"])
            assert profile_repo.cancel_deletion(profile_id, marks[0], ProfileStatus.READY)
            assert _put_event(event_id, profile_id=MAIN_PROFILE_ID)["statusCode"] == 200
            marks.append(_mark(profile_id)[0].delete_mark)
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)
    response = _delete(profile_id)

    assert reads == [True, False]
    assert marks[0] != marks[1]
    assert response["statusCode"] == 202, response["body"]
    stored = _stored(profile_id)
    assert (stored["status"], stored["delete_checked"], stored["delete_mark"]) == (
        "DELETING",
        True,
        marks[1],
    )
    assert _delete_calls(copy_invocations) == [profile_id]
    assert _run_delete(profile_id)["outcome"] == "DELETED"


def test_rn017_request_that_found_an_event_answers_409_when_another_undid_the_mark_first(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No new read of the events: the event found is reason enough to refuse.
    profile_id = _ready()
    _event(name="Do perfil", profile_id=profile_id)
    ready = _stored(profile_id)
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []

    def read_events(asked_id: str) -> bool:
        found = real_read(asked_id)
        reads.append(found)
        mark = _stored(profile_id)["delete_mark"]
        assert profile_repo.cancel_deletion(profile_id, mark, ProfileStatus.READY)
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)

    assert _message(_delete(profile_id)) == (409, IN_USE_MESSAGE)
    assert reads == [True]
    assert _stored(profile_id) == ready
    assert _delete_calls(copy_invocations) == []


def test_rn017_legitimate_confirmation_survives_changes_of_other_profiles(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A rename of another profile between the mark and the confirmation bumps
    # ``version``; the identity of the mark is not the version, so the
    # confirmation goes through at the first try.
    profile_id = _ready()
    other = _ready("Outro perfil")
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []
    versions: list[int] = []

    def read_events(asked_id: str) -> bool:
        versions.append(int(_profiles_item()["version"]))
        renamed = handlers.rename_profile(
            api_event(EXAMINER, path={"id": other}, body={"name": "Renomeado"}), None
        )
        assert renamed["statusCode"] == 200, renamed["body"]
        versions.append(int(_profiles_item()["version"]))
        reads.append(real_read(asked_id))
        return reads[-1]

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)
    response = _delete(profile_id)

    assert versions[1] == versions[0] + 1
    assert reads == [False]
    assert response["statusCode"] == 202, response["body"]
    body = response_json(response)
    assert (body["status"], body["delete_updated_at"], body["delete_stalled"]) == (
        "DELETING",
        NOW,
        False,
    )
    assert _stored(profile_id)["delete_checked"] is True
    assert _stored(other)["name"] == "Renomeado"
    assert _delete_calls(copy_invocations) == [profile_id]
    assert _run_delete(profile_id)["outcome"] == "DELETED"


def test_rn017_two_deletes_without_event_one_confirms_and_the_other_starts_nothing(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Both read the events under the same mark and find none. The rival
    # confirms and starts the deletion; this request's confirmation fails
    # (already confirmed) and it answers 202 with the current state.
    profile_id = _ready()
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []
    rival: dict[str, Any] = {}

    def read_events(asked_id: str) -> bool:
        found = real_read(asked_id)
        reads.append(found)
        if len(reads) == 1:
            rival["mark"] = _stored(profile_id)["delete_mark"]
            rival["response"] = _delete(profile_id)
            rival["calls"] = _delete_calls(copy_invocations)
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)
    response = _delete(profile_id)

    assert reads == [False, False]  # one read each, none repeated
    assert rival["response"]["statusCode"] == 202
    assert rival["calls"] == [profile_id]
    assert response["statusCode"] == 202
    body = response_json(response)
    assert (body["status"], body["delete_stalled"]) == ("DELETING", False)
    stored = _stored(profile_id)
    assert (stored["delete_checked"], stored["delete_mark"]) == (True, rival["mark"])
    assert _delete_calls(copy_invocations) == [profile_id]  # started once
    assert _run_delete(profile_id)["outcome"] == "DELETED"


@pytest.mark.parametrize("event_uses_it", [False, True])
@pytest.mark.parametrize("with_identity", [True, False])
def test_rn017_unconfirmed_mark_left_by_a_request_that_died_is_decided_by_the_next_delete(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    event_uses_it: bool,
    with_identity: bool,
) -> None:
    profile_id = _ready()
    if event_uses_it:
        _event(name="Do perfil", profile_id=profile_id)
    items = _raw_items(profile_id)
    left, _previous = _mark(profile_id)  # the request stopped here
    if not with_identity:
        # A mark stored without identity (written by hand) is still decided.
        tables.table(SETTINGS_TABLE_ENV).update_item(
            Key={"id": profile_repo.REQUIREMENT_PROFILES_ID},
            UpdateExpression="REMOVE #profiles.#id.#mark",
            ExpressionAttributeNames={
                "#profiles": "profiles",
                "#id": profile_id,
                "#mark": "delete_mark",
            },
        )
    assert _run_delete(profile_id) == {"profile_id": profile_id, "outcome": "NOT_CONFIRMED"}

    response = _delete(profile_id)

    stored = _stored(profile_id)
    if event_uses_it:
        assert _message(response) == (409, IN_USE_MESSAGE)
        assert stored["status"] == "READY"
        assert "delete_mark" not in stored and "delete_updated_at" not in stored
        assert _delete_calls(copy_invocations) == []
        assert _raw_items(profile_id) == items
    else:
        assert response["statusCode"] == 202, response["body"]
        assert (stored["status"], stored["delete_checked"]) == ("DELETING", True)
        assert stored.get("delete_mark") == (left.delete_mark if with_identity else None)
        assert _delete_calls(copy_invocations) == [profile_id]
        assert _run_delete(profile_id)["outcome"] == "DELETED"


def test_rn017_delete_that_keeps_losing_the_mark_gives_up_with_409(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Every time this request reads the events, another request undoes the
    # mark and marks again: it never writes with an old read, and stops.
    profile_id = _ready()
    items = _raw_items(profile_id)
    real_read = event_repo.any_event_uses_profile
    reads: list[bool] = []

    def read_events(asked_id: str) -> bool:
        found = real_read(asked_id)
        reads.append(found)
        mark = _stored(profile_id)["delete_mark"]
        assert profile_repo.cancel_deletion(profile_id, mark, ProfileStatus.READY)
        _mark(profile_id)
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)

    assert _message(_delete(profile_id)) == (409, MSG_PROFILES_BUSY)
    assert reads == [False] * handlers._DELETE_ATTEMPTS
    stored = _stored(profile_id)
    assert stored["status"] == "DELETING" and "delete_checked" not in stored
    assert _delete_calls(copy_invocations) == []
    assert _raw_items(profile_id) == items


def test_rn017_start_failure_never_touches_an_unconfirmed_mark(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    profile_id = _ready()
    _mark(profile_id)
    marked = _stored(profile_id)

    assert not profile_repo.mark_deletion_not_started(profile_id)
    assert _stored(profile_id) == marked
