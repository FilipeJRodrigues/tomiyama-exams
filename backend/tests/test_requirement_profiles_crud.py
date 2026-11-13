"""Requirement profiles, step 2 of #144 (RN017, decisions of 2026-11-12 and 2026-11-13).

Any examiner lists, creates (a full copy of the main profile or of another
ready profile, made in the background; at most three profiles in all, the
main one included) and renames profiles; the main profile is never renamed.
The items of a profile other than the main one are open to every examiner
once its copy has finished (409 while it copies). A copy is idempotent and
resumable: deterministic ids, conditional writes, a deadline before the
Lambda timeout, and a resume route for a stalled copy.
"""

from collections.abc import Callable
from typing import Any

import pytest
from conftest import (
    EXAMINER,
    EXAMINER_SUB,
    GUARDIAN,
    MASTER,
    CopyInvocations,
    api_event,
    assert_service_busy,
    before_dynamodb_call,
    belt_id,
    dynamodb_snapshot,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain import requirement_profiles as profile_rules
from domain.belts import SEED_BELTS
from domain.errors import MSG_SERVICE_BUSY, ConflictError
from domain.requirement_profiles import (
    COPY_STALL_SECONDS,
    MAIN_PROFILE,
    MAIN_PROFILE_ID,
    MAX_PROFILES,
    MSG_COPY_IN_PROGRESS,
    MSG_MAIN_PROFILE_RENAME,
    MSG_PROFILE_COPYING,
    MSG_PROFILE_LIMIT,
    MSG_PROFILE_LOCKED,
    MSG_PROFILE_NAME_TAKEN,
    MSG_PROFILE_NOT_FOUND,
    MSG_PROFILE_READY,
    MSG_SOURCE_PROFILE_COPYING,
    MSG_SOURCE_PROFILE_NOT_FOUND,
    ProfileStatus,
    RequirementProfile,
    check_name_available,
    check_profile_limit,
)
from domain.requirements import (
    Requirement,
    RequirementKind,
    copied_requirement_id,
    seed_requirements,
)
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as handlers
from handlers import requirements as requirement_handlers
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import (
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    DeadlineExceededError,
)

NOW = "2026-11-13T12:00:00+00:00"
LATER = "2026-11-13T12:15:00+00:00"  # exactly COPY_STALL_SECONDS after NOW
ALMOST = "2026-11-13T12:14:59+00:00"
CINZA = belt_id("Cinza")
AZUL = belt_id("Azul")
# Decision of 2026-11-13, word for word.
LIMIT_MESSAGE = "Limite de 3 perfis de requisitos atingido. Exclua um perfil para criar outro."

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
    """Raise the limit of profiles by one, for tests of other rules that need a third one.

    Sorting the list and keeping names unique do not depend on the limit;
    the limit itself is tested with its real value (``test_rn017_*limit*``).
    """
    monkeypatch.setattr(profile_rules, "MAX_PROFILES", MAX_PROFILES + 1)


def _create(user: Any = EXAMINER, body: Any = None) -> dict[str, Any]:
    return handlers.create_profile(api_event(user, body=body), None)


def _created(name: str = "Perfil do Sensei", **body: Any) -> dict[str, Any]:
    response = _create(EXAMINER, {"name": name, **body})
    assert response["statusCode"] == 202, response["body"]
    return response_json(response)


def _run_copy(profile_id: str, **options: Any) -> dict[str, Any]:
    options.setdefault("items_per_second", 1_000_000)
    options.setdefault("sleep", lambda _seconds: None)
    return copy_worker.copy_profile(profile_id, **options)


def _ready(name: str = "Perfil do Sensei", **body: Any) -> dict[str, Any]:
    created = _created(name, **body)
    assert _run_copy(created["id"])["outcome"] == "READY"
    return created


def _get(profile_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.get_profile(api_event(user, path={"id": profile_id}), None)


def _rename(profile_id: str, body: Any, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.rename_profile(api_event(user, path={"id": profile_id}, body=body), None)


def _resume(profile_id: str, user: Any = EXAMINER) -> dict[str, Any]:
    return handlers.resume_copy(api_event(user, path={"id": profile_id}), None)


def _raw(requirement_id: str) -> dict[str, Any] | None:
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )


def _profiles_item() -> dict[str, Any] | None:
    return (
        tables.table(SETTINGS_TABLE_ENV)
        .get_item(Key={"id": profile_repo.REQUIREMENT_PROFILES_ID}, ConsistentRead=True)
        .get("Item")
    )


def _items_of(profile_id: str) -> list[Requirement]:
    return requirement_repo.list_profile_belts(profile_id, [belt.id for belt in SEED_BELTS])


def _list_items(profile_id: str, user: Any = EXAMINER, **query: str) -> dict[str, Any]:
    event = api_event(user, query={"profile_id": profile_id, **query})
    return requirement_handlers.list_requirements(event, None)


def _message(response: dict[str, Any]) -> tuple[int, str]:
    return response["statusCode"], response_json(response)["message"]


# --- model ------------------------------------------------------------------


@pytest.mark.parametrize("name", ["perfil do sensei", "PERFIL DO SENSÉI", "Perfil do Sensei"])
def test_rn017_profile_names_compare_without_case_and_accents(name: str) -> None:
    stored = [RequirementProfile(id="p1", name="Perfil do Sensei", is_main=False)]

    with pytest.raises(ConflictError):
        check_name_available(name, stored)
    # The profile itself may keep its name or change its case (rename).
    check_name_available(name, stored, exclude_id="p1")


@pytest.mark.parametrize("name", ["Principal", "principal", "PRINCIPÁL"])
def test_rn017_main_profile_name_is_reserved(name: str) -> None:
    with pytest.raises(ConflictError):
        check_name_available(name, [])


def test_rn017_copy_is_stalled_after_fifteen_minutes_without_sign_of_life() -> None:
    copying = RequirementProfile(
        id="p1", name="A", is_main=False, status=ProfileStatus.COPYING, copy_updated_at=NOW
    )

    assert COPY_STALL_SECONDS == 15 * 60
    assert not copying.is_copy_stalled(ALMOST)
    assert copying.is_copy_stalled(LATER)
    # Never started (no sign of life): stalled at once.
    never = RequirementProfile(id="p2", name="B", is_main=False, status=ProfileStatus.COPYING)
    assert never.is_copy_stalled(NOW)
    # A ready profile (the main one always is) is never stalled.
    assert not MAIN_PROFILE.is_copy_stalled(LATER)


# --- GET /requirement-profiles ----------------------------------------------


def test_rn017_list_profiles_main_first_then_by_name(
    main_items: tuple, room_for_one_more: None
) -> None:
    for name in ("Zeta", "beta", "Álvaro"):
        _created(name)

    response = handlers.list_profiles(api_event(EXAMINER), None)

    body = response_json(response)
    assert response["statusCode"] == 200
    assert [profile["name"] for profile in body] == ["Principal", "Álvaro", "beta", "Zeta"]
    assert body[0] == {
        "id": MAIN_PROFILE_ID,
        "name": "Principal",
        "is_main": True,
        "status": "READY",
        "source_profile_id": None,
        "created_by": None,
        "created_at": None,
        "copy_updated_at": None,
        "copied_items": None,
        "total_items": None,
        "copy_stalled": False,
    }
    assert {profile["status"] for profile in body[1:]} == {"COPYING"}


def test_rn017_list_profiles_without_stored_profiles_is_only_main(aws: None) -> None:
    body = response_json(handlers.list_profiles(api_event(MASTER), None))

    assert [profile["id"] for profile in body] == [MAIN_PROFILE_ID]


@pytest.mark.parametrize(
    ("user", "status"), [(GUARDIAN, 403), (None, 401)], ids=["guardian", "anonymous"]
)
def test_rn017_profile_routes_are_for_examiners_only(
    main_items: tuple, user: Any, status: int
) -> None:
    profile_id = _created()["id"]
    before = dynamodb_snapshot()

    responses = [
        handlers.list_profiles(api_event(user), None),
        _get(profile_id, user),
        _create(user, {"name": "Outro"}),
        _rename(profile_id, {"name": "Outro"}, user),
        _resume(profile_id, user),
    ]

    assert [response["statusCode"] for response in responses] == [status] * 5
    assert dynamodb_snapshot() == before


# --- GET /requirement-profiles/{id} -----------------------------------------


def test_rn017_get_profile(main_items: tuple) -> None:
    created = _created()

    main = _get(MAIN_PROFILE_ID)
    stored = _get(created["id"])

    assert (main["statusCode"], response_json(main)["name"]) == (200, "Principal")
    assert stored["statusCode"] == 200
    assert response_json(stored) == created


@pytest.mark.parametrize("profile_id", ["nao-existe", "main ", "MAIN", " ", "x" * 1025])
def test_rn017_get_unknown_profile_is_404(main_items: tuple, profile_id: str) -> None:
    _created()

    assert _message(_get(profile_id)) == (404, MSG_PROFILE_NOT_FOUND)


# --- POST /requirement-profiles ---------------------------------------------


def test_rn017_any_examiner_creates_a_profile_copying_in_the_background(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    response = _create(EXAMINER, {"name": "  Perfil do Sensei  "})

    body = response_json(response)
    assert response["statusCode"] == 202
    assert body == {
        "id": body["id"],
        "name": "Perfil do Sensei",
        "is_main": False,
        "status": "COPYING",
        "source_profile_id": MAIN_PROFILE_ID,
        "created_by": EXAMINER_SUB,
        "created_at": NOW,
        "copy_updated_at": NOW,
        "copied_items": None,
        "total_items": None,
        "copy_stalled": False,
    }
    assert copy_invocations.calls == [
        {
            "FunctionName": "test-copy-requirement-profile",
            "InvocationType": "Event",
            "Payload": {"profile_id": body["id"]},
        }
    ]
    stored = _profiles_item()
    assert stored["version"] == 1
    assert stored["profiles"][body["id"]]["status"] == "COPYING"
    # Nothing is copied by the route itself.
    assert _items_of(body["id"]) == []


def test_rn017_master_creates_a_profile_too(main_items: tuple) -> None:
    response = _create(MASTER, {"name": "Perfil do master", "source_profile_id": "main"})

    assert response["statusCode"] == 202
    assert response_json(response)["source_profile_id"] == MAIN_PROFILE_ID


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, "Campo obrigatório: Nome"),
        ({"name": "   "}, "Campo obrigatório: Nome"),
        ({"name": None}, "Campo obrigatório: Nome"),
        ({"name": 7}, "Nome: valor inválido"),
        ({"name": "x" * 61}, "Nome: máximo de 60 caracteres"),
        ({"name": "Ok", "source_profile_id": 3}, "Perfil de origem: valor inválido"),
        (
            {"name": "Ok", "source_profile_id": "x" * 65},
            "Perfil de origem: máximo de 64 caracteres",
        ),
    ],
)
def test_rn017_create_profile_validates_the_body(
    main_items: tuple, copy_invocations: CopyInvocations, body: dict, message: str
) -> None:
    before = dynamodb_snapshot()

    assert _message(_create(EXAMINER, body)) == (400, message)
    assert dynamodb_snapshot() == before
    assert copy_invocations.calls == []


