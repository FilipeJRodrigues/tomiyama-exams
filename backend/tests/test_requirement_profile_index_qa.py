"""QA coverage of step 3a of #144 (RN017; RN006/RN007 for the sheet): v2 migration and reads.

Cases the step's own tests leave out:

- the wait for ``by_profile_belt`` when ``DescribeTable`` is throttled (retried,
  and stopped by the deadline without the marker, keeping the fixes made) and
  when the index is ``UPDATING`` (the same deploy changes its read capacity);
- the v2 scan over several pages;
- the seed handler answering ``FAILED`` (no v2 marker) when the index is missing;
- the background copy of the main profile retrying a throttled marker read;
- an item of another profile whose ``profile_belt`` points at the main
  profile: never in the main sheet, before or after the v2 marker (no mixing);
- the seed function keeps ``DynamoDBCrudPolicy`` on ``Requirements``, the SAM
  policy that grants the ``DescribeTable`` of the wait.
"""

from dataclasses import replace
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from cfnlint.decode import decode
from conftest import (
    EXAMINER,
    CopyInvocations,
    api_event,
    belt_id,
    make_student,
    response_json,
)

from domain import dates
from domain.events import EventStatus, ExamEvent
from domain.requirement_profiles import MAIN_PROFILE_ID
from domain.requirements import seed_requirements
from handlers import exams as exam_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as profile_handlers
from handlers import requirements as requirement_handlers
from handlers import seed
from repository import events as event_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV, SETTINGS_TABLE_ENV, DeadlineExceededError

TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)
MARKER = requirement_repo.PROFILE_BELT_MIGRATION_MARKER_ID
TEMPLATE = Path(__file__).resolve().parents[2] / "infra" / "template.yaml"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: NOW)


def _raw(requirement_id: str) -> dict[str, Any] | None:
    return (
        tables.table(REQUIREMENTS_TABLE_ENV)
        .get_item(Key={"id": requirement_id}, ConsistentRead=True)
        .get("Item")
    )


def _put_raw(requirement_id: str, belt: str, sort_order: int, **extra: Any) -> None:
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


