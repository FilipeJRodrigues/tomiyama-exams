"""Requirement profiles, step 1 of #144 (RN017, decision of 2026-11-12).

Every requirement belongs to a profile; the main profile (``main``) is the only
one so far, and only the admin master creates, edits and deletes its items.
Items written before profiles existed have no ``profile_id``: they are read
as main items, and the ``InitialData`` migration writes the profile on them
once, without touching exams and answers.
"""

from typing import Any

import pytest
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    GUARDIAN,
    MASTER,
    SCENARIO_REQUIREMENT,
    api_event,
    belt_id,
    dynamodb_snapshot,
    response_json,
)

from domain.requirement_profiles import (
    MAIN_PROFILE,
    MAIN_PROFILE_ID,
    MSG_MAIN_PROFILE_MASTER_ONLY,
    MSG_PROFILE_LOCKED,
    MSG_PROFILE_NOT_FOUND,
    profile_belt_key,
)
from domain.requirements import Requirement, RequirementKind, seed_requirements
from handlers import exams as exam_handlers
from handlers import requirements as handlers
from handlers import seed
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import (
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    DeadlineExceededError,
)

LEGACY_ID = "legacy-1"


def _raw(requirement_id: str) -> dict[str, Any] | None:
    """The stored item, as DynamoDB has it (strongly consistent)."""
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )


def _put_legacy(requirement_id: str = LEGACY_ID, *, sort_order: int = 50, **extra: Any) -> None:
    """Write an item the way the code before profiles did (no profile attributes)."""
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": requirement_id,
            "belt_id": belt_id("Cinza"),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": f"Item antigo {requirement_id}",
            "sort_order": sort_order,
            **extra,
        }
    )


def _payload(**overrides: Any) -> dict[str, Any]:
    data = {
        "belt_id": belt_id("Cinza"),
        "kind": "THEORY",
        "category": "Vocabulário",
        "description": "Treino de quedas",
        "expected_answer": "Ukemi",
        "sort_order": 30,
    }
    data.update(overrides)
    return data


def _migration_marker() -> Any:
    settings = tables.table(SETTINGS_TABLE_ENV)
    return settings.get_item(
        Key={"id": requirement_repo.PROFILE_MIGRATION_MARKER_ID}, ConsistentRead=True
    ).get("Item")


@pytest.fixture
def seeded_requirements(seeded: list) -> None:
    requirement_repo.seed_requirements(seed_requirements())


# --- model ------------------------------------------------------------------


def test_rn017_main_profile_is_fixed() -> None:
    assert (MAIN_PROFILE.id, MAIN_PROFILE.name, MAIN_PROFILE.is_main) == ("main", "Principal", True)
    assert profile_belt_key("main", "belt-1") == "main#belt-1"


def test_rn017_seed_items_are_born_in_the_main_profile(seeded_requirements: None) -> None:
    first = seed_requirements()[0]
    stored = _raw(first.id)

    assert first.profile_id == MAIN_PROFILE_ID
    assert stored["profile_id"] == MAIN_PROFILE_ID
    assert stored["profile_belt"] == f"main#{first.belt_id}"


def test_rn017_item_without_profile_is_read_as_main(seeded: list) -> None:
    _put_legacy()

    assert requirement_repo.get_requirement(LEGACY_ID).profile_id == MAIN_PROFILE_ID


# --- GET /requirements ------------------------------------------------------


@pytest.mark.parametrize("query", [{}, {"profile_id": "main"}, {"profile_id": ""}])
def test_rn017_list_defaults_to_the_main_profile(
    seeded_requirements: None, query: dict[str, str]
) -> None:
    response = handlers.list_requirements(api_event(EXAMINER, query=query or None), None)

    body = response_json(response)
    assert response["statusCode"] == 200
    assert len(body) == 692
    assert {item["profile_id"] for item in body} == {MAIN_PROFILE_ID}
    assert "profile_belt" not in body[0]


def test_rn017_list_main_brown_belt_is_complete_and_ordered(seeded_requirements: None) -> None:
    event = api_event(EXAMINER, query={"profile_id": "main", "belt_id": belt_id("Marrom")})
    body = response_json(handlers.list_requirements(event, None))

    assert len(body) == 139
    assert [item["sort_order"] for item in body] == list(range(1, 140))


def test_rn017_list_main_still_filters_by_kind(seeded_requirements: None) -> None:
    query = {"profile_id": "main", "belt_id": belt_id("Cinza/Azul"), "kind": "PRACTICE"}
    body = response_json(handlers.list_requirements(api_event(EXAMINER, query=query), None))

    assert len(body) == 13
    assert {item["kind"] for item in body} == {"PRACTICE"}


