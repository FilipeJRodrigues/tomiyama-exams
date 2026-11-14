"""``Requirements`` without the old ``by_belt`` index (#144, step 3c; RN006, RN007, RN017).

``by_profile_belt`` is the table's only GSI. Until the v2 migration marker is
seen, the main profile is read with a ``Scan`` of the table (the complete
fallback that never leaves out an item still without ``profile_belt``, or
under the key of a belt it was moved from), with or without a belt; once the
marker is seen, every read of a profile's items is a query on
``by_profile_belt`` and nothing scans. ``by_profile_belt`` does not project
``answer_count``, so the first mark of an item (RN006) writes no GSI.
"""

import os
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.client import BaseClient
from conftest import (
    EXAMINER,
    MASTER,
    REQUIREMENT_PROFILE_BELT_ATTRIBUTES,
    SCENARIO_ROUTES,
    CopyInvocations,
    api_event,
    assert_service_busy,
    belt_id,
    dynamodb_snapshot,
    make_student,
    response_json,
    throttle_dynamodb,
)

from domain import dates
from domain.belts import SEED_BELTS
from domain.events import EventStatus, ExamEvent
from domain.exams import Exam
from domain.requirement_profiles import MAIN_PROFILE_ID
from domain.requirements import Requirement, RequirementKind
from handlers import exams as exam_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profiles as profile_handlers
from handlers import requirements as requirement_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV

TODAY = date(2026, 11, 1)
NOW = "2026-11-01T12:00:00+00:00"
MARKED_AT = "2027-03-20T13:45:00+00:00"
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)
OTHER_BELT = "Cinza"
SCAN = "Scan"
BY_PROFILE_BELT = f"Query {requirement_repo.BY_PROFILE_BELT_INDEX}"


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: TODAY)
    monkeypatch.setattr(dates, "utc_now_iso", lambda: MARKED_AT)


