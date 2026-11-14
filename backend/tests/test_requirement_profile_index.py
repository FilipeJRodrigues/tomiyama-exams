"""Every profile is read through ``by_profile_belt``, the main one included (#144, step 3a).

RN017 (lists and copy), RN006 and RN007 (exam sheet and score). Until step 3a
the main profile was read through ``by_belt`` (all profiles' items of the
belt, filtered) or a ``Scan``, because items written before profiles (no
``profile_belt``) are not in ``by_profile_belt``. Now:

- the v2 migration (``InitialData``, ``SeedVersion`` "4") fixes (a) items
  without ``profile_id`` and (b) items whose ``profile_belt`` is missing or not
  ``<profile_id>#<belt_id>``, waits for the index to be ``ACTIVE`` and writes
  its marker;
- once the marker is seen (eventually consistent ``GetItem``, kept in memory
  per container), every read of a profile's items is a query on
  ``by_profile_belt`` (no ``by_belt``, no ``Scan``); before it, the main
  profile keeps the complete fallback, so no list is ever missing an item.
"""

import os
from dataclasses import replace
from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from conftest import (
    EXAMINER,
    MASTER,
    CopyInvocations,
    api_event,
    assert_service_busy,
    before_dynamodb_call,
    belt_id,
    dynamodb_snapshot,
    fake_seed_time,
    lag_eventual_reads,
    make_student,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain.belts import SEED_BELTS
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam
from domain.requirement_profiles import MAIN_PROFILE_ID, profile_attributes_to_fix
from domain.requirements import Requirement, RequirementKind, seed_requirements
from handlers import exams as exam_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as profile_handlers
from handlers import requirements as requirement_handlers
from handlers import seed
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository import tables
from repository.tables import (
    REQUIREMENTS_TABLE_ENV,
    SETTINGS_TABLE_ENV,
    DeadlineExceededError,
)

TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)
OTHER_BELT = "Cinza"
MARKER = requirement_repo.PROFILE_BELT_MIGRATION_MARKER_ID
BY_BELT = f"Query {requirement_repo.BY_BELT_INDEX}"
BY_PROFILE_BELT = f"Query {requirement_repo.BY_PROFILE_BELT_INDEX}"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


def _raw(requirement_id: str) -> dict[str, Any] | None:
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )


def _put_raw(requirement_id: str, belt: str, sort_order: int, **extra: Any) -> None:
    """Write an item straight to the table (as old code or another writer left it)."""
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": requirement_id,
            "belt_id": belt_id(belt),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": f"Item {requirement_id}",
            "sort_order": sort_order,
            **extra,
        }
    )


def _marker() -> Any:
    return (
        tables.table(SETTINGS_TABLE_ENV)
        .get_item(Key={"id": MARKER}, ConsistentRead=True)
        .get("Item")
    )


def _key(profile_id: str, belt: str) -> str:
    return f"{profile_id}#{belt_id(belt)}"


# --- reads spied at botocore ---------------------------------------------------