@pytest.mark.parametrize(
    "query",
    [
        {"profile_id": "outro"},
        {"profile_id": "outro", "belt_id": "Cinza"},
        {"profile_id": "MAIN"},
    ],
)
def test_rn017_list_unknown_profile_is_404(seeded_requirements: None, query: dict) -> None:
    if "belt_id" in query:
        query = {**query, "belt_id": belt_id(query["belt_id"])}
    response = handlers.list_requirements(api_event(EXAMINER, query=query), None)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": MSG_PROFILE_NOT_FOUND}


def test_rn017_list_order_of_checks(seeded_requirements: None) -> None:
    def status(user: Any, query: dict[str, str]) -> tuple[int, str]:
        response = handlers.list_requirements(api_event(user, query=query), None)
        return response["statusCode"], response_json(response)["message"]

    bad_everything = {"profile_id": "outro", "belt_id": "nope", "kind": "ORAL"}
    assert status(GUARDIAN, bad_everything) == (403, "Esta área é dos examinadores")
    assert status(EXAMINER, bad_everything) == (400, "Filtro tipo: use THEORY ou PRACTICE")
    assert status(EXAMINER, {"profile_id": "outro", "belt_id": "nope"}) == (
        404,
        MSG_PROFILE_NOT_FOUND,
    )
    assert status(EXAMINER, {"belt_id": "nope"}) == (404, "Faixa não encontrada")


def test_rn017_legacy_item_without_profile_is_listed_in_main(seeded_requirements: None) -> None:
    _put_legacy()

    by_belt = api_event(EXAMINER, query={"belt_id": belt_id("Cinza")})
    listed = response_json(handlers.list_requirements(by_belt, None))
    everything = response_json(handlers.list_requirements(api_event(EXAMINER), None))

    legacy = next(item for item in listed if item["id"] == LEGACY_ID)
    assert legacy["profile_id"] == MAIN_PROFILE_ID
    assert len(listed) == 15  # 14 seeded Cinza items + the legacy one
    assert LEGACY_ID in {item["id"] for item in everything}


def test_rn017_main_list_leaves_out_other_profiles(seeded_requirements: None) -> None:
    # No route creates another profile yet; written straight to the table.
    requirement_repo.create_requirement(
        Requirement(
            id="other-1",
            belt_id=belt_id("Cinza"),
            kind=RequirementKind.THEORY,
            category="Vocabulário",
            description="Item de outro perfil",
            expected_answer=None,
            sort_order=1,
            profile_id="other",
        )
    )

    by_belt = api_event(EXAMINER, query={"belt_id": belt_id("Cinza")})
    listed = response_json(handlers.list_requirements(by_belt, None))
    everything = response_json(handlers.list_requirements(api_event(EXAMINER), None))

    assert "other-1" not in {item["id"] for item in listed}
    assert len(everything) == 692
    other = requirement_repo.list_profile_belt("other", belt_id("Cinza"))
    assert [item.id for item in other] == ["other-1"]
    assert other[0].profile_id == "other"
    assert [item.id for item in requirement_repo.list_by_profile("other")] == ["other-1"]


def test_rn017_other_profile_is_read_from_its_index_in_sheet_order(seeded: list) -> None:
    for order in (3, 1, 2):
        requirement_repo.create_requirement(
            Requirement(
                id=f"other-{order}",
                belt_id=belt_id("Cinza"),
                kind=RequirementKind.PRACTICE,
                category="Nage-waza",
                description=f"Item {order}",
                expected_answer=None,
                sort_order=order,
                profile_id="other",
            )
        )
    _put_legacy("legacy-cinza", sort_order=2)

    items = requirement_repo.list_profile_belt("other", belt_id("Cinza"))

    assert [item.sort_order for item in items] == [1, 2, 3]
    assert {item.profile_id for item in items} == {"other"}
    assert requirement_repo.list_profile_belt("other", belt_id("Azul")) == []


# --- POST /requirements -----------------------------------------------------