def test_rn017_create_profile_accepts_a_name_of_sixty_characters(main_items: tuple) -> None:
    assert _created("x" * 60)["name"] == "x" * 60


@pytest.mark.parametrize(
    "name", ["perfil do sensei", "PERFIL DO SENSÉI", "Principal", " principal ", "PRINCIPÁL"]
)
def test_rn017_create_profile_with_a_taken_name_is_409(
    main_items: tuple, copy_invocations: CopyInvocations, name: str
) -> None:
    _created("Perfil do Sensei")
    before = dynamodb_snapshot()

    assert _message(_create(EXAMINER, {"name": name})) == (409, MSG_PROFILE_NAME_TAKEN)
    assert dynamodb_snapshot() == before
    assert len(copy_invocations.calls) == 1


@pytest.mark.parametrize("source", ["nao-existe", "MAIN"])
def test_rn017_create_profile_from_an_unknown_source_is_404(main_items: tuple, source: str) -> None:
    response = _create(EXAMINER, {"name": "Novo", "source_profile_id": source})

    assert _message(response) == (404, MSG_SOURCE_PROFILE_NOT_FOUND)
    assert _profiles_item() is None


@pytest.mark.parametrize("source", [None, "", "   ", "  main  "])
def test_rn017_create_profile_source_defaults_to_main(main_items: tuple, source: Any) -> None:
    response = _create(EXAMINER, {"name": "Novo", "source_profile_id": source})

    assert response["statusCode"] == 202
    assert response_json(response)["source_profile_id"] == MAIN_PROFILE_ID