class _Describe:
    """``DescribeTable`` on ``Requirements``: throttled, or with a forced index status."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, plan: list[str]) -> None:
        # Each entry: "throttle" (ThrottlingException) or an IndexStatus of
        # by_profile_belt; once the plan is used up, moto answers unchanged.
        self.plan = list(plan)
        self.calls = 0
        original = BaseClient._make_api_call

        def patched(client: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
            if operation_name != "DescribeTable":
                return original(client, operation_name, api_params)
            self.calls += 1
            step = self.plan.pop(0) if self.plan else None
            if step == "throttle":
                raise ClientError(
                    {"Error": {"Code": "ThrottlingException", "Message": "Rate exceeded"}},
                    operation_name,
                )
            response = original(client, operation_name, api_params)
            if step is not None:
                for index in response["Table"]["GlobalSecondaryIndexes"]:
                    if index["IndexName"] == requirement_repo.BY_PROFILE_BELT_INDEX:
                        index["IndexStatus"] = step
            return response

        monkeypatch.setattr(BaseClient, "_make_api_call", patched)


def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tables.random, "uniform", lambda low, high: 0.0)


# --- waiting for the index ------------------------------------------------------------


def test_rn017_qa_v2_wait_retries_a_throttled_describe_table(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", "Cinza", 1)
    _no_backoff(monkeypatch)
    describe = _Describe(monkeypatch, ["throttle", "throttle"])

    assert requirement_repo.migrate_profile_belts() == 1

    assert describe.calls == 3
    assert _marker()


def test_rn017_qa_v2_describe_table_throttled_until_the_deadline_keeps_fixes_without_marker(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", "Cinza", 1)
    _Describe(monkeypatch, ["throttle"] * 1_000)
    real_retry = requirement_repo.retry_throttled
    ticks = iter(range(100_000))

    def ticking(call: Any, label: str, **kwargs: Any) -> Any:
        kwargs.update(sleep=lambda _seconds: None, clock=lambda: next(ticks))
        return real_retry(call, label, **kwargs)

    monkeypatch.setattr(requirement_repo, "retry_throttled", ticking)

    with pytest.raises(DeadlineExceededError):
        requirement_repo.migrate_profile_belts(deadline=10)

    assert not _marker()
    # The fix was written before the wait: the next deploy only checks again.
    assert _raw("legacy")["profile_belt"] == f"main#{belt_id('Cinza')}"


def test_rn017_qa_v2_waits_while_the_index_is_updating_its_capacity(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The same deploy changes the read capacity of by_profile_belt (1 -> 5).
    monkeypatch.setattr(requirement_repo, "INDEX_POLL_SECONDS", 0)
    describe = _Describe(monkeypatch, ["UPDATING", "UPDATING"])

    requirement_repo.migrate_profile_belts()

    assert describe.calls == 3
    assert _marker()


def test_rn017_qa_v2_scans_every_page(seeded: list, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(requirement_repo, "MIGRATION_PAGE_SIZE", 3)
    for index in range(1, 11):
        _put_raw(f"legacy-{index}", "Cinza", index)
    scans: list[dict[str, Any]] = []
    original = BaseClient._make_api_call

    def spy(client: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name == "Scan":
            scans.append(api_params)
        return original(client, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", spy)

    assert requirement_repo.migrate_profile_belts() == 10

    assert len(scans) >= 4
    assert all(scan["Limit"] == 3 for scan in scans)
    ids = [
        item.id for item in requirement_repo._query_profile_belt(MAIN_PROFILE_ID, belt_id("Cinza"))
    ]
    assert ids == [f"legacy-{index}" for index in range(1, 11)]
    assert _marker()


def test_rn017_qa_seed_handler_fails_without_the_index_and_writes_no_v2_marker(
    seeded: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = BaseClient._make_api_call

    def without_index(client: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        response = original(client, operation_name, api_params)
        if operation_name == "DescribeTable":
            response["Table"]["GlobalSecondaryIndexes"] = [
                index
                for index in response["Table"]["GlobalSecondaryIndexes"]
                if index["IndexName"] != requirement_repo.BY_PROFILE_BELT_INDEX
            ]
        return response

    monkeypatch.setattr(BaseClient, "_make_api_call", without_index)
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(seed, "_send_response", lambda e, c, s, r: sent.append((s, r)))
    event = {
        "RequestType": "Update",
        "ResponseURL": "https://example.invalid/r",
        "StackId": "s",
        "RequestId": "r",
        "LogicalResourceId": "InitialData",
        "PhysicalResourceId": "initial-data",
    }

    seed.handler(event, SimpleNamespace(get_remaining_time_in_millis=lambda: 900_000))

    [(status, reason)] = sent
    assert status == "FAILED"
    assert reason.startswith("Falha na carga inicial")
    assert not _marker()


# --- the background copy -----------------------------------------------------------------


def test_rn017_qa_copy_of_main_retries_a_throttled_marker_read(
    seeded: list, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    _put_raw("legacy", "Cinza", 1)  # before profiles: only the fallback finds it
    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": "Novo"}), None)
    assert created["statusCode"] == 202, created["body"]
    profile_id = response_json(created)["id"]
    _no_backoff(monkeypatch)
    throttled = {"left": 2}
    original = BaseClient._make_api_call

    def marker_throttled(
        client: BaseClient, operation_name: str, api_params: dict[str, Any]
    ) -> Any:
        if (
            operation_name == "GetItem"
            and api_params.get("Key") == {"id": MARKER}
            and throttled["left"] > 0
        ):
            throttled["left"] -= 1
            raise ClientError(
                {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
                operation_name,
            )
        return original(client, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", marker_throttled)

    result = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )

    assert result["outcome"] == "READY", result
    assert throttled["left"] == 0
    copied = requirement_repo.list_profile_belt(profile_id, belt_id("Cinza"))
    assert [item.description for item in copied] == ["Item legacy"]


# --- no mixing of profiles, before and after the marker ------------------------------------


@pytest.fixture
def exam_event(seeded: list) -> ExamEvent:
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
    return exam_event


def _sheet_ids() -> list[str]:
    response = exam_handlers.get_exam_sheet(
        api_event(EXAMINER, path={"id": "event-1", "student_id": "student-1"}), None
    )
    assert response["statusCode"] == 200, response["body"]
    return [item["id"] for item in response_json(response)["items"]]


def _main_list_ids(**query: str) -> list[str]:
    response = requirement_handlers.list_requirements(api_event(EXAMINER, query=query), None)
    assert response["statusCode"] == 200, response["body"]
    return [item["id"] for item in response_json(response)]


def test_rn006_rn017_qa_item_of_another_profile_never_enters_the_main_sheet(
    exam_event: ExamEvent,
) -> None:
    target = belt_id(TARGET)
    for item in seed_requirements():
        if item.belt_id == target:
            requirement_repo.create_requirement(item)
    main_ids = [item.id for item in requirement_repo.list_profile_belt(MAIN_PROFILE_ID, target)]
    # A copy whose index key points at the main profile, and one with no key.
    _put_raw("p2-wrong-key", TARGET, 1, profile_id="p2", profile_belt=f"main#{target}")
    _put_raw("p2-no-key", TARGET, 2, profile_id="p2")

    before = (_sheet_ids(), _main_list_ids(belt_id=target), _main_list_ids())
    assert requirement_repo.migrate_profile_belts() == 2
    after = (_sheet_ids(), _main_list_ids(belt_id=target), _main_list_ids())

    for ids in (*before, *after):
        assert sorted(ids) == sorted(main_ids)
    assert before == after
    assert _raw("p2-wrong-key")["profile_belt"] == f"p2#{target}"
    assert _raw("p2-no-key")["profile_belt"] == f"p2#{target}"


# --- template -----------------------------------------------------------------------------


def test_rn017_qa_seed_function_can_describe_the_requirements_table() -> None:
    # SAM's DynamoDBCrudPolicy grants dynamodb:DescribeTable on the table, which
    # wait_for_profile_index needs; a hand-written policy must keep it.
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    policies = parsed["Resources"]["SeedFunction"]["Properties"]["Policies"]

    assert {"DynamoDBCrudPolicy": {"TableName": {"Ref": "RequirementsTable"}}} in policies