@pytest.mark.parametrize("profile", [None, "main", " "])
def test_rn017_master_creates_in_the_main_profile(
    seeded_requirements: None, profile: str | None
) -> None:
    payload = _payload()
    del payload["sort_order"]
    if profile is not None:
        payload["profile_id"] = profile

    response = handlers.create_requirement(api_event(MASTER, body=payload), None)

    created = response_json(response)
    assert response["statusCode"] == 201
    assert created["profile_id"] == MAIN_PROFILE_ID
    assert created["sort_order"] == 15  # Cinza has 14 items in the main profile
    stored = _raw(created["id"])
    assert stored["profile_id"] == MAIN_PROFILE_ID
    assert stored["profile_belt"] == f"main#{belt_id('Cinza')}"


@pytest.mark.parametrize("profile", [None, "main"])
def test_rn017_examiner_cannot_create_in_the_main_profile(
    seeded_requirements: None, profile: str | None
) -> None:
    payload = _payload() if profile is None else _payload(profile_id=profile)
    before = len(requirement_repo.list_all())

    response = handlers.create_requirement(api_event(EXAMINER, body=payload), None)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MAIN_PROFILE_MASTER_ONLY}
    assert len(requirement_repo.list_all()) == before


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
def test_rn017_create_in_unknown_profile_is_404(seeded_requirements: None, user: Any) -> None:
    before = len(requirement_repo.list_all())

    response = handlers.create_requirement(api_event(user, body=_payload(profile_id="outro")), None)

    assert response["statusCode"] == 404
    assert response_json(response) == {"message": MSG_PROFILE_NOT_FOUND}
    assert len(requirement_repo.list_all()) == before


def test_rn017_create_order_of_checks(seeded_requirements: None) -> None:
    def status(user: Any, body: Any) -> tuple[int, str]:
        response = handlers.create_requirement(api_event(user, body=body), None)
        return response["statusCode"], response_json(response)["message"]

    unknown_and_invalid = _payload(profile_id="outro", kind="ORAL")
    assert status(GUARDIAN, unknown_and_invalid)[0] == 403
    assert status(EXAMINER, [1])[0] == 400  # body that is not an object
    assert status(EXAMINER, _payload(profile_id=7)) == (400, "Perfil: valor inválido")
    assert status(EXAMINER, unknown_and_invalid) == (404, MSG_PROFILE_NOT_FOUND)
    # In the main profile, the fields are checked before the master rule.
    assert status(EXAMINER, _payload(kind="ORAL"))[0] == 400
    assert status(EXAMINER, _payload()) == (403, MSG_MAIN_PROFILE_MASTER_ONLY)


# --- PUT and DELETE /requirements/{id} ---------------------------------------


def test_rn017_examiner_cannot_edit_a_main_item(seeded_requirements: None) -> None:
    target = seed_requirements()[0]
    before = _raw(target.id)
    body = {**target.to_dict(), "description": "Novo texto"}

    response = handlers.update_requirement(
        api_event(EXAMINER, path={"id": target.id}, body=body), None
    )

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MAIN_PROFILE_MASTER_ONLY}
    assert _raw(target.id) == before


def test_rn017_examiner_cannot_delete_a_main_item(seeded_requirements: None) -> None:
    target = seed_requirements()[0]

    response = handlers.delete_requirement(api_event(EXAMINER, path={"id": target.id}), None)

    assert response["statusCode"] == 403
    assert response_json(response) == {"message": MSG_MAIN_PROFILE_MASTER_ONLY}
    assert requirement_repo.get_requirement(target.id) is not None


def test_rn017_legacy_item_is_protected_as_a_main_item(seeded: list) -> None:
    _put_legacy()
    before = _raw(LEGACY_ID)

    edit = handlers.update_requirement(
        api_event(EXAMINER, path={"id": LEGACY_ID}, body=_payload()), None
    )
    delete = handlers.delete_requirement(api_event(EXAMINER, path={"id": LEGACY_ID}), None)

    assert (edit["statusCode"], delete["statusCode"]) == (403, 403)
    assert _raw(LEGACY_ID) == before


def test_rn017_master_edits_and_deletes_a_main_item(seeded_requirements: None) -> None:
    target = seed_requirements()[0]
    body = {**target.to_dict(), "description": "Novo texto"}

    response = handlers.update_requirement(
        api_event(MASTER, path={"id": target.id}, body=body), None
    )

    assert response["statusCode"] == 200
    assert response_json(response)["profile_id"] == MAIN_PROFILE_ID
    assert requirement_repo.get_requirement(target.id).description == "Novo texto"
    assert _raw(target.id)["profile_belt"] == f"main#{target.belt_id}"

    response = handlers.delete_requirement(api_event(MASTER, path={"id": target.id}), None)
    assert response["statusCode"] == 204
    assert requirement_repo.get_requirement(target.id) is None


