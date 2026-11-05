"""Throttled strongly consistent reads by key answer 503 on every route (#78).

Since #78 the reads by key of the exam, the student, the student's
``exam_in_progress_id`` marker and the settings use ``ConsistentRead=True``,
and so does the re-read of the student after a refused edit. Here only those
``GetItem`` calls (at the botocore level, so any path the repository takes is
covered) raise ``ProvisionedThroughputExceededException``, as when the
throttling outlasts botocore's retries: the route must answer 503 "Sistema
ocupado no momento. Tente de novo em instantes.", never 500. The re-reads of
the attendance and the decision are covered by
``regression/test_2026_11_02_*_releitura_limitada_da_500.py``.
"""

import os
from collections.abc import Callable
from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from botocore.client import BaseClient
from botocore.exceptions import ClientError
from conftest import EXAMINER, GUARDIAN, api_event, make_student

from domain import dates
from domain.errors import MSG_SERVICE_BUSY
from domain.events import EventStatus, ExamEvent
from domain.settings import AcademySettings
from domain.users import ADMIN_GROUP, User
from handlers import exams as exam_handlers
from handlers import settings as settings_handlers
from handlers import students as student_handlers
from repository import events as event_repo
from repository import settings as settings_repo
from repository import students as student_repo
from repository.tables import EXAMS_TABLE_ENV, SETTINGS_TABLE_ENV, STUDENTS_TABLE_ENV

NOW = "2026-11-01T12:00:00+00:00"
SENSEI = User(sub="sensei-1", email="sensei@example.com", groups=frozenset({ADMIN_GROUP}))
EVENT_ID = "event-1"
STUDENT_ID = "student-1"
EXAM_PATH = {"id": EVENT_ID, "student_id": STUDENT_ID}

Call = Callable[[], dict[str, Any]]
Filter = Callable[[dict[str, Any]], bool]


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dates, "today", lambda: date(2026, 11, 1))


def _throttle_consistent_reads(
    monkeypatch: pytest.MonkeyPatch, table_env: str, matches: Filter
) -> list[dict[str, Any]]:
    """Throttle the strongly consistent ``GetItem`` calls on the table that ``matches``.

    Returns:
        The parameters of every throttled call.
    """
    table_name = os.environ[table_env]
    original = BaseClient._make_api_call
    throttled: list[dict[str, Any]] = []

    def patched(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if (
            operation_name == "GetItem"
            and api_params.get("TableName") == table_name
            and api_params.get("ConsistentRead") is True
            and matches(api_params)
        ):
            throttled.append(dict(api_params))
            raise ClientError(
                {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
                "GetItem",
            )
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", patched)
    return throttled


def _full_item(api_params: dict[str, Any]) -> bool:
    return "ProjectionExpression" not in api_params


def _projected(api_params: dict[str, Any]) -> bool:
    return "ProjectionExpression" in api_params


def _setup(*, with_exam: bool) -> None:
    """Open event, eligible student, sensei set and, if asked, the attendance confirmed."""
    event_repo.create_event(
        ExamEvent(EVENT_ID, "Exame março/2027", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)
    )
    student_repo.create_student(replace(make_student(), id=STUDENT_ID))
    settings_repo.save_settings(
        AcademySettings(
            academy_name="Associação Tomiyama de Judô",
            sensei_user_id=SENSEI.sub,
            certificate_city="Araraquara",
            updated_at=NOW,
        )
    )
    if with_exam:
        response = _attendance()
        assert response["statusCode"] == 201, response["body"]


def _attendance() -> dict[str, Any]:
    return exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": EVENT_ID}, body={"student_id": STUDENT_ID}), None
    )


def _sheet() -> dict[str, Any]:
    return exam_handlers.get_exam_sheet(api_event(EXAMINER, path=EXAM_PATH), None)


def _decision() -> dict[str, Any]:
    return exam_handlers.decide_exam(
        api_event(SENSEI, path=EXAM_PATH, body={"result": "APPROVED"}), None
    )


def _student_detail() -> dict[str, Any]:
    return student_handlers.get_student(api_event(GUARDIAN, path={"id": STUDENT_ID}), None)


def _student_rename() -> dict[str, Any]:
    student = make_student()
    body = {
        "full_name": "Ana Maria",
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "active": True,
    }
    return student_handlers.update_student(
        api_event(EXAMINER, path={"id": STUDENT_ID}, body=body), None
    )


def _settings() -> dict[str, Any]:
    return settings_handlers.get_settings(api_event(EXAMINER), None)


# case → (attendance confirmed before, table, which consistent reads, route)
CASES: dict[str, tuple[bool, str, Filter, Call]] = {
    "attendance_student": (False, STUDENTS_TABLE_ENV, _full_item, _attendance),
    "attendance_exam": (False, EXAMS_TABLE_ENV, _full_item, _attendance),
    "sheet_exam": (True, EXAMS_TABLE_ENV, _full_item, _sheet),
    "sheet_student": (True, STUDENTS_TABLE_ENV, _full_item, _sheet),
    "decision_settings": (True, SETTINGS_TABLE_ENV, _full_item, _decision),
    "decision_exam": (True, EXAMS_TABLE_ENV, _full_item, _decision),
    "decision_student": (True, STUDENTS_TABLE_ENV, _full_item, _decision),
    "student_detail": (False, STUDENTS_TABLE_ENV, _full_item, _student_detail),
    "student_update_marker": (False, STUDENTS_TABLE_ENV, _projected, _student_rename),
    "settings_get": (False, SETTINGS_TABLE_ENV, _full_item, _settings),
}


@pytest.mark.parametrize("case", sorted(CASES))
def test_throttled_consistent_read_is_503(
    seeded: None, user_pool: str, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    with_exam, table_env, matches, call = CASES[case]
    _setup(with_exam=with_exam)
    throttled = _throttle_consistent_reads(monkeypatch, table_env, matches)

    response = call()

    assert throttled, f"{case}: no strongly consistent GetItem was made ({response['body']})"
    assert response["statusCode"] == 503, response["body"]
    assert MSG_SERVICE_BUSY in response["body"]


def test_throttled_reread_after_refused_student_edit_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The re-read of ``save_student`` after a refused write is strongly consistent too.

    The student is deleted between the handler's reads and the conditional
    write, which then fails; only from that moment on the consistent reads of
    the full item are throttled, so the throttling hits the re-read that picks
    the error, never the handler's first read.
    """
    _setup(with_exam=False)
    original = student_repo.save_student
    throttled: list[list[dict[str, Any]]] = []

    def racing(*args: Any, **kwargs: Any) -> Any:
        student_repo.delete_student(STUDENT_ID)
        throttled.append(_throttle_consistent_reads(monkeypatch, STUDENTS_TABLE_ENV, _full_item))
        return original(*args, **kwargs)

    monkeypatch.setattr(student_repo, "save_student", racing)

    response = _student_rename()
    monkeypatch.undo()

    assert throttled and throttled[0], f"the re-read was not made ({response['body']})"
    assert response["statusCode"] == 503, response["body"]
    assert MSG_SERVICE_BUSY in response["body"]
    assert student_repo.get_student(STUDENT_ID) is None, "the refused edit must not recreate it"