class Reads:
    """DynamoDB reads made since the last ``clear``, as botocore saw them."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def clear(self) -> None:
        self.calls.clear()

    def of_requirements(self) -> list[str]:
        """Each ``Query``/``Scan`` on ``Requirements``: ``"Scan"`` or ``"Query <index>"``."""
        name = os.environ[REQUIREMENTS_TABLE_ENV]
        return [
            f"{call['operation']} {call.get('IndexName', '')}".strip()
            for call in self.calls
            if call.get("TableName") == name and call["operation"] in {"Query", "Scan"}
        ]

    def of_marker(self) -> list[dict[str, Any]]:
        """Each ``GetItem`` of the v2 marker in ``Settings``."""
        name = os.environ[SETTINGS_TABLE_ENV]
        return [
            call
            for call in self.calls
            if call["operation"] == "GetItem"
            and call.get("TableName") == name
            and call.get("Key") == {"id": MARKER}
        ]


@pytest.fixture
def reads(monkeypatch: pytest.MonkeyPatch) -> Reads:
    spied = Reads()
    original = BaseClient._make_api_call

    def spy(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name in {"Query", "Scan", "GetItem"}:
            spied.calls.append({"operation": operation_name, **api_params})
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", spy)
    return spied


# --- an exam whose target belt has items the index misses ----------------------


@pytest.fixture
def exam(seeded: None) -> Exam:
    """An exam in progress for Ana (Cinza → Cinza/Azul) in an open event."""
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
def main_items(exam: Exam) -> list[Requirement]:
    """Appendix A items of the target belt (11 theory, 13 practice) and of Cinza, in main.

    Two of the target belt's items are out of ``by_profile_belt`` (``main#``
    target belt): the second was written before profiles (no ``profile_id``
    nor ``profile_belt``) and the third was moved from Cinza by code from
    before profiles (``profile_belt`` still ``main#Cinza``). Returns the
    target belt's items in sheet order.
    """
    belts = {belt_id(TARGET), belt_id(OTHER_BELT)}
    items = [item for item in seed_requirements() if item.belt_id in belts]
    for item in items:
        requirement_repo.create_requirement(item)
    sheet = [item for item in items if item.belt_id == belt_id(TARGET)]
    target = tables.table(REQUIREMENTS_TABLE_ENV)
    target.update_item(Key={"id": sheet[1].id}, UpdateExpression="REMOVE profile_id, profile_belt")
    target.update_item(
        Key={"id": sheet[2].id},
        UpdateExpression="SET profile_belt = :stale",
        ExpressionAttributeValues={":stale": _key(MAIN_PROFILE_ID, OTHER_BELT)},
    )
    return sheet


def _copy_profile(name: str = "Perfil do Sensei") -> str:
    """Create a profile copied from main and run its copy to the end."""
    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": name}), None)
    assert created["statusCode"] == 202, created["body"]
    profile_id = response_json(created)["id"]
    result = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert result["outcome"] == "READY", result
    return profile_id


@pytest.fixture
def copied_profile(main_items: list[Requirement], copy_invocations: CopyInvocations) -> str:
    return _copy_profile()


def _path(exam: Exam, requirement_id: str | None = None) -> dict[str, str]:
    path = {"id": exam.event_id, "student_id": exam.student_id}
    if requirement_id is not None:
        path["requirement_id"] = requirement_id
    return path


def _ok(response: dict[str, Any], status: int = 200) -> Any:
    assert response["statusCode"] == status, response["body"]
    return response_json(response)


def _sheet(exam: Exam) -> dict[str, Any]:
    return _ok(exam_handlers.get_exam_sheet(api_event(EXAMINER, path=_path(exam)), None))


def _mark(exam: Exam, requirement_id: str, correct: bool = True) -> dict[str, Any]:
    event = api_event(EXAMINER, path=_path(exam, requirement_id), body={"correct": correct})
    return exam_handlers.mark_answer(event, None)


def _unmark(exam: Exam, requirement_id: str) -> dict[str, Any]:
    return exam_handlers.unmark_answer(api_event(EXAMINER, path=_path(exam, requirement_id)), None)


def _list(**query: str) -> list[dict[str, Any]]:
    return _ok(requirement_handlers.list_requirements(api_event(EXAMINER, query=query), None))


def _ids(items: list[dict[str, Any]]) -> list[str]:
    return [item["id"] for item in items]


# --- the rule (pure) ------------------------------------------------------------


@pytest.mark.parametrize(
    ("profile_id", "profile_belt", "belt", "expected"),
    [
        (None, None, "b1", ("main", "main#b1")),  # written before profiles
        ("main", None, "b1", ("main", "main#b1")),
        ("main", "main#b0", "b1", ("main", "main#b1")),  # moved without profile_belt
        ("p2", "p2#b0", "b1", ("p2", "p2#b1")),  # another profile keeps its own
        (None, "main#b1", "b1", ("main", "main#b1")),
        ("main", "main#b1", "b1", None),
        ("p2", "p2#b1", "b1", None),
    ],
)
def test_rn017_profile_attributes_to_fix(
    profile_id: str | None, profile_belt: str | None, belt: str, expected: Any
) -> None:
    assert profile_attributes_to_fix(profile_id, profile_belt, belt) == expected


# --- migration v2 -----------------------------------------------------------------


def test_rn017_v2_fixes_items_without_profile_and_stale_profile_belts(seeded: list) -> None:
    _put_raw("legacy", OTHER_BELT, 1)  # (a) never had a profile
    _put_raw("no-key", OTHER_BELT, 2, profile_id=MAIN_PROFILE_ID)  # (b) profile, no key
    _put_raw(  # (b) moved to Azul by code from before profiles, with answers
        "moved",
        "Azul",
        3,
        profile_id=MAIN_PROFILE_ID,
        profile_belt=_key(MAIN_PROFILE_ID, OTHER_BELT),
        answer_count=2,
    )
    _put_raw("other", "Azul", 4, profile_id="p2", profile_belt=_key("p2", OTHER_BELT))
    _put_raw("right", OTHER_BELT, 5, profile_id="p2", profile_belt=_key("p2", OTHER_BELT))
    right_before = _raw("right")

    assert requirement_repo.migrate_profile_belts() == 4

    for requirement_id, profile_id, belt in (
        ("legacy", MAIN_PROFILE_ID, OTHER_BELT),
        ("no-key", MAIN_PROFILE_ID, OTHER_BELT),
        ("moved", MAIN_PROFILE_ID, "Azul"),
        ("other", "p2", "Azul"),
    ):
        stored = _raw(requirement_id)
        assert stored["profile_id"] == profile_id, requirement_id
        assert stored["profile_belt"] == _key(profile_id, belt), requirement_id
        assert stored["belt_id"] == belt_id(belt), requirement_id
    assert _raw("moved")["answer_count"] == 2
    assert _raw("right") == right_before
    assert _marker()
    # Now found where the main profile is read from, under the belt it is in.
    azul = requirement_repo._query_profile_belt(MAIN_PROFILE_ID, belt_id("Azul"))
    assert [item.id for item in azul] == ["moved"]
    cinza = requirement_repo._query_profile_belt(MAIN_PROFILE_ID, belt_id(OTHER_BELT))
    assert [item.id for item in cinza] == ["legacy", "no-key"]


def test_rn017_v2_is_idempotent_and_writes_only_the_two_attributes(exam_scenario: None) -> None:
    # The scenario's item t1 has an answer (answer_count 1) once marked.
    marked = exam_handlers.mark_answer(
        api_event(
            EXAMINER,
            path={"id": "event-1", "student_id": "student-1", "requirement_id": "t1"},
            body={"correct": True},
        ),
        None,
    )
    assert marked["statusCode"] == 200, marked["body"]
    tables.table(REQUIREMENTS_TABLE_ENV).update_item(
        Key={"id": "t1"}, UpdateExpression="REMOVE profile_id, profile_belt"
    )
    t1_before = _raw("t1")
    before = dynamodb_snapshot()

    assert requirement_repo.migrate_profile_belts() == 1
    first_run = dynamodb_snapshot()
    assert requirement_repo.migrate_profile_belts() == 0

    assert dynamodb_snapshot() == first_run
    for env in ("BELTS_TABLE", "STUDENTS_TABLE", "EXAMS_TABLE", "EVENTS_TABLE", "ANSWERS_TABLE"):
        assert first_run[env] == before[env], env
    assert len(first_run["SETTINGS_TABLE"]) == len(before["SETTINGS_TABLE"]) + 1
    assert len(first_run["REQUIREMENTS_TABLE"]) == len(before["REQUIREMENTS_TABLE"])
    assert _raw("t1") == {
        **t1_before,
        "profile_id": MAIN_PROFILE_ID,
        "profile_belt": f"main#{t1_before['belt_id']}",
    }
    assert t1_before["answer_count"] == 1


def test_rn017_v2_does_not_recreate_an_item_deleted_meanwhile(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", OTHER_BELT, 1)

    def delete() -> None:
        tables.table(REQUIREMENTS_TABLE_ENV).delete_item(Key={"id": "legacy"})

    triggered = before_dynamodb_call(monkeypatch, "UpdateItem", REQUIREMENTS_TABLE_ENV, delete)

    assert requirement_repo.migrate_profile_belts() == 0
    assert triggered  # the delete happened between the scan and the write
    assert _raw("legacy") is None
    assert _marker()


def test_rn017_v2_reads_again_an_item_moved_meanwhile_and_fixes_its_new_belt(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", OTHER_BELT, 1, answer_count=1)

    def move() -> None:  # code from before profiles, still answering
        tables.table(REQUIREMENTS_TABLE_ENV).update_item(
            Key={"id": "legacy"},
            UpdateExpression="SET belt_id = :belt",
            ExpressionAttributeValues={":belt": belt_id("Azul")},
        )

    before_dynamodb_call(monkeypatch, "UpdateItem", REQUIREMENTS_TABLE_ENV, move)

    assert requirement_repo.migrate_profile_belts() == 1
    stored = _raw("legacy")
    assert stored["belt_id"] == belt_id("Azul")
    assert stored["profile_id"] == MAIN_PROFILE_ID
    assert stored["profile_belt"] == _key(MAIN_PROFILE_ID, "Azul")
    assert stored["answer_count"] == 1
    assert _marker()


def test_rn017_v2_leaves_an_item_the_master_fixed_meanwhile(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", OTHER_BELT, 1)

    def master_edit() -> None:  # the new code writes both profile attributes
        body = {
            "belt_id": belt_id("Azul"),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": "Editado pelo master",
            "sort_order": 1,
        }
        response = requirement_handlers.update_requirement(
            api_event(MASTER, path={"id": "legacy"}, body=body), None
        )
        assert response["statusCode"] == 200, response["body"]

    before_dynamodb_call(monkeypatch, "UpdateItem", REQUIREMENTS_TABLE_ENV, master_edit)

    assert requirement_repo.migrate_profile_belts() == 0
    stored = _raw("legacy")
    assert stored["description"] == "Editado pelo master"
    assert stored["profile_belt"] == _key(MAIN_PROFILE_ID, "Azul")
    assert _marker()


def _conflict() -> ClientError:
    return ClientError(
        {"Error": {"Code": "TransactionConflictException", "Message": "x"}}, "UpdateItem"
    )


class _ConflictingTable:
    """The moto table, but the first ``conflicts`` updates meet a marking (RN006)."""

    def __init__(self, inner: Any, conflicts: int | None) -> None:
        self.inner = inner
        self.conflicts = conflicts
        self.updates = 0

    def update_item(self, **kwargs: Any) -> Any:
        self.updates += 1
        if self.conflicts is None or self.updates <= self.conflicts:
            raise _conflict()
        return self.inner.update_item(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


def _conflicting(monkeypatch: pytest.MonkeyPatch, conflicts: int | None) -> _ConflictingTable:
    real_table = requirement_repo.table
    wrapper = _ConflictingTable(real_table(REQUIREMENTS_TABLE_ENV), conflicts)
    monkeypatch.setattr(
        requirement_repo,
        "table",
        lambda env: wrapper if env == REQUIREMENTS_TABLE_ENV else real_table(env),
    )
    return wrapper


def test_rn017_v2_retries_a_write_that_meets_a_marking(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", OTHER_BELT, 1)
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: 0.0)
    wrapper = _conflicting(monkeypatch, conflicts=3)

    assert requirement_repo.migrate_profile_belts() == 1

    assert wrapper.updates == 4
    assert _raw("legacy")["profile_belt"] == _key(MAIN_PROFILE_ID, OTHER_BELT)
    assert _marker()


def _ticking(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each clock reading of ``retry_throttled`` advances one second; no real sleep."""
    real_retry = requirement_repo.retry_throttled
    ticks = iter(range(100_000))

    def ticking(call: Any, label: str, **kwargs: Any) -> Any:
        kwargs.update(sleep=lambda _seconds: None, clock=lambda: next(ticks))
        return real_retry(call, label, **kwargs)

    monkeypatch.setattr(requirement_repo, "retry_throttled", ticking)


def test_rn017_v2_conflict_that_never_ends_stops_at_the_deadline_without_marker(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", OTHER_BELT, 1)
    wrapper = _conflicting(monkeypatch, conflicts=None)
    _ticking(monkeypatch)

    with pytest.raises(DeadlineExceededError):
        requirement_repo.migrate_profile_belts(deadline=10)

    assert wrapper.updates > 1  # retried, not raised at the first conflict
    assert "profile_id" not in _raw("legacy")
    assert not _marker()


def test_rn017_v2_stopped_by_the_deadline_resumes_without_marker(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(1, 21):
        _put_raw(f"legacy-{index}", OTHER_BELT, index)
    real_retry = requirement_repo.retry_throttled
    _ticking(monkeypatch)

    with pytest.raises(DeadlineExceededError):
        requirement_repo.migrate_profile_belts(deadline=10)
    monkeypatch.setattr(requirement_repo, "retry_throttled", real_retry)

    assert not _marker()
    fixed = sum(1 for item in requirement_repo.list_all() if "profile_belt" in _raw(item.id))
    assert 0 < fixed < 20

    assert requirement_repo.migrate_profile_belts() == 20 - fixed
    assert _marker()


def _index_status(monkeypatch: pytest.MonkeyPatch, statuses: list[str | None]) -> list[str]:
    """Make ``DescribeTable`` report these statuses of ``by_profile_belt``, then the real one.

    None drops the index from the answer. Returns the statuses reported.
    """
    original = BaseClient._make_api_call
    reported: list[str] = []

    def describe(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        response = original(self, operation_name, api_params)
        if operation_name != "DescribeTable" or not statuses:
            return response
        status = statuses.pop(0)
        indexes = response["Table"]["GlobalSecondaryIndexes"]
        if status is None:
            response["Table"]["GlobalSecondaryIndexes"] = [
                index for index in indexes if index["IndexName"] != "by_profile_belt"
            ]
        else:
            for index in indexes:
                if index["IndexName"] == "by_profile_belt":
                    index["IndexStatus"] = status
        reported.append(str(status))
        return response

    monkeypatch.setattr(BaseClient, "_make_api_call", describe)
    return reported


def test_rn017_v2_marker_waits_for_the_index_to_be_active(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", OTHER_BELT, 1)
    reported = _index_status(monkeypatch, ["CREATING", "CREATING"])
    sleeps: list[float] = []
    real_wait = requirement_repo.wait_for_profile_index
    monkeypatch.setattr(
        requirement_repo,
        "wait_for_profile_index",
        lambda **kwargs: real_wait(**kwargs, sleep=sleeps.append),
    )

    assert requirement_repo.migrate_profile_belts() == 1

    assert reported == ["CREATING", "CREATING"]
    assert sleeps == [requirement_repo.INDEX_POLL_SECONDS] * 2
    assert _marker()


def test_rn017_v2_index_still_building_at_the_deadline_writes_no_marker(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _index_status(monkeypatch, ["CREATING"] * 100)
    now = [0.0]

    def sleep(seconds: float) -> None:
        now[0] += seconds

    with pytest.raises(DeadlineExceededError):
        requirement_repo.wait_for_profile_index(deadline=35.0, sleep=sleep, clock=lambda: now[0])

    assert 0 < now[0] < 35.0
    assert not _marker()


def test_rn017_v2_index_wait_at_the_deadline_raises_its_own_error(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _index_status(monkeypatch, ["CREATING"] * 100)
    now = [0.0]

    def sleep(seconds: float) -> None:
        now[0] += seconds

    with pytest.raises(requirement_repo.ProfileIndexNotActiveError, match="still CREATING"):
        requirement_repo.wait_for_profile_index(deadline=35.0, sleep=sleep, clock=lambda: now[0])

    # Three waits of 10 s; a fourth would end past the deadline (35 s).
    assert now[0] == 3 * requirement_repo.INDEX_POLL_SECONDS


def test_rn017_v2_index_wait_whose_sleep_ran_over_the_deadline_raises_its_own_error(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    reported = _index_status(monkeypatch, ["CREATING"] * 100)
    now = [0.0]

    def slow_sleep(seconds: float) -> None:
        now[0] += seconds + 30.0  # the Lambda was frozen or the sleep overshot

    with pytest.raises(requirement_repo.ProfileIndexNotActiveError):
        requirement_repo.wait_for_profile_index(
            deadline=35.0, sleep=slow_sleep, clock=lambda: now[0]
        )

    assert reported == ["CREATING"]  # no DescribeTable after the deadline


def _seed_event() -> dict[str, Any]:
    return {
        "RequestType": "Update",
        "ResponseURL": "https://example.invalid/r",
        "StackId": "s",
        "RequestId": "r",
        "LogicalResourceId": "InitialData",
        "PhysicalResourceId": "initial-data",
    }


def test_rn017_seed_handler_failed_with_its_own_message_when_the_index_outlasts_the_deadline(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirement_repo.seed_requirements(seed_requirements())
    _put_raw("legacy", OTHER_BELT, 900)
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(seed, "_send_response", lambda e, c, s, r: sent.append((s, r)))
    context = SimpleNamespace(get_remaining_time_in_millis=lambda: 900_000)

    with monkeypatch.context() as patch:
        reported = _index_status(patch, ["CREATING"] * 1_000)
        clock = fake_seed_time(patch)
        seed.handler(_seed_event(), context)

    assert sent == [("FAILED", seed.INDEX_DEADLINE_REASON)]
    assert seed.INDEX_DEADLINE_REASON != seed.DEADLINE_REASON
    assert "by_profile_belt" in seed.INDEX_DEADLINE_REASON
    assert "faça o deploy de novo" in seed.INDEX_DEADLINE_REASON
    # It waited for the index, one check every INDEX_POLL_SECONDS, up to the deadline.
    assert len(reported) > 1
    assert clock.sleeps == [requirement_repo.INDEX_POLL_SECONDS] * (len(reported) - 1)
    assert not _marker()
    # The items were fixed before the wait: the next deploy only checks again.
    assert _raw("legacy")["profile_belt"] == _key(MAIN_PROFILE_ID, OTHER_BELT)

    # Next deploy, with the index built: the migration ends and writes the marker.
    seed.handler(_seed_event(), context)
    assert sent[-1] == ("SUCCESS", "OK")
    assert _marker()


def test_rn017_seed_handler_keeps_the_capacity_message_when_describe_table_is_throttled(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Throttling while checking the index is lack of capacity, not the index being built.
    requirement_repo.seed_requirements(seed_requirements())
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: high)
    fake_seed_time(monkeypatch)
    stub = throttle_dynamodb(monkeypatch, "DescribeTable", REQUIREMENTS_TABLE_ENV, max_calls=10_000)
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(seed, "_send_response", lambda e, c, s, r: sent.append((s, r)))

    seed.handler(_seed_event(), SimpleNamespace(get_remaining_time_in_millis=lambda: 900_000))

    assert sent == [("FAILED", seed.DEADLINE_REASON)]
    assert len(stub.calls) > 1
    assert not _marker()


def test_rn017_v2_without_the_index_fails_and_writes_no_marker(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _index_status(monkeypatch, [None])

    with pytest.raises(RuntimeError, match="by_profile_belt"):
        requirement_repo.migrate_profile_belts()

    assert not _marker()


def test_rn017_seed_handler_runs_v2_after_v1_and_fixes_what_v1_skipped(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirement_repo.seed_requirements(seed_requirements())
    _put_raw("legacy", OTHER_BELT, 900)

    def move() -> None:  # between v1's scan and its write: v1 skips the item
        tables.table(REQUIREMENTS_TABLE_ENV).update_item(
            Key={"id": "legacy"},
            UpdateExpression="SET belt_id = :belt",
            ExpressionAttributeValues={":belt": belt_id("Azul")},
        )

    before_dynamodb_call(monkeypatch, "UpdateItem", REQUIREMENTS_TABLE_ENV, move)

    # v1 skipped it (0); v2 put it in main under its new belt (1).
    assert seed.seed_all() == {"belts": 0, "requirements": 0, "requirement_profiles": 1}
    assert seed.seed_all() == {"belts": 0, "requirements": 0, "requirement_profiles": 0}
    stored = _raw("legacy")
    assert stored["profile_belt"] == _key(MAIN_PROFILE_ID, "Azul")
    assert _marker()
    settings = tables.table(SETTINGS_TABLE_ENV)
    assert settings.get_item(
        Key={"id": requirement_repo.PROFILE_MIGRATION_MARKER_ID}, ConsistentRead=True
    ).get("Item")


# --- before the v2 marker: the main profile stays complete -------------------------


def test_rn017_before_the_v2_marker_main_lists_keep_items_missing_from_the_index(
    main_items: list[Requirement], reads: Reads
) -> None:
    # v1 already ran on this stack; v2 has not finished (a deploy in progress).
    requirement_repo.migrate_to_main_profile()
    missing = {main_items[2].id}  # still main#Cinza in the index after v1
    in_index = {
        item.id for item in requirement_repo._query_profile_belt(MAIN_PROFILE_ID, belt_id(TARGET))
    }
    assert missing.isdisjoint(in_index)
    reads.clear()

    by_belt = _list(belt_id=belt_id(TARGET))
    everything = _list()

    assert _ids(by_belt) == [item.id for item in main_items]
    assert set(_ids(by_belt)) <= set(_ids(everything))
    assert reads.of_requirements() == [BY_BELT, "Scan"]
    assert len(reads.of_marker()) == 2  # not seen: read again on each request


def test_rn006_rn007_before_the_v2_marker_sheet_and_score_keep_every_main_item(
    main_items: list[Requirement], reads: Reads
) -> None:
    reads.clear()
    sheet = _sheet(exam_repo.get_exam("event-1", "student-1"))

    assert [item["id"] for item in sheet["items"]] == [item.id for item in main_items]
    assert sheet["summary"]["THEORY"]["total"] == 11
    assert sheet["summary"]["PRACTICE"]["total"] == 13
    assert reads.of_requirements() == [BY_BELT]

    marked = _ok(_mark(exam_repo.get_exam("event-1", "student-1"), main_items[1].id))
    assert marked["summary"]["THEORY"]["total"] == 11


# --- after the v2 marker: only by_profile_belt --------------------------------------


def test_rn006_rn007_rn017_after_the_v2_marker_reads_query_only_by_profile_belt(
    copied_profile: str, main_items: list[Requirement], reads: Reads
) -> None:
    exam = exam_repo.get_exam("event-1", "student-1")
    before = {
        "sheet": _sheet(exam),
        "belt": _list(belt_id=belt_id(TARGET)),
        "all": _list(),
        "copy belt": _list(profile_id=copied_profile, belt_id=belt_id(TARGET)),
        "copy all": _list(profile_id=copied_profile),
    }
    assert reads.of_requirements().count(BY_BELT) >= 1  # the fallback, so far

    assert requirement_repo.migrate_profile_belts() == 2  # the two items the index missed

    routes = {
        "sheet": lambda: _sheet(exam),
        "belt": lambda: _list(belt_id=belt_id(TARGET)),
        "all": lambda: _list(),
        "copy belt": lambda: _list(profile_id=copied_profile, belt_id=belt_id(TARGET)),
        "copy all": lambda: _list(profile_id=copied_profile),
    }
    for name, route in routes.items():
        reads.clear()
        # Same items, same order, same score as through the fallback.
        assert route() == before[name], name
        expected = [BY_PROFILE_BELT] * (len(SEED_BELTS) if "all" in name else 1)
        assert reads.of_requirements() == expected, name

    for name, call in {
        "mark": lambda: _mark(exam, main_items[1].id),
        "unmark": lambda: _unmark(exam, main_items[1].id),
        "create": lambda: requirement_handlers.create_requirement(
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
        ),
    }.items():
        reads.clear()
        response = call()
        assert response["statusCode"] in {200, 201}, (name, response["body"])
        assert reads.of_requirements() == [BY_PROFILE_BELT], name
        if name != "create":
            assert response_json(response)["summary"]["THEORY"]["total"] == 11, name


def test_rn017_after_the_v2_marker_the_copy_of_main_reads_only_by_profile_belt(
    main_items: list[Requirement], copy_invocations: CopyInvocations, reads: Reads
) -> None:
    requirement_repo.migrate_profile_belts()
    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": "Novo"}), None)
    profile_id = _ok(created, 202)["id"]
    reads.clear()

    result = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )

    assert result["outcome"] == "READY", result
    # Every main item of the two belts, the two the index missed included.
    assert result["copied"] == len(seed_requirements_of(TARGET, OTHER_BELT))
    # Per belt: the source (main) and what was already copied.
    assert reads.of_requirements() == [BY_PROFILE_BELT] * (2 * len(SEED_BELTS))


def seed_requirements_of(*belts: str) -> list[Requirement]:
    wanted = {belt_id(name) for name in belts}
    return [item for item in seed_requirements() if item.belt_id in wanted]


def test_rn006_after_the_v2_marker_an_item_of_another_profile_is_still_refused(
    copied_profile: str, main_items: list[Requirement]
) -> None:
    requirement_repo.migrate_profile_belts()
    exam = exam_repo.get_exam("event-1", "student-1")
    copy_item = next(
        item
        for item in requirement_repo.list_profile_belt(copied_profile, belt_id(TARGET))
        if item.kind == RequirementKind.THEORY
    )

    response = _mark(exam, copy_item.id)

    assert response["statusCode"] == 400, response["body"]
    assert response_json(response) == {
        "message": "Item não pertence ao perfil de requisitos do exame"
    }
    assert len(_sheet(exam)["items"]) == 24


# --- the marker, read until seen, then kept per container -------------------------------


def test_rn017_marker_is_read_on_each_request_until_seen_then_kept(
    main_items: list[Requirement], reads: Reads
) -> None:
    exam = exam_repo.get_exam("event-1", "student-1")
    reads.clear()
    for _ in range(3):
        _sheet(exam)
    assert len(reads.of_marker()) == 3
    assert reads.of_requirements() == [BY_BELT] * 3

    requirement_repo.migrate_profile_belts()
    reads.clear()
    for _ in range(3):
        _sheet(exam)

    assert len(reads.of_marker()) == 1  # seen once, then kept in memory
    assert reads.of_requirements() == [BY_PROFILE_BELT] * 3
    # Eventually consistent (0.5 RCU) and only the key: missing a marker written
    # a moment ago only keeps the fallback one request longer.
    [marker_read] = reads.of_marker()
    assert "ConsistentRead" not in marker_read
    assert marker_read["ProjectionExpression"] == "#id"

    requirement_repo.reset_cache()  # a new container reads it once again
    reads.clear()
    _sheet(exam)
    assert len(reads.of_marker()) == 1


def test_rn017_eventual_read_that_misses_the_marker_keeps_the_complete_fallback(
    main_items: list[Requirement], reads: Reads, monkeypatch: pytest.MonkeyPatch
) -> None:
    lag_eventual_reads(monkeypatch, SETTINGS_TABLE_ENV)
    requirement_repo.migrate_profile_belts()
    assert _marker()  # written, but the eventual read still answers "absent"
    exam = exam_repo.get_exam("event-1", "student-1")
    reads.clear()

    sheet = _sheet(exam)

    assert [item["id"] for item in sheet["items"]] == [item.id for item in main_items]
    assert reads.of_requirements() == [BY_BELT]
    assert requirement_repo.profile_index_complete() is False  # nothing kept


def test_rn017_marker_read_throttled_answers_503(
    main_items: list[Requirement], monkeypatch: pytest.MonkeyPatch
) -> None:
    exam = exam_repo.get_exam("event-1", "student-1")
    stub = throttle_dynamodb(
        monkeypatch,
        "GetItem",
        SETTINGS_TABLE_ENV,
        matches=lambda params: params.get("Key") == {"id": MARKER},
    )

    response = exam_handlers.get_exam_sheet(api_event(EXAMINER, path=_path(exam)), None)

    assert_service_busy(response, stub)