def test_rn017_master_edit_of_a_legacy_item_writes_its_profile(seeded: list) -> None:
    _put_legacy(answer_count=2)

    response = handlers.update_requirement(
        api_event(MASTER, path={"id": LEGACY_ID}, body=_payload(description="Editado")), None
    )

    stored = _raw(LEGACY_ID)
    assert response["statusCode"] == 200
    assert stored["profile_id"] == MAIN_PROFILE_ID
    assert stored["profile_belt"] == f"main#{belt_id('Cinza')}"
    assert stored["answer_count"] == 2


@pytest.mark.parametrize("user", [EXAMINER, MASTER], ids=["examiner", "master"])
def test_rn017_profile_of_an_item_cannot_change(seeded_requirements: None, user: Any) -> None:
    target = seed_requirements()[0]
    before = _raw(target.id)
    body = {**target.to_dict(), "profile_id": "outro"}

    response = handlers.update_requirement(api_event(user, path={"id": target.id}, body=body), None)

    assert response["statusCode"] == 400
    assert response_json(response) == {"message": MSG_PROFILE_LOCKED}
    assert _raw(target.id) == before


@pytest.mark.parametrize("profile", ["main", None, ""])
def test_rn017_resending_or_omitting_the_profile_is_accepted(
    seeded_requirements: None, profile: str | None
) -> None:
    target = seed_requirements()[0]
    body = {**target.to_dict(), "description": "Outro texto", "profile_id": profile}

    response = handlers.update_requirement(
        api_event(MASTER, path={"id": target.id}, body=body), None
    )

    assert response["statusCode"] == 200
    assert response_json(response)["profile_id"] == MAIN_PROFILE_ID


def test_rn017_update_and_delete_order_of_checks(seeded_requirements: None) -> None:
    target = seed_requirements()[0].id

    def put(user: Any, requirement_id: str, body: Any) -> tuple[int, str]:
        response = handlers.update_requirement(
            api_event(user, path={"id": requirement_id}, body=body), None
        )
        return response["statusCode"], response_json(response)["message"]

    def delete(user: Any, requirement_id: str) -> tuple[int, str]:
        response = handlers.delete_requirement(api_event(user, path={"id": requirement_id}), None)
        return response["statusCode"], response_json(response)["message"]

    assert put(GUARDIAN, "nope", [1])[0] == 403
    assert put(EXAMINER, "nope", [1]) == (404, "Requisito não encontrado")
    assert put(EXAMINER, target, [1])[0] == 400
    assert put(EXAMINER, target, _payload(kind="ORAL"))[0] == 400
    assert put(EXAMINER, target, _payload(profile_id="outro")) == (400, MSG_PROFILE_LOCKED)
    assert put(EXAMINER, target, _payload()) == (403, MSG_MAIN_PROFILE_MASTER_ONLY)
    assert delete(GUARDIAN, "nope")[0] == 403
    assert delete(EXAMINER, "nope") == (404, "Requisito não encontrado")
    assert delete(EXAMINER, target) == (403, MSG_MAIN_PROFILE_MASTER_ONLY)


def test_rn017_master_delete_of_an_answered_main_item_is_409(seeded: list) -> None:
    _put_legacy(answer_count=1)

    response = handlers.delete_requirement(api_event(MASTER, path={"id": LEGACY_ID}), None)

    assert response["statusCode"] == 409
    assert response_json(response) == {"message": "Requisito possui respostas registradas"}
    assert _raw(LEGACY_ID) is not None


# --- migration --------------------------------------------------------------


def _strip_profile(requirement_id: str) -> None:
    """Turn a stored item into one written before profiles existed."""
    tables.table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": requirement_id}, UpdateExpression="REMOVE profile_id, profile_belt"
    )