class Reads:
    """``Query``/``Scan`` calls on ``Requirements`` since the last ``clear``."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def clear(self) -> None:
        self.calls.clear()

    def names(self) -> list[str]:
        """Each read as ``"Scan"`` or ``"Query <index>"``, in order."""
        return [f"{call['operation']} {call.get('IndexName', '')}".strip() for call in self.calls]


@pytest.fixture
def reads(monkeypatch: pytest.MonkeyPatch) -> Reads:
    spied = Reads()
    original = BaseClient._make_api_call
    table_name = os.environ[REQUIREMENTS_TABLE_ENV]

    def spy(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if operation_name in {"Query", "Scan"} and api_params.get("TableName") == table_name:
            spied.calls.append({"operation": operation_name, **api_params})
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", spy)
    return spied


def _put_raw(requirement_id: str, belt: str, sort_order: int, **extra: Any) -> None:
    """Write an item straight to the table, as code from before profiles left it."""
    tables.table(REQUIREMENTS_TABLE_ENV).put_item(
        Item={
            "id": requirement_id,
            "belt_id": belt_id(belt),
            "kind": "THEORY",
            "category": "Vocabulário",
            "description": f"Item {requirement_id}",
            "expected_answer": "Resposta",
            "sort_order": sort_order,
            **extra,
        }
    )


def _item(requirement_id: str, belt: str, sort_order: int, **changes: Any) -> Requirement:
    return Requirement(
        id=requirement_id,
        belt_id=belt_id(belt),
        kind=changes.pop("kind", RequirementKind.THEORY),
        category="Vocabulário",
        description=f"Item {requirement_id}",
        expected_answer="Resposta",
        sort_order=sort_order,
        **changes,
    )


@pytest.fixture
def exam(seeded: None) -> Exam:
    """An exam in progress for Ana (Cinza → Cinza/Azul) in an open event of the main profile."""
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
def mixed_items(exam: Exam) -> list[str]:
    """Target-belt items the index misses, written out of sheet order, plus noise.

    In the target belt, in main: ``m1`` (order 1) and ``m4`` (order 4) as the
    new code writes them; ``legacy`` (order 2) without ``profile_id`` nor
    ``profile_belt`` (written before profiles); ``moved`` (order 3) still
    under ``main#Cinza`` (moved by code from before profiles); ``tie-a`` and
    ``tie-b`` (both order 5). Noise: an item of another profile in the target
    belt and a main item of another belt. Returns the main ids of the target
    belt in sheet order.
    """
    requirement_repo.create_requirement(_item("m4", TARGET, 4))
    requirement_repo.create_requirement(_item("tie-b", TARGET, 5))
    _put_raw("legacy", TARGET, 2)
    _put_raw(
        "moved",
        TARGET,
        3,
        profile_id=MAIN_PROFILE_ID,
        profile_belt=f"{MAIN_PROFILE_ID}#{belt_id(OTHER_BELT)}",
    )
    requirement_repo.create_requirement(_item("tie-a", TARGET, 5))
    requirement_repo.create_requirement(_item("m1", TARGET, 1, kind=RequirementKind.PRACTICE))
    requirement_repo.create_requirement(_item("other-profile", TARGET, 1, profile_id="p2"))
    requirement_repo.create_requirement(_item("other-belt", OTHER_BELT, 1))
    return ["m1", "legacy", "moved", "m4", "tie-a", "tie-b"]


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


def _mark(exam: Exam, requirement_id: str) -> dict[str, Any]:
    event = api_event(EXAMINER, path=_path(exam, requirement_id), body={"correct": True})
    return _ok(exam_handlers.mark_answer(event, None))


def _unmark(exam: Exam, requirement_id: str) -> dict[str, Any]:
    event = api_event(EXAMINER, path=_path(exam, requirement_id))
    return _ok(exam_handlers.unmark_answer(event, None))


def _list(**query: str) -> list[dict[str, Any]]:
    return _ok(requirement_handlers.list_requirements(api_event(EXAMINER, query=query), None))


# --- before the v2 marker: a Scan of the table, complete --------------------------------


def test_rn017_before_the_marker_main_belt_is_a_scan_with_every_item_in_sheet_order(
    mixed_items: list[str], reads: Reads
) -> None:
    reads.clear()

    items = requirement_repo.list_profile_belt(MAIN_PROFILE_ID, belt_id(TARGET))

    # The item without profile attributes and the one under a stale key are in;
    # another profile's item and another belt's are out; ties go by id.
    assert [item.id for item in items] == mixed_items
    assert all(item.profile_id == MAIN_PROFILE_ID for item in items)
    assert reads.names() == [SCAN]
    # Eventually consistent, as the GSI it replaces (0.5 RCU per 4 KB).
    assert "ConsistentRead" not in reads.calls[0]


def test_rn017_before_the_marker_the_index_alone_would_miss_items(
    mixed_items: list[str],
) -> None:
    # What the fallback protects from: the index misses the two items not migrated.
    in_index = requirement_repo._query_profile_belt(MAIN_PROFILE_ID, belt_id(TARGET))

    assert {item.id for item in in_index} == set(mixed_items) - {"legacy", "moved"}


def test_rn017_before_the_marker_main_belts_are_one_scan_belt_by_belt(
    mixed_items: list[str], reads: Reads
) -> None:
    reads.clear()

    items = requirement_repo.list_profile_belts(
        MAIN_PROFILE_ID, [belt_id(TARGET), belt_id(OTHER_BELT), belt_id("Azul")]
    )

    # One Scan for every belt, the answer shaped as the index gives it: belt by
    # belt in the order asked, each in sheet order.
    assert [item.id for item in items] == [*mixed_items, "other-belt"]
    assert reads.names() == [SCAN]


def test_rn006_rn007_before_the_marker_sheet_mark_and_unmark_keep_every_main_item(
    mixed_items: list[str], exam: Exam, reads: Reads
) -> None:
    reads.clear()

    sheet = _sheet(exam)
    marked = _mark(exam, "legacy")
    unmarked = _unmark(exam, "moved")

    assert [item["id"] for item in sheet["items"]] == mixed_items
    assert sheet["summary"]["THEORY"]["total"] == 5
    assert sheet["summary"]["PRACTICE"]["total"] == 1
    # The item without profile attributes can be marked, and counts.
    assert marked["summary"]["THEORY"] == {
        "kind": "THEORY",
        "total": 5,
        "marked": 1,
        "correct": 1,
        "percent": 20.0,
    }
    assert unmarked["summary"]["THEORY"]["total"] == 5
    assert reads.names() == [SCAN] * 3


def test_rn017_before_the_marker_requirement_routes_keep_every_main_item(
    mixed_items: list[str], reads: Reads
) -> None:
    reads.clear()

    one_belt = _list(belt_id=belt_id(TARGET))
    everything = _list()
    created = requirement_handlers.create_requirement(
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
    )

    assert [item["id"] for item in one_belt] == mixed_items
    assert set(mixed_items) | {"other-belt"} <= {item["id"] for item in everything}
    assert "other-profile" not in {item["id"] for item in everything}
    # The default order counts the items the index misses: after tie-a/tie-b (5).
    assert _ok(created, 201)["sort_order"] == 6
    assert reads.names() == [SCAN, SCAN, SCAN]


def test_rn017_before_the_marker_a_copy_of_main_copies_the_items_the_index_misses(
    mixed_items: list[str], copy_invocations: CopyInvocations, reads: Reads
) -> None:
    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": "Novo"}), None)
    profile_id = _ok(created, 202)["id"]
    reads.clear()

    result = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )

    assert result["outcome"] == "READY", result
    assert result["copied"] == len(mixed_items) + 1  # and the main item of Cinza
    # Per belt: the main source (Scan) and what was already copied (the index).
    assert reads.names() == [SCAN, BY_PROFILE_BELT] * len(SEED_BELTS)
    copied = requirement_repo.list_profile_belt(profile_id, belt_id(TARGET))
    # The copies have ids of their own: compare the order and the descriptions.
    assert sorted((item.sort_order, item.description) for item in copied) == [
        (1, "Item m1"),
        (2, "Item legacy"),
        (3, "Item moved"),
        (4, "Item m4"),
        (5, "Item tie-a"),
        (5, "Item tie-b"),
    ]


# --- after the v2 marker: only by_profile_belt, never a Scan -----------------------------


def test_rn006_rn007_rn017_after_the_marker_no_route_scans_the_table(
    mixed_items: list[str], exam: Exam, copy_invocations: CopyInvocations, reads: Reads
) -> None:
    assert requirement_repo.migrate_profile_belts() == 2  # legacy and moved
    routes = {
        "sheet": lambda: _sheet(exam),
        "mark": lambda: _mark(exam, "legacy"),
        "unmark": lambda: _unmark(exam, "legacy"),
        "list belt": lambda: _list(belt_id=belt_id(TARGET)),
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
    }
    for name, route in routes.items():
        reads.clear()
        route()
        assert reads.names() == [BY_PROFILE_BELT], name

    reads.clear()
    _list()
    assert reads.names() == [BY_PROFILE_BELT] * len(SEED_BELTS)

    created = profile_handlers.create_profile(api_event(EXAMINER, body={"name": "Novo"}), None)
    profile_id = _ok(created, 202)["id"]
    reads.clear()
    result = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert result["outcome"] == "READY", result
    assert reads.names() == [BY_PROFILE_BELT] * (2 * len(SEED_BELTS))


@pytest.mark.parametrize(
    "route",
    [
        "GET /requirements",
        "GET /requirements?belt_id",
        "POST /requirements",
        "GET /events/{id}/exams/{student_id}",
    ],
)
def test_rn017_after_the_marker_a_throttled_index_query_answers_503(
    exam_scenario: None, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    # The reads of test_throttling_routes.py, once the main profile goes
    # through the index (that file's scenario has no marker: the fallback).
    requirement_repo.migrate_profile_belts()
    before = dynamodb_snapshot()
    stub = throttle_dynamodb(
        monkeypatch,
        "Query",
        REQUIREMENTS_TABLE_ENV,
        matches=lambda params: params.get("IndexName") == requirement_repo.BY_PROFILE_BELT_INDEX,
    )

    response = SCENARIO_ROUTES[route]()
    stub.active = False

    assert_service_busy(response, stub)
    assert dynamodb_snapshot() == before


def test_rn017_after_the_marker_the_index_has_every_main_item(mixed_items: list[str]) -> None:
    requirement_repo.migrate_profile_belts()

    items = requirement_repo.list_profile_belt(MAIN_PROFILE_ID, belt_id(TARGET))

    # The index orders ties by its own rule: compare as a set.
    assert {item.id for item in items} == set(mixed_items)
    assert [item.sort_order for item in items] == [1, 2, 3, 4, 5, 5]


# --- the table: one GSI, and the first mark writes none -----------------------------------


def test_rn017_test_table_mirrors_the_template_without_by_belt(aws: None) -> None:
    description = tables.table(REQUIREMENTS_TABLE_ENV).meta.client.describe_table(
        TableName=os.environ[REQUIREMENTS_TABLE_ENV]
    )["Table"]

    assert [index["IndexName"] for index in description["GlobalSecondaryIndexes"]] == [
        requirement_repo.BY_PROFILE_BELT_INDEX
    ]
    assert {item["AttributeName"] for item in description["AttributeDefinitions"]} == {
        "id",
        "sort_order",
        "profile_belt",
    }
    [index] = description["GlobalSecondaryIndexes"]
    assert index["Projection"] == {
        "ProjectionType": "INCLUDE",
        "NonKeyAttributes": REQUIREMENT_PROFILE_BELT_ATTRIBUTES,
    }


def _index_entries(belt: str) -> list[dict[str, Any]]:
    """What ``by_profile_belt`` holds for the main profile in a belt, as stored."""
    return list(
        tables.paginate(
            tables.table(REQUIREMENTS_TABLE_ENV).query,
            IndexName=requirement_repo.BY_PROFILE_BELT_INDEX,
            KeyConditionExpression="profile_belt = :key",
            ExpressionAttributeValues={":key": f"{MAIN_PROFILE_ID}#{belt_id(belt)}"},
        )
    )


def test_rn006_first_mark_of_an_item_writes_no_gsi(exam: Exam) -> None:
    requirement_repo.create_requirement(_item("t1", TARGET, 1))
    requirement_repo.migrate_profile_belts()
    before = _index_entries(TARGET)

    _mark(exam, "t1")

    stored = tables.table(REQUIREMENTS_TABLE_ENV).get_item(Key={"id": "t1"}, ConsistentRead=True)
    assert stored["Item"]["answer_count"] == 1  # the table item changed...
    # ...but nothing projected into the only GSI did: DynamoDB writes a GSI
    # only when a key or projected attribute changes, so this mark wrote none.
    assert _index_entries(TARGET) == before
    assert all("answer_count" not in entry for entry in before)