def test_rn017_create_profile_from_a_source_still_copying_is_409(main_items: tuple) -> None:
    copying = _created("Em cópia")

    response = _create(EXAMINER, {"name": "Novo", "source_profile_id": copying["id"]})

    assert _message(response) == (409, MSG_SOURCE_PROFILE_COPYING)


def test_rn017_create_profile_from_another_ready_profile(main_items: tuple) -> None:
    source = _ready("Origem")

    created = _created("Cópia da origem", source_profile_id=source["id"])

    assert created["source_profile_id"] == source["id"]
    assert created["status"] == "COPYING"


def test_rn017_create_profile_order_of_checks(main_items: tuple) -> None:
    copying = _created("Em cópia")

    def status(user: Any, body: Any) -> tuple[int, str]:
        return _message(_create(user, body))

    taken_and_unknown = {"name": "Em cópia", "source_profile_id": "nao-existe"}
    assert status(GUARDIAN, {"name": ""}) == (403, "Esta área é dos examinadores")
    assert status(EXAMINER, [1])[0] == 400
    assert status(EXAMINER, {"name": "", "source_profile_id": "nao-existe"})[0] == 400
    assert status(EXAMINER, taken_and_unknown) == (404, MSG_SOURCE_PROFILE_NOT_FOUND)
    assert status(EXAMINER, {"name": "Em cópia", "source_profile_id": copying["id"]}) == (
        409,
        MSG_SOURCE_PROFILE_COPYING,
    )
    assert status(EXAMINER, {"name": "Em cópia"}) == (409, MSG_PROFILE_NAME_TAKEN)