def test_rn017_migration_moves_legacy_items_once_without_touching_exams(
    exam_scenario: None,
) -> None:
    # An answered item (t1, answer_count 1) and a never answered one, both legacy.
    marked = exam_handlers.mark_answer(
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
    assert marked["statusCode"] == 200, marked["body"]
    _strip_profile(SCENARIO_REQUIREMENT.id)
    _put_legacy()
    t1_before = _raw(SCENARIO_REQUIREMENT.id)
    before = dynamodb_snapshot()

    assert requirement_repo.migrate_to_main_profile() == 2
    first_run = dynamodb_snapshot()
    assert requirement_repo.migrate_to_main_profile() == 0

    # Running again changes nothing at all.
    assert dynamodb_snapshot() == first_run
    # Exams, answers, events, students and belts are untouched; settings only
    # gained the marker; no requirement was added or removed.
    for env in ("BELTS_TABLE", "STUDENTS_TABLE", "EXAMS_TABLE", "EVENTS_TABLE", "ANSWERS_TABLE"):
        assert first_run[env] == before[env], env
    assert len(first_run["SETTINGS_TABLE"]) == len(before["SETTINGS_TABLE"]) + 1
    assert _migration_marker()
    assert len(first_run["REQUIREMENTS_TABLE"]) == len(before["REQUIREMENTS_TABLE"])
    # Only the two profile attributes were written on the items.
    assert _raw(SCENARIO_REQUIREMENT.id) == {
        **t1_before,
        "profile_id": MAIN_PROFILE_ID,
        "profile_belt": f"main#{SCENARIO_REQUIREMENT.belt_id}",
    }
    assert t1_before["answer_count"] == 1
    assert _raw(LEGACY_ID)["profile_belt"] == f"main#{belt_id('Cinza')}"


def test_rn017_migration_keeps_items_already_in_a_profile(seeded: list) -> None:
    requirement_repo.create_requirement(
        Requirement(
            id="other-1",
            belt_id=belt_id("Cinza"),
            kind=RequirementKind.THEORY,
            category="Vocabulário",
            description="Item de outro perfil",
            expected_answer=None,
            sort_order=1,
            profile_id="other",
        )
    )
    _put_legacy()

    assert requirement_repo.migrate_to_main_profile() == 1
    assert _raw("other-1")["profile_id"] == "other"
    assert _raw("other-1")["profile_belt"] == f"other#{belt_id('Cinza')}"


def test_rn017_migrated_items_are_found_in_the_profile_index(seeded: list) -> None:
    for order in (2, 1):
        _put_legacy(f"legacy-{order}", sort_order=order)

    requirement_repo.migrate_to_main_profile()

    found = tables.table(REQUIREMENTS_TABLE_ENV).query(
        IndexName=requirement_repo.BY_PROFILE_BELT_INDEX,
        KeyConditionExpression="profile_belt = :key",
        ExpressionAttributeValues={":key": f"main#{belt_id('Cinza')}"},
    )["Items"]
    assert [item["id"] for item in found] == ["legacy-1", "legacy-2"]
    assert all(item["profile_id"] == MAIN_PROFILE_ID for item in found)


def test_rn017_migration_does_not_recreate_an_item_deleted_meanwhile(seeded: list) -> None:
    target = tables.table(REQUIREMENTS_TABLE_ENV)

    moved = requirement_repo._move_to_main_profile(
        target, {"id": "gone", "belt_id": belt_id("Cinza")}, None
    )

    assert moved is False
    assert _raw("gone") is None


def test_rn017_migration_skips_an_item_moved_to_another_belt_meanwhile(seeded: list) -> None:
    # The scan read Cinza; old code still running in the deploy window moved it to Azul.
    _put_legacy(answer_count=1)
    tables.table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": LEGACY_ID},
        UpdateExpression="SET belt_id = :belt",
        ExpressionAttributeValues={":belt": belt_id("Azul")},
    )

    moved = requirement_repo._move_to_main_profile(
        tables.table(REQUIREMENTS_TABLE_ENV), {"id": LEGACY_ID, "belt_id": belt_id("Cinza")}, None
    )

    assert moved is False
    stored = _raw(LEGACY_ID)
    assert "profile_id" not in stored
    assert "profile_belt" not in stored
    assert stored["belt_id"] == belt_id("Azul")
    assert stored["answer_count"] == 1
    # Still read as a main item of its new belt.
    assert LEGACY_ID in {item.id for item in requirement_repo.list_by_belt(belt_id("Azul"))}


def test_rn017_migration_writes_the_profile_belt_of_the_belt_read(seeded: list) -> None:
    _put_legacy()

    moved = requirement_repo._move_to_main_profile(
        tables.table(REQUIREMENTS_TABLE_ENV), {"id": LEGACY_ID, "belt_id": belt_id("Cinza")}, None
    )

    assert moved is True
    assert _raw(LEGACY_ID)["profile_belt"] == f"{MAIN_PROFILE_ID}#{belt_id('Cinza')}"


class _AlwaysInConflict:
    """Every ``UpdateItem`` meets a marking in progress on the same item."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.updates = 0

    def update_item(self, **kwargs: Any) -> Any:
        self.updates += 1
        raise _throttle("TransactionConflictException")

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


def test_rn017_migration_conflict_that_never_ends_stops_at_the_deadline(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_legacy()
    real_table = requirement_repo.table
    conflicting = _AlwaysInConflict(real_table(REQUIREMENTS_TABLE_ENV))
    monkeypatch.setattr(
        requirement_repo,
        "table",
        lambda env: conflicting if env == REQUIREMENTS_TABLE_ENV else real_table(env),
    )
    real_retry = requirement_repo.retry_throttled
    ticks = iter(range(10_000))

    def ticking(call: Any, label: str, *, deadline: float | None = None) -> Any:
        return real_retry(
            call, label, deadline=deadline, sleep=lambda _: None, clock=lambda: next(ticks)
        )

    monkeypatch.setattr(requirement_repo, "retry_throttled", ticking)

    with pytest.raises(DeadlineExceededError):
        requirement_repo.migrate_to_main_profile(deadline=10)

    assert conflicting.updates > 1  # retried, not raised at the first conflict
    assert "profile_id" not in _raw(LEGACY_ID)
    assert not _migration_marker()


def _throttle(code: str = "ProvisionedThroughputExceededException") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "UpdateItem")


class FlakyTable:
    """Wraps the moto table and throttles every other scan and update (moto never throttles)."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls = {"scan": 0, "update_item": 0}
        self.throttled = 0

    def _maybe_throttle(self, operation: str) -> None:
        self.calls[operation] += 1
        if self.calls[operation] % 2 == 1:
            self.throttled += 1
            raise _throttle()

    def scan(self, **kwargs: Any) -> Any:
        self._maybe_throttle("scan")
        return self.inner.scan(**kwargs)

    def update_item(self, **kwargs: Any) -> Any:
        self._maybe_throttle("update_item")
        return self.inner.update_item(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: 0.0)


def test_rn017_migration_retries_throttled_pages_and_writes(
    seeded: list, monkeypatch: pytest.MonkeyPatch, no_backoff: None
) -> None:
    for index in range(1, 251):
        _put_legacy(f"legacy-{index}", sort_order=index)
    real_table = requirement_repo.table
    flaky = FlakyTable(real_table(REQUIREMENTS_TABLE_ENV))
    monkeypatch.setattr(
        requirement_repo,
        "table",
        lambda env: flaky if env == REQUIREMENTS_TABLE_ENV else real_table(env),
    )

    assert requirement_repo.migrate_to_main_profile() == 250

    assert flaky.calls["scan"] >= 6  # 3 pages of 100, each throttled once
    assert flaky.throttled >= 250 + 3
    stored = real_table(REQUIREMENTS_TABLE_ENV).scan(ConsistentRead=True)["Items"]
    assert len(stored) == 250
    assert all(item.get("profile_id") == "main" for item in stored)
    assert _migration_marker()


def test_rn017_migration_stopped_by_the_deadline_resumes_without_marker(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(1, 21):
        _put_legacy(f"legacy-{index}", sort_order=index)
    real_retry = requirement_repo.retry_throttled
    ticks = iter(range(10_000))

    def ticking(call: Any, label: str, *, deadline: float | None = None) -> Any:
        return real_retry(call, label, deadline=deadline, clock=lambda: next(ticks))

    monkeypatch.setattr(requirement_repo, "retry_throttled", ticking)
    with pytest.raises(DeadlineExceededError):
        requirement_repo.migrate_to_main_profile(deadline=10)
    monkeypatch.setattr(requirement_repo, "retry_throttled", real_retry)

    assert not _migration_marker()
    moved = sum(1 for item in requirement_repo.list_all() if _raw(item.id).get("profile_id"))
    assert 0 < moved < 20

    assert requirement_repo.migrate_to_main_profile() == 20 - moved
    assert _migration_marker()


def test_rn017_seed_handler_runs_the_migration_after_the_seed(seeded: list) -> None:
    # An existing stack: seed already applied with items written before profiles.
    requirement_repo.seed_requirements(seed_requirements())
    for item in seed_requirements()[:5]:
        _strip_profile(item.id)

    assert seed.seed_all() == {"belts": 0, "requirements": 0, "requirement_profiles": 5}
    assert seed.seed_all() == {"belts": 0, "requirements": 0, "requirement_profiles": 0}
    assert all(_raw(item.id)["profile_id"] == "main" for item in seed_requirements()[:5])


def test_rn017_new_stack_seed_needs_no_migration(aws: None) -> None:
    assert seed.seed_all()["requirement_profiles"] == 0
    assert _migration_marker()