def test_rn017_profile_whose_copy_could_not_start_is_created_stalled(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    copy_invocations.error_code = "TooManyRequestsException"

    response = _create(EXAMINER, {"name": "Sem cópia"})

    body = response_json(response)
    assert response["statusCode"] == 202
    assert (body["status"], body["copy_updated_at"], body["copy_stalled"]) == (
        "COPYING",
        None,
        True,
    )
    assert "copy_updated_at" not in _profiles_item()["profiles"][body["id"]]
    assert response_json(_get(body["id"]))["copy_stalled"] is True

    # It can be resumed at once, without waiting for the stall time.
    copy_invocations.error_code = None
    resumed = _resume(body["id"])
    assert resumed["statusCode"] == 202
    assert copy_invocations.profile_ids == [body["id"]]


def test_rn017_profile_whose_copy_and_mark_both_fail_shows_stalled_later(
    main_items: tuple,
    copy_invocations: CopyInvocations,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    copy_invocations.error_code = "TooManyRequestsException"
    stub = throttle_dynamodb(
        monkeypatch,
        "UpdateItem",
        SETTINGS_TABLE_ENV,
        matches=lambda params: params["UpdateExpression"].startswith("REMOVE"),
    )

    response = _create(EXAMINER, {"name": "Sem cópia"})

    body = response_json(response)
    assert len(stub.calls) == 1
    # The answer says what is stored: a sign of life now, so stalled only later.
    assert response["statusCode"] == 202
    assert (body["copy_updated_at"], body["copy_stalled"]) == (NOW, False)
    stub.active = False
    set_now(LATER)
    assert response_json(_get(body["id"]))["copy_stalled"] is True


def test_rn017_concurrent_creates_with_the_same_name_store_one(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch, room_for_one_more: None
) -> None:
    # With the real limit, the loser's re-read would find two stored profiles and
    # answer the limit's 409 (it wins over the name): see the limit's race below.
    _created("Primeiro")  # the profiles item exists: the next create is an UpdateItem
    rival: dict[str, Any] = {}

    def create_rival() -> None:
        rival["response"] = _create(EXAMINER, {"name": "Mesmo nome"})

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, create_rival)
    response = _create(EXAMINER, {"name": "MESMO NOME"})

    assert rival["response"]["statusCode"] == 202
    assert _message(response) == (409, MSG_PROFILE_NAME_TAKEN)
    names = [profile["name"] for profile in _profiles_item()["profiles"].values()]
    assert sorted(names) == ["Mesmo nome", "Primeiro"]


# --- limit of profiles (decision of 2026-11-13) --------------------------------


def _stored(count: int, status: ProfileStatus = ProfileStatus.READY) -> list[RequirementProfile]:
    return [
        RequirementProfile(id=f"p{n}", name=f"Perfil {n}", is_main=False, status=status)
        for n in range(count)
    ]


def _listed_names() -> list[str]:
    return [p["name"] for p in response_json(handlers.list_profiles(api_event(EXAMINER), None))]


def test_rn017_profile_limit_is_three_in_all_the_main_one_included() -> None:
    assert MAX_PROFILES == 3
    assert MSG_PROFILE_LIMIT == LIMIT_MESSAGE
    # The main profile takes the first place: room for two stored profiles.
    check_profile_limit(_stored(0))
    check_profile_limit(_stored(1))
    for status in ProfileStatus:
        with pytest.raises(ConflictError) as refused:
            check_profile_limit(_stored(2, status))
        assert refused.value.message == LIMIT_MESSAGE
    # The main profile counts once, even if it comes along with the stored ones.
    check_profile_limit([MAIN_PROFILE, *_stored(1)])
    with pytest.raises(ConflictError):
        check_profile_limit([MAIN_PROFILE, *_stored(2)])


def test_rn017_create_profile_with_zero_and_one_stored_profiles(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    first = _create(EXAMINER, {"name": "Primeiro"})  # none stored
    second = _create(MASTER, {"name": "Segundo"})  # one stored

    assert (first["statusCode"], second["statusCode"]) == (202, 202)
    assert len(_profiles_item()["profiles"]) == 2
    assert copy_invocations.profile_ids == [
        response_json(first)["id"],
        response_json(second)["id"],
    ]
    assert _listed_names() == ["Principal", "Primeiro", "Segundo"]


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
@pytest.mark.parametrize(
    ("ready", "stalled"),
    [(2, False), (1, False), (0, False), (0, True)],
    ids=["both-ready", "ready-and-copying", "both-copying", "both-stalled"],
)
def test_rn017_create_profile_beyond_the_limit_is_409_and_stores_nothing(
    main_items: tuple, copy_invocations: CopyInvocations, user: Any, ready: int, stalled: bool
) -> None:
    if stalled:
        copy_invocations.error_code = "TooManyRequestsException"
    created = [_created("Primeiro")["id"], _created("Segundo")["id"]]
    copy_invocations.error_code = None
    for profile_id in created[:ready]:
        assert _run_copy(profile_id)["outcome"] == "READY"
    listed = response_json(handlers.list_profiles(api_event(EXAMINER), None))
    # Every stored profile counts, whatever its status (the scenario is what it claims).
    assert [(p["status"], p["copy_stalled"]) for p in listed[1:]] == [("READY", False)] * ready + [
        ("COPYING", stalled)
    ] * (2 - ready)
    before = dynamodb_snapshot()
    calls = list(copy_invocations.calls)

    response = _create(user, {"name": "Terceiro"})

    assert _message(response) == (409, LIMIT_MESSAGE)
    assert dynamodb_snapshot() == before
    assert copy_invocations.calls == calls
    # The three profiles of the limit: the main one and the two stored.
    assert _listed_names() == ["Principal", "Primeiro", "Segundo"]


def test_rn017_create_profile_limit_order_of_checks(
    main_items: tuple, copy_invocations: CopyInvocations
) -> None:
    copying = _created("Em cópia")
    _created("Outro")
    before = dynamodb_snapshot()

    def status(user: Any, body: Any) -> tuple[int, str]:
        return _message(_create(user, body))

    assert status(GUARDIAN, {"name": "Novo"}) == (403, "Esta área é dos examinadores")
    assert status(EXAMINER, {"name": ""}) == (400, "Campo obrigatório: Nome")
    assert status(EXAMINER, {"name": "Novo", "source_profile_id": "nao-existe"}) == (
        404,
        MSG_SOURCE_PROFILE_NOT_FOUND,
    )
    assert status(EXAMINER, {"name": "Novo", "source_profile_id": copying["id"]}) == (
        409,
        MSG_SOURCE_PROFILE_COPYING,
    )
    # With a taken name too, the limit wins: only deleting a profile lets one be created.
    for name in ("Em cópia", "principal", "Novo"):
        assert status(EXAMINER, {"name": name}) == (409, LIMIT_MESSAGE)
    assert dynamodb_snapshot() == before
    assert len(copy_invocations.calls) == 2


def test_rn017_concurrent_creates_never_pass_the_profile_limit(
    main_items: tuple, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    first_id = _created("Primeiro")["id"]  # one stored: room for exactly one more
    seen: list[int] = []
    original = profile_rules.check_profile_limit

    def counting(stored: Any) -> None:
        stored = list(stored)
        seen.append(len(stored))
        original(stored)

    monkeypatch.setattr(profile_rules, "check_profile_limit", counting)
    rival: dict[str, Any] = {}

    def create_rival() -> None:
        rival["response"] = _create(EXAMINER, {"name": "Segundo"})

    # The rival is stored between this create's read and its write.
    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, create_rival)
    response = _create(EXAMINER, {"name": "Terceiro"})

    # Both found room on their reads (one stored); only the rival's write passed,
    # and this create's re-read found the limit.
    assert seen == [1, 1, 2]
    assert rival["response"]["statusCode"] == 202
    assert _message(response) == (409, LIMIT_MESSAGE)
    stored = _profiles_item()["profiles"]
    assert len(stored) == MAX_PROFILES - 1
    assert sorted(profile["name"] for profile in stored.values()) == ["Primeiro", "Segundo"]
    assert copy_invocations.profile_ids == [first_id, response_json(rival["response"])["id"]]


# --- PUT /requirement-profiles/{id} -----------------------------------------


def test_rn017_any_examiner_renames_another_profile(main_items: tuple) -> None:
    created = _created("Perfil do master", source_profile_id="main")

    response = _rename(created["id"], {"name": "  Perfil da turma  "})

    body = response_json(response)
    assert response["statusCode"] == 200
    assert body == {**created, "name": "Perfil da turma"}
    assert _profiles_item()["version"] == 2


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
@pytest.mark.parametrize("name", ["Outro nome", "Principal"])
def test_rn017_main_profile_is_never_renamed(main_items: tuple, user: Any, name: str) -> None:
    before = dynamodb_snapshot()

    assert _message(_rename(MAIN_PROFILE_ID, {"name": name}, user)) == (
        403,
        MSG_MAIN_PROFILE_RENAME,
    )
    assert dynamodb_snapshot() == before


@pytest.mark.parametrize("name", ["outro perfil", "Principal", "PRINCIPAL"])
def test_rn017_rename_to_a_taken_name_is_409(main_items: tuple, name: str) -> None:
    _created("Outro perfil")
    target = _created("Meu perfil")
    before = dynamodb_snapshot()

    assert _message(_rename(target["id"], {"name": name})) == (409, MSG_PROFILE_NAME_TAKEN)
    assert dynamodb_snapshot() == before


def test_rn017_rename_to_the_same_name_writes_nothing(main_items: tuple) -> None:
    target = _created("Meu perfil")
    before = dynamodb_snapshot()

    response = _rename(target["id"], {"name": " Meu perfil "})

    assert response["statusCode"] == 200
    assert response_json(response) == target
    assert dynamodb_snapshot() == before


def test_rn017_rename_may_change_only_case_and_accents(main_items: tuple) -> None:
    target = _created("perfil da turma")

    response = _rename(target["id"], {"name": "Perfil da Turmá"})

    assert response["statusCode"] == 200
    assert response_json(response)["name"] == "Perfil da Turmá"


def test_rn017_rename_order_of_checks(main_items: tuple) -> None:
    other = _created("Outro perfil")

    assert _message(_rename("nao-existe", {"name": ""}, GUARDIAN))[0] == 403
    assert _message(_rename("nao-existe", {"name": ""})) == (404, MSG_PROFILE_NOT_FOUND)
    assert _message(_rename(MAIN_PROFILE_ID, [1])) == (403, MSG_MAIN_PROFILE_RENAME)
    assert _message(_rename(other["id"], {"name": ""})) == (400, "Campo obrigatório: Nome")
    assert _message(_rename(other["id"], {"name": "x" * 61})) == (
        400,
        "Nome: máximo de 60 caracteres",
    )
    assert _message(_rename(other["id"], {"name": "principal"})) == (409, MSG_PROFILE_NAME_TAKEN)


def test_rn017_rename_never_undoes_the_end_of_a_copy(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = _created("Meu perfil")

    def copy_finishes() -> None:
        assert profile_repo.mark_ready(target["id"], NOW, 5, 5)

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, copy_finishes)
    response = _rename(target["id"], {"name": "Novo nome"})

    stored = _profiles_item()["profiles"][target["id"]]
    assert response["statusCode"] == 200
    assert (stored["name"], stored["status"], stored["copied_items"]) == ("Novo nome", "READY", 5)
    assert response_json(response)["status"] == "READY"


# --- the copy ---------------------------------------------------------------


def test_rn017_copy_writes_every_item_with_its_fields_and_marks_ready(main_items: tuple) -> None:
    profile_id = _created()["id"]
    main_before = {item.id: _raw(item.id) for item in main_items}

    result = _run_copy(profile_id)

    assert result == {
        "profile_id": profile_id,
        "outcome": "READY",
        "written": 5,
        "copied": 5,
        "total": 5,
    }
    for source in main_items:
        copy_id = copied_requirement_id(profile_id, source.id)
        stored = _raw(copy_id)
        expected = {
            **{key: value for key, value in source.to_dict().items() if value is not None},
            "id": copy_id,
            "profile_id": profile_id,
            "profile_belt": f"{profile_id}#{source.belt_id}",
        }
        # Every field, never the answers counter of the source (m-cinza-2 has 3).
        assert stored == expected
    # The source is untouched, its answers counter included.
    assert {item.id: _raw(item.id) for item in main_items} == main_before
    assert main_before["m-cinza-2"]["answer_count"] == 3
    view = response_json(_get(profile_id))
    assert (view["status"], view["copied_items"], view["total_items"]) == ("READY", 5, 5)
    assert view["copy_stalled"] is False


def test_rn017_copy_of_the_whole_main_profile(
    seeded: list, copy_invocations: CopyInvocations
) -> None:
    requirement_repo.seed_requirements(seed_requirements())
    profile_id = _created()["id"]

    result = _run_copy(profile_id)

    assert (result["outcome"], result["written"], result["total"]) == ("READY", 692, 692)
    for belt in SEED_BELTS:
        source = requirement_repo.list_profile_belt(MAIN_PROFILE_ID, belt.id)
        copy = requirement_repo.list_profile_belt(profile_id, belt.id)
        assert [item.sort_order for item in copy] == [item.sort_order for item in source]
        assert [item.description for item in copy] == [item.description for item in source]
    marrom = response_json(_list_items(profile_id, belt_id=belt_id("Marrom")))
    assert len(marrom) == 139
    assert [item["sort_order"] for item in marrom] == list(range(1, 140))
    assert len(response_json(_list_items(profile_id))) == 692
    # The main profile keeps its 692 items, and its list leaves the copy out.
    assert len(response_json(_list_items(MAIN_PROFILE_ID))) == 692


def test_rn017_copy_that_runs_twice_writes_nothing_more(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _created()["id"]
    # First run: every item written, but it dies before marking the profile ready.
    original = profile_repo.mark_ready

    def dies(*args: Any, **kwargs: Any) -> bool:
        raise RuntimeError("Lambda died")

    monkeypatch.setattr(profile_repo, "mark_ready", dies)
    with pytest.raises(RuntimeError):
        _run_copy(profile_id)
    monkeypatch.setattr(profile_repo, "mark_ready", original)
    after_first = _items_of(profile_id)

    second = _run_copy(profile_id)
    third = _run_copy(profile_id)

    assert (second["outcome"], second["written"], second["copied"]) == ("READY", 0, 5)
    assert third == {"profile_id": profile_id, "outcome": "ALREADY_READY"}
    assert _items_of(profile_id) == after_first
    assert len(after_first) == 5
    # A repeated write of the same copy is refused by its condition.
    assert not requirement_repo.put_copy(after_first[0])


def test_rn017_copy_stopped_at_the_deadline_resumes_where_it_stopped(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(copy_worker, "PROGRESS_EVERY_ITEMS", 1)
    profile_id = _created()["id"]
    clock = FakeClock()

    # One item per second and a deadline at 1.5 s: two items, then it stops.
    with pytest.raises(DeadlineExceededError):
        _run_copy(profile_id, items_per_second=1, deadline=1.5, sleep=clock.sleep, clock=clock)

    stored = _profiles_item()["profiles"][profile_id]
    assert len(_items_of(profile_id)) == 2
    assert (stored["status"], stored["copied_items"], stored["total_items"]) == ("COPYING", 2, 5)

    result = _run_copy(profile_id)

    assert (result["outcome"], result["written"], result["copied"]) == ("READY", 3, 5)
    copies = _items_of(profile_id)
    assert sorted(item.id for item in copies) == sorted(
        copied_requirement_id(profile_id, item.id) for item in main_items
    )


def test_rn017_copy_paces_its_writes(main_items: tuple) -> None:
    profile_id = _created()["id"]
    clock = FakeClock()

    result = _run_copy(profile_id, items_per_second=2, sleep=clock.sleep, clock=clock)

    assert result["outcome"] == "READY"
    assert clock.sleeps == [0.5] * 4


def test_rn017_copy_pace_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(copy_worker.ITEMS_PER_SECOND_ENV, "4")
    assert copy_worker._items_per_second() == 4
    for invalid in ("0", "-1", "abc", ""):
        monkeypatch.setenv(copy_worker.ITEMS_PER_SECOND_ENV, invalid)
        assert copy_worker._items_per_second() == copy_worker.DEFAULT_ITEMS_PER_SECOND


def test_rn017_copy_from_another_profile(main_items: tuple) -> None:
    source = _ready("Origem")
    edited_id = copied_requirement_id(source["id"], "m-cinza-1")
    body = {**requirement_repo.get_requirement(edited_id).to_dict(), "description": "Até 5"}
    edit = requirement_handlers.update_requirement(
        api_event(EXAMINER, path={"id": edited_id}, body=body), None
    )
    assert edit["statusCode"] == 200
    profile_id = _created("Cópia da origem", source_profile_id=source["id"])["id"]

    result = _run_copy(profile_id)

    assert (result["outcome"], result["total"]) == ("READY", 5)
    copy = requirement_repo.get_requirement(copied_requirement_id(profile_id, edited_id))
    assert (copy.description, copy.profile_id) == ("Até 5", profile_id)
    assert {item.profile_id for item in _items_of(profile_id)} == {profile_id}


def test_rn017_copy_retries_throttled_writes(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    profile_id = _created()["id"]
    throttled = {"count": 0}

    def first_two(_params: dict[str, Any]) -> bool:
        throttled["count"] += 1
        return throttled["count"] <= 2

    stub = throttle_dynamodb(monkeypatch, "PutItem", REQUIREMENTS_TABLE_ENV, matches=first_two)

    result = _run_copy(profile_id)

    assert len(stub.calls) == 2
    assert (result["outcome"], result["written"]) == ("READY", 5)


def test_rn017_copy_stops_when_the_profile_is_no_longer_copying(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(copy_worker, "PROGRESS_EVERY_ITEMS", 1)
    profile_id = _created()["id"]
    original = requirement_repo.put_copy

    def other_run_finishes(*args: Any, **kwargs: Any) -> bool:
        written = original(*args, **kwargs)
        profile_repo.mark_ready(profile_id, NOW, 5, 5)
        return written

    monkeypatch.setattr(requirement_repo, "put_copy", other_run_finishes)

    result = _run_copy(profile_id)

    assert (result["outcome"], result["written"]) == ("STOPPED", 1)


def test_rn017_copy_handler_ignores_a_bad_event_and_an_unknown_profile(aws: None) -> None:
    assert copy_worker.handler({}, None) == {"outcome": "INVALID_EVENT"}
    assert copy_worker.handler({"profile_id": 7}, None) == {"outcome": "INVALID_EVENT"}
    assert copy_worker.handler({"profile_id": "nao-existe"}, None) == {
        "profile_id": "nao-existe",
        "outcome": "NOT_FOUND",
    }


def test_rn017_copy_handler_stops_before_the_lambda_timeout(main_items: tuple) -> None:
    profile_id = _created()["id"]

    class Context:
        @staticmethod
        def get_remaining_time_in_millis() -> int:
            # Less than the safety margin: no time left to copy anything.
            return (copy_worker.SAFETY_MARGIN_SECONDS - 1) * 1000

    with pytest.raises(DeadlineExceededError):
        copy_worker.handler({"profile_id": profile_id}, Context())
    assert _items_of(profile_id) == []


# --- POST /requirement-profiles/{id}/copy -------------------------------------


@pytest.mark.parametrize("ready", ["main", "copied"])
def test_rn017_resume_of_a_ready_profile_is_409(main_items: tuple, ready: str) -> None:
    profile_id = MAIN_PROFILE_ID if ready == "main" else _ready()["id"]

    assert _message(_resume(profile_id)) == (409, MSG_PROFILE_READY)


def test_rn017_resume_of_a_copy_in_progress_is_409(
    main_items: tuple, set_now: Callable[[str], None], copy_invocations: CopyInvocations
) -> None:
    profile_id = _created()["id"]
    set_now(ALMOST)

    assert _message(_resume(profile_id)) == (409, MSG_COPY_IN_PROGRESS)
    assert copy_invocations.profile_ids == [profile_id]


def test_rn017_resume_of_a_stalled_copy_starts_it_again(
    main_items: tuple, set_now: Callable[[str], None], copy_invocations: CopyInvocations
) -> None:
    profile_id = _created()["id"]
    set_now(LATER)
    assert response_json(_get(profile_id))["copy_stalled"] is True

    response = _resume(profile_id)

    body = response_json(response)
    assert response["statusCode"] == 202
    assert (body["status"], body["copy_updated_at"], body["copy_stalled"]) == (
        "COPYING",
        LATER,
        False,
    )
    assert copy_invocations.profile_ids == [profile_id, profile_id]
    # A second resume right after: the copy shows signs of life again.
    assert _message(_resume(profile_id)) == (409, MSG_COPY_IN_PROGRESS)
    # The resumed copy finishes the job.
    assert _run_copy(profile_id)["outcome"] == "READY"


def test_rn017_resume_whose_copy_cannot_start_is_503_and_stays_stalled(
    main_items: tuple, set_now: Callable[[str], None], copy_invocations: CopyInvocations
) -> None:
    profile_id = _created()["id"]
    set_now(LATER)
    copy_invocations.error_code = "ServiceException"

    assert _message(_resume(profile_id)) == (503, MSG_SERVICE_BUSY)
    assert response_json(_get(profile_id))["copy_stalled"] is True
    assert "copy_updated_at" not in _profiles_item()["profiles"][profile_id]


def test_rn017_two_resumes_at_the_same_time_start_one_copy(
    main_items: tuple,
    set_now: Callable[[str], None],
    copy_invocations: CopyInvocations,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_id = _created()["id"]
    set_now(LATER)
    rival: dict[str, Any] = {}

    def rival_resumes() -> None:
        rival["response"] = _resume(profile_id)

    before_dynamodb_call(monkeypatch, "UpdateItem", SETTINGS_TABLE_ENV, rival_resumes)
    response = _resume(profile_id)

    assert rival["response"]["statusCode"] == 202
    assert _message(response) == (409, MSG_COPY_IN_PROGRESS)
    assert copy_invocations.profile_ids == [profile_id, profile_id]  # create + one resume


@pytest.mark.parametrize("profile_id", ["nao-existe", "main "])
def test_rn017_resume_of_an_unknown_profile_is_404(main_items: tuple, profile_id: str) -> None:
    assert _message(_resume(profile_id)) == (404, MSG_PROFILE_NOT_FOUND)


# --- items of a profile other than the main one -------------------------------


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


def test_rn017_any_examiner_creates_edits_and_deletes_items_of_another_profile(
    main_items: tuple,
) -> None:
    profile_id = _ready()["id"]

    created = requirement_handlers.create_requirement(
        api_event(EXAMINER, body=_item_body(profile_id)), None
    )
    item = response_json(created)
    assert created["statusCode"] == 201
    assert (item["profile_id"], item["sort_order"]) == (profile_id, 4)  # Cinza has 3 copies
    assert _raw(item["id"])["profile_belt"] == f"{profile_id}#{CINZA}"

    path = {"id": item["id"]}
    edited = requirement_handlers.update_requirement(
        api_event(EXAMINER, path=path, body={**item, "description": "Rei (saudação)"}), None
    )
    assert edited["statusCode"] == 200
    assert response_json(edited)["description"] == "Rei (saudação)"
    moved = requirement_handlers.update_requirement(
        api_event(EXAMINER, path=path, body={**item, "profile_id": MAIN_PROFILE_ID}), None
    )
    assert _message(moved) == (400, MSG_PROFILE_LOCKED)

    copy_id = copied_requirement_id(profile_id, "m-cinza-1")
    for requirement_id in (item["id"], copy_id):
        deleted = requirement_handlers.delete_requirement(
            api_event(EXAMINER, path={"id": requirement_id}), None
        )
        assert deleted["statusCode"] == 204
        assert _raw(requirement_id) is None
    # The main profile's items are untouched.
    assert _raw("m-cinza-1") is not None


def test_rn017_items_of_a_profile_still_copying_cannot_change(
    main_items: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _created()["id"]
    clock = FakeClock()
    with pytest.raises(DeadlineExceededError):
        _run_copy(profile_id, items_per_second=1, deadline=1.5, sleep=clock.sleep, clock=clock)
    copy = _items_of(profile_id)[0]
    before = dynamodb_snapshot()

    for user in (EXAMINER, MASTER):
        created = requirement_handlers.create_requirement(
            api_event(user, body=_item_body(profile_id)), None
        )
        edited = requirement_handlers.update_requirement(
            api_event(user, path={"id": copy.id}, body={**copy.to_dict(), "description": "X"}),
            None,
        )
        deleted = requirement_handlers.delete_requirement(
            api_event(user, path={"id": copy.id}), None
        )
        for response in (created, edited, deleted):
            assert _message(response) == (409, MSG_PROFILE_COPYING)
    assert dynamodb_snapshot() == before


def test_rn017_list_items_of_another_profile_by_belt_and_without_belt(main_items: tuple) -> None:
    profile_id = _ready()["id"]

    cinza = response_json(_list_items(profile_id, belt_id=CINZA))
    everything = response_json(_list_items(profile_id))
    practice = response_json(_list_items(profile_id, kind="PRACTICE"))

    assert [item["description"] for item in cinza] == ["Contar até 3", "O-soto-gari", "Fundador"]
    assert {item["profile_id"] for item in everything} == {profile_id}
    assert [item["description"] for item in everything] == [
        "Contar até 3",
        "O-soto-gari",
        "Fundador",
        "Mae-ukemi",
        "Hajime",
    ]
    assert [item["description"] for item in practice] == ["O-soto-gari", "Mae-ukemi"]
    assert all("answer_count" not in item for item in everything)
    # The main profile's list leaves the copies out.
    main = response_json(_list_items(MAIN_PROFILE_ID))
    assert {item["id"] for item in main} == {item.id for item in main_items}


def test_rn017_list_of_a_profile_still_copying_shows_what_was_copied(main_items: tuple) -> None:
    profile_id = _created()["id"]
    clock = FakeClock()
    with pytest.raises(DeadlineExceededError):
        _run_copy(profile_id, items_per_second=1, deadline=1.5, sleep=clock.sleep, clock=clock)

    response = _list_items(profile_id)

    assert response["statusCode"] == 200
    assert len(response_json(response)) == 2


def test_rn017_list_items_of_an_unknown_profile_is_still_404(main_items: tuple) -> None:
    _ready()

    assert _message(_list_items("nao-existe")) == (404, MSG_PROFILE_NOT_FOUND)


# --- capacity limit (503) ------------------------------------------------------


@pytest.mark.parametrize(
    ("route", "operation"),
    [
        ("list", "GetItem"),
        ("get", "GetItem"),
        ("create", "GetItem"),
        ("create", "UpdateItem"),
        ("create first", "PutItem"),
        ("rename", "GetItem"),
        ("rename", "UpdateItem"),
        ("resume", "GetItem"),
        ("resume", "UpdateItem"),
        ("items", "GetItem"),
    ],
)
def test_rn017_profile_routes_answer_503_when_settings_is_throttled(
    main_items: tuple,
    set_now: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
    route: str,
    operation: str,
) -> None:
    existing = None if route == "create first" else _created("Existente")["id"]
    set_now(LATER)
    before = dynamodb_snapshot()
    calls = {
        "list": lambda: handlers.list_profiles(api_event(EXAMINER), None),
        "get": lambda: _get(existing),
        "create": lambda: _create(EXAMINER, {"name": "Novo"}),
        "create first": lambda: _create(EXAMINER, {"name": "Novo"}),
        "rename": lambda: _rename(existing, {"name": "Renomeado"}),
        "resume": lambda: _resume(existing),
        "items": lambda: _list_items(existing, belt_id=CINZA),
    }
    stub = throttle_dynamodb(monkeypatch, operation, SETTINGS_TABLE_ENV)

    response = calls[route]()
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before
