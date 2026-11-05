"""Acceptance: the full flow of § 9 of the requirements, up to the approval.

Every step goes through the HTTP handlers only, the way the frontend calls the
API (``backend/README.md``), with the users' tokens built from the mocked
Cognito pool (``sub`` and ``cognito:groups``, as the JWT authorizer delivers
them). The initial data (belts and the 692 items of Appendix A) comes from the
deploy's own custom resource (``InitialData``), never from invented items.

Out of scope by the user's decision: the PDF certificate (end of step 7) and
RN011, the last item of the roadmap (card #98).

Clock: the academy, the event and the students are set up on ``SCENARIO_NOW``
(2026-11-01, after Ana's belt date of 2026-03-14 and both birth dates, so
RN014 accepts them); the exam day runs on the event date, 2027-03-13.

Also here, § 8 ("a lista do dia e a navegação entre exames não podem fazer
consultas por aluno em laço"): the DynamoDB calls of the exam-day screen (and
of opening one exam) with 80 students present are the same as with 2. Only
those reads go through the handlers; the 80 students and attendances are set
up through the repository, to keep the test fast.
"""

import base64
import os
import struct
import zlib
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.client import BaseClient
from conftest import (
    EXAMINER,
    SCENARIO_NOW,
    add_user,
    api_event,
    dynamodb_tables_of,
    make_student,
    response_json,
)

from domain import dates
from domain import exams as exam_rules
from domain.belts import Belt, seed_belt_id
from domain.requirements import seed_requirements
from domain.students import Student
from domain.users import ADMIN_GROUP, MASTER_GROUP, User
from handlers import belts as belt_handlers
from handlers import cognito_triggers
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import logos as logo_handlers
from handlers import seed as seed_handlers
from handlers import settings as settings_handlers
from handlers import signatures as signature_handlers
from handlers import students as student_handlers
from handlers import users as user_handlers
from repository import belts as belt_repo
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirements as requirement_repo
from repository import students as student_repo

Handler = Callable[[dict[str, Any], Any], dict[str, Any]]

EVENT_NAME = "Exame março/2027"
EVENT_DATE = "2027-03-13"
# Exam day (UTC; 09:00, 10:00 and 12:00 in Brasília, UTC-3).
ATTENDANCE_AT = "2027-03-13T12:00:00+00:00"
MARKING_AT = "2027-03-13T13:00:00+00:00"
DECISION_AT = "2027-03-13T15:00:00+00:00"

ACADEMY_NAME = "Associação Tomiyama de Judô"
CITY = "Araraquara"

ANA = {
    "full_name": "Ana",
    "birth_date": "2018-05-10",
    "current_belt_since": "2026-03-14",
    "stripes": 0,
}
# 7 full years on the event date (8 only on 2027-06-20); on the Azul for 8 full
# months then (the next belt asks for 6), so the age is the only block.
BRUNO = {
    "full_name": "Bruno",
    "birth_date": "2019-06-20",
    "current_belt_since": "2026-07-01",
    "stripes": 0,
}
MSG_BRUNO_BLOCKED = "Idade mínima para a faixa Azul/Amarela: 8 anos"

# Cinza/Azul sheet (Appendix A § 3): 11 theory and 13 practice items. Wrong
# answers by position inside each kind, in sheet order: 9 of 11 and 10 of 13.
WRONG_THEORY = {2, 7}
WRONG_PRACTICE = {0, 5, 12}
THEORY_PERCENT = 81.8  # 9 / 11 = 81.818...
PRACTICE_PERCENT = 76.9  # 10 / 13 = 76.923...


# --- clock, deploy and users -------------------------------------------------------------


class ScenarioClock:
    """The scenario's "now", followed by ``dates.today`` (Brazil) and ``dates.utc_now_iso``."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, moment: str) -> None:
        self.moment = datetime.fromisoformat(moment)
        monkeypatch.setattr(dates, "today", lambda: self.moment.astimezone(dates.BRAZIL_TZ).date())
        monkeypatch.setattr(
            dates,
            "utc_now_iso",
            lambda: self.moment.astimezone(UTC).isoformat(timespec="seconds"),
        )

    def set(self, moment: str) -> None:
        """Move the clock to ``moment`` (ISO 8601 with offset)."""
        self.moment = datetime.fromisoformat(moment)


def _deploy_initial_data(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run the ``InitialData`` custom resource as the first deploy does (Create)."""
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(
        seed_handlers,
        "_send_response",
        lambda event, context, status, reason: sent.append((status, reason)),
    )
    seed_handlers.handler(
        {
            "RequestType": "Create",
            "ResponseURL": "https://example.invalid/response",
            "StackId": "stack",
            "RequestId": "request",
            "LogicalResourceId": "InitialData",
        },
        SimpleNamespace(get_remaining_time_in_millis=lambda: 900_000),
    )
    assert sent == [("SUCCESS", "OK")]


def _token(pool_id: str, email: str) -> User:
    """The caller as the ID token carries it: ``sub`` and groups read from the pool."""
    client = boto3.client("cognito-idp")
    user = client.admin_get_user(UserPoolId=pool_id, Username=email)
    sub = next(attr["Value"] for attr in user["UserAttributes"] if attr["Name"] == "sub")
    groups = client.admin_list_groups_for_user(UserPoolId=pool_id, Username=email)["Groups"]
    return User(sub=sub, email=email, groups=frozenset(group["GroupName"] for group in groups))


def _guardian_signs_up(pool_id: str, email: str) -> User:
    """The guardian's own sign-up (§ 6.1): confirmation and the post-confirmation trigger."""
    client = boto3.client("cognito-idp")
    client_id = client.create_user_pool_client(UserPoolId=pool_id, ClientName="web")[
        "UserPoolClient"
    ]["ClientId"]
    client.sign_up(
        ClientId=client_id,
        Username=email,
        Password="Senha-de-teste-1!",
        UserAttributes=[{"Name": "email", "Value": email}],
    )
    client.admin_confirm_sign_up(UserPoolId=pool_id, Username=email)
    username = client.admin_get_user(UserPoolId=pool_id, Username=email)["Username"]
    cognito_triggers.post_confirmation(
        {
            "triggerSource": "PostConfirmation_ConfirmSignUp",
            "userPoolId": pool_id,
            "userName": username,
        },
        None,
    )
    return _token(pool_id, email)


# --- HTTP calls ---------------------------------------------------------------------------


def _ok(
    handler: Handler,
    user: User,
    status: int = 200,
    *,
    body: Any = None,
    path: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
) -> Any:
    """Call the route as ``user``, check the status and return the JSON body."""
    response = handler(api_event(user, body=body, path=path, query=query), None)
    assert response["statusCode"] == status, response.get("body")
    return response_json(response) if response.get("body") else None


def _refused(
    handler: Handler,
    user: User,
    status: int,
    message: str,
    *,
    body: Any = None,
    path: dict[str, str] | None = None,
) -> None:
    """Call the route as ``user`` and check it answers ``status`` with only ``message``."""
    response = handler(api_event(user, body=body, path=path), None)
    assert response["statusCode"] == status, response.get("body")
    assert response_json(response) == {"message": message}


def _png() -> bytes:
    """A valid 1x1 PNG (signature, IHDR, IDAT and IEND with their CRCs)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)  # 1x1, 8 bits, RGBA
    pixels = zlib.compress(b"\x00" + bytes((0x1E, 0x63, 0xC6, 0xFF)))
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


def _image_body(data: bytes) -> dict[str, str]:
    return {"content_type": "image/png", "data": base64.b64encode(data).decode("ascii")}


def _counts(summary: dict[str, Any]) -> dict[str, tuple[int, int, int]]:
    """``(total, marked, correct)`` per kind of a ``summary`` (RN007)."""
    return {
        kind: (score["total"], score["marked"], score["correct"]) for kind, score in summary.items()
    }


# --- § 9 -----------------------------------------------------------------------------------


def test_section9_full_flow_until_approval(
    user_pool: str, images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = ScenarioClock(monkeypatch, SCENARIO_NOW)
    _deploy_initial_data(monkeypatch)
    add_user(user_pool, "master@example.com", name="Mestre", groups=(ADMIN_GROUP, MASTER_GROUP))
    add_user(user_pool, "sensei@example.com", name="Tomiyama", groups=(ADMIN_GROUP,))
    add_user(user_pool, "examinadora@example.com", name="Carla", groups=(ADMIN_GROUP,))
    master = _token(user_pool, "master@example.com")
    sensei = _token(user_pool, "sensei@example.com")
    examiner = _token(user_pool, "examinadora@example.com")

    belts = {belt["name"]: belt for belt in _ok(belt_handlers.list_belts, examiner)}
    cinza, cinza_azul = belts["Cinza"]["id"], belts["Cinza/Azul"]["id"]
    azul, azul_amarela = belts["Azul"]["id"], belts["Azul/Amarela"]["id"]

    # --- Step 1: the master chooses the sensei; an examiner sets up the academy; the
    # sensei registers a complete certificate signature.
    examiners = _ok(user_handlers.list_examiners, master)
    sensei_id = next(item["id"] for item in examiners if item["name"] == "Tomiyama")
    assert sensei_id == sensei.sub
    # The form sends every field and the name is required, so the master fills it too.
    chosen = _ok(
        settings_handlers.update_settings,
        master,
        body={"academy_name": ACADEMY_NAME, "sensei_user_id": sensei_id, "certificate_city": None},
    )
    assert chosen["sensei"] == {
        "id": sensei.sub,
        "email": "sensei@example.com",
        "name": "Tomiyama",
        "active": True,
    }

    form = _ok(settings_handlers.get_settings, examiner)
    _ok(
        settings_handlers.update_settings,
        examiner,
        body={
            "academy_name": form["academy_name"],
            "sensei_user_id": form["sensei_user_id"],
            "certificate_city": CITY,
        },
    )
    png = _png()
    for slot in ("primary", "secondary"):
        sent = _ok(logo_handlers.put_logo, examiner, body=_image_body(png), path={"slot": slot})
        assert (sent["content_type"], sent["size"], sent["updated_by"]) == (
            "image/png",
            len(png),
            examiner.sub,
        )
        shown = _ok(logo_handlers.get_logo, examiner, path={"slot": slot})
        assert shown["url"].startswith("https://")
    settings = _ok(settings_handlers.get_settings, examiner)
    assert (settings["academy_name"], settings["certificate_city"]) == (ACADEMY_NAME, CITY)
    assert settings["sensei"]["id"] == sensei.sub
    assert settings["sensei"]["active"] is True

    signature = _ok(
        signature_handlers.create_signature,
        sensei,
        201,
        body={"name": "Tomiyama", "graduation": "Sensei, 6º Dan"},
    )
    assert signature["complete"] is False  # the image comes next
    _ok(
        signature_handlers.put_signature_image,
        sensei,
        body=_image_body(png),
        path={"id": signature["id"]},
    )
    signatures = _ok(signature_handlers.list_signatures, master)
    assert signatures["has_complete"] is True
    [listed_signature] = signatures["signatures"]
    assert (listed_signature["name"], listed_signature["graduation"]) == (
        "Tomiyama",
        "Sensei, 6º Dan",
    )
    assert (listed_signature["position"], listed_signature["complete"]) == (1, True)

    # --- Step 2: an examiner creates the event.
    exam_event = _ok(
        event_handlers.create_event,
        examiner,
        201,
        body={"name": EVENT_NAME, "exam_date": EVENT_DATE},
    )
    assert (exam_event["name"], exam_event["exam_date"], exam_event["status"]) == (
        EVENT_NAME,
        EVENT_DATE,
        "OPEN",
    )
    event_path = {"id": exam_event["id"]}

    # --- Step 3: a guardian signs up and registers Ana and Bruno.
    guardian = _guardian_signs_up(user_pool, "familia@example.com")
    assert guardian.groups == frozenset({"responsavel"})
    assert not guardian.is_examiner
    belt_options = {belt["name"]: belt["id"] for belt in _ok(belt_handlers.list_belts, guardian)}
    ana = _ok(
        student_handlers.create_student,
        guardian,
        201,
        body={**ANA, "current_belt_id": belt_options["Cinza"]},
    )
    bruno = _ok(
        student_handlers.create_student,
        guardian,
        201,
        body={**BRUNO, "current_belt_id": belt_options["Azul"]},
    )
    assert (ana["owner_id"], bruno["owner_id"]) == (guardian.sub, guardian.sub)
    own = _ok(student_handlers.list_students, guardian)
    assert [student["full_name"] for student in own] == ["Ana", "Bruno"]

    # --- Step 4: the exam day (§ 6.3), on the event date. The screen picks the most
    # recent open event and lists the active students with the eligibility on its date.
    clock.set(ATTENDANCE_AT)
    listed_events = _ok(event_handlers.list_events, examiner)
    open_events = [item for item in listed_events if item["status"] == "OPEN"]
    assert open_events[0]["id"] == exam_event["id"]
    roster = _ok(
        student_handlers.list_students,
        examiner,
        query={"active": "true", "reference_date": exam_event["exam_date"]},
    )
    assert [student["full_name"] for student in roster] == ["Ana", "Bruno"]
    ana_row, bruno_row = roster
    assert (ana_row["current_belt_name"], ana_row["age"]) == ("Cinza", 8)
    assert ana_row["eligibility"] == {
        "eligible": True,
        "kind": "BELT",
        "target_belt_id": cinza_azul,
        "target_belt_name": "Cinza/Azul",
        "reasons": [],
    }
    assert (bruno_row["current_belt_name"], bruno_row["age"]) == ("Azul", 7)
    assert bruno_row["eligibility"] == {
        "eligible": False,
        "kind": "BELT",
        "target_belt_id": azul_amarela,
        "target_belt_name": "Azul/Amarela",
        "reasons": [MSG_BRUNO_BLOCKED],
    }
    assert _ok(exam_handlers.list_event_exams, examiner, path=event_path) == []
    # Bruno has no button; the API refuses his attendance with the same reason.
    _refused(
        exam_handlers.confirm_attendance,
        examiner,
        400,
        MSG_BRUNO_BLOCKED,
        body={"student_id": bruno["id"]},
        path=event_path,
    )
    assert _ok(exam_handlers.list_event_exams, examiner, path=event_path) == []

    # --- Step 5: attendance of Ana and the 24 items of the Cinza/Azul sheet.
    exam = _ok(
        exam_handlers.confirm_attendance,
        examiner,
        201,
        body={"student_id": ana["id"]},
        path=event_path,
    )
    assert {key: exam[key] for key in ("event_id", "student_id", "student_name")} == {
        "event_id": exam_event["id"],
        "student_id": ana["id"],
        "student_name": "Ana",
    }
    assert (exam["target_belt_id"], exam["kind"], exam["status"]) == (
        cinza_azul,
        "BELT",
        "IN_PROGRESS",
    )
    assert (exam["created_by"], exam["created_at"]) == (examiner.sub, ATTENDANCE_AT)
    assert (exam["source_belt_id"], exam["source_belt_since"], exam["source_stripes"]) == (
        cinza,
        ANA["current_belt_since"],
        0,
    )
    assert _ok(exam_handlers.list_event_exams, examiner, path=event_path) == [exam]

    exam_path = {**event_path, "student_id": ana["id"]}
    sheet = _ok(exam_handlers.get_exam_sheet, examiner, path=exam_path)
    assert sheet["target_belt"]["name"] == "Cinza/Azul"
    items = sheet["items"]
    appendix_a = sorted(
        (item for item in seed_requirements() if item.belt_id == cinza_azul),
        key=lambda item: item.sort_order,
    )
    assert [{k: v for k, v in item.items() if k != "answer"} for item in items] == [
        item.to_dict() for item in appendix_a
    ]
    assert Counter(item["kind"] for item in items) == {"THEORY": 11, "PRACTICE": 13}
    assert all(item["answer"] is None for item in items)
    assert _counts(sheet["summary"]) == {"THEORY": (11, 0, 0), "PRACTICE": (13, 0, 0)}

    clock.set(MARKING_AT)
    position = {"THEORY": 0, "PRACTICE": 0}
    wrong = {"THEORY": WRONG_THEORY, "PRACTICE": WRONG_PRACTICE}
    expected = {"THEORY": [11, 0, 0], "PRACTICE": [13, 0, 0]}
    for item in items:
        kind = item["kind"]
        correct = position[kind] not in wrong[kind]
        position[kind] += 1
        marked = _ok(
            exam_handlers.mark_answer,
            examiner,
            body={"correct": correct},
            path={**exam_path, "requirement_id": item["id"]},
        )
        assert marked["answer"] == {
            "requirement_id": item["id"],
            "correct": correct,
            "marked_by": examiner.sub,
            "marked_at": MARKING_AT,
        }
        expected[kind][1] += 1
        expected[kind][2] += correct
        # "marcados X de N", item by item.
        assert _counts(marked["summary"]) == {key: tuple(value) for key, value in expected.items()}

    # --- Step 6: the summary shows both percentages; only the sensei decides.
    sheet = _ok(exam_handlers.get_exam_sheet, sensei, path=exam_path)
    assert sheet["summary"] == {
        "THEORY": {
            "kind": "THEORY",
            "total": 11,
            "marked": 11,
            "correct": 9,
            "percent": THEORY_PERCENT,
        },
        "PRACTICE": {
            "kind": "PRACTICE",
            "total": 13,
            "marked": 13,
            "correct": 10,
            "percent": PRACTICE_PERCENT,
        },
    }
    assert all(item["answer"]["marked_by"] == examiner.sub for item in sheet["items"])

    clock.set(DECISION_AT)
    for not_sensei in (examiner, master):
        _refused(
            exam_handlers.decide_exam,
            not_sensei,
            403,
            "Somente o sensei pode decidir o exame",
            body={"result": "APPROVED"},
            path=exam_path,
        )
    assert _ok(exam_handlers.get_exam_sheet, examiner, path=exam_path)["exam"]["status"] == (
        "IN_PROGRESS"
    )
    decided = _ok(exam_handlers.decide_exam, sensei, body={"result": "APPROVED"}, path=exam_path)

    # --- Step 7: Ana is Cinza/Azul since the event date, with 0 stripes; the exam keeps
    # who decided and when, and nothing changes after the decision.
    assert (decided["exam"]["status"], decided["exam"]["student_name"]) == ("APPROVED", "Ana")
    assert (decided["exam"]["decided_by_id"], decided["exam"]["decided_at"]) == (
        sensei.sub,
        DECISION_AT,
    )
    assert (
        decided["student"]["current_belt_id"],
        decided["student"]["current_belt_since"],
        decided["student"]["stripes"],
    ) == (cinza_azul, EVENT_DATE, 0)
    for viewer in (guardian, examiner):
        student = _ok(student_handlers.get_student, viewer, path={"id": ana["id"]})
        assert (
            student["current_belt_name"],
            student["current_belt_since"],
            student["stripes"],
        ) == ("Cinza/Azul", EVENT_DATE, 0)
    bruno_now = _ok(student_handlers.get_student, guardian, path={"id": bruno["id"]})
    assert (bruno_now["current_belt_id"], bruno_now["stripes"]) == (azul, 0)

    sheet = _ok(exam_handlers.get_exam_sheet, examiner, path=exam_path)
    assert (
        sheet["exam"]["status"],
        sheet["exam"]["decided_by_id"],
        sheet["exam"]["decided_at"],
    ) == ("APPROVED", sensei.sub, DECISION_AT)
    first_item = {**exam_path, "requirement_id": items[0]["id"]}
    _refused(
        exam_handlers.mark_answer,
        examiner,
        409,
        "Exame já decidido",
        body={"correct": True},
        path=first_item,
    )
    _refused(exam_handlers.unmark_answer, examiner, 409, "Exame já decidido", path=first_item)
    _refused(
        exam_handlers.decide_exam,
        sensei,
        409,
        "Exame já decidido",
        body={"result": "FAILED"},
        path=exam_path,
    )
    after = _ok(exam_handlers.get_exam_sheet, examiner, path=exam_path)
    assert after["summary"] == sheet["summary"]
    assert after["exam"]["status"] == "APPROVED"

    history = _ok(student_handlers.list_student_exams, examiner, path={"id": ana["id"]})
    assert history == [
        {
            "event_id": exam_event["id"],
            "event_name": EVENT_NAME,
            "exam_date": EVENT_DATE,
            "target_belt_id": cinza_azul,
            "target_belt_name": "Cinza/Azul",
            "kind": "BELT",
            "status": "APPROVED",
            "decided_by_id": sensei.sub,
            "decided_at": DECISION_AT,
            "notes": None,
            "created_at": ATTENDANCE_AT,
            "source": {
                "belt_id": cinza,
                "belt_name": "Cinza",
                "belt_since": ANA["current_belt_since"],
                "stripes": 0,
            },
        }
    ]
    assert _ok(student_handlers.list_student_exams, examiner, path={"id": bruno["id"]}) == []


# --- § 8: the exam-day list without per-student reads --------------------------------------


def _record_dynamodb_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Record ``(operation, tables)`` of every DynamoDB call, in order."""
    calls: list[tuple[str, str]] = []
    original = BaseClient._make_api_call

    def recording(self: BaseClient, operation_name: str, api_params: dict[str, Any]) -> Any:
        if self.meta.service_model.service_name == "dynamodb":
            calls.append((operation_name, ",".join(sorted(dynamodb_tables_of(api_params)))))
        return original(self, operation_name, api_params)

    monkeypatch.setattr(BaseClient, "_make_api_call", recording)
    return calls


def _students_present(event_id: str, first: int, last: int) -> list[str]:
    """Students ``first..last``, eligible like Ana, with the attendance confirmed.

    Set up through the repository and the attendance rule (``POST /students`` and
    ``POST /events/{id}/exams`` already run in § 9): only the reads of the exam-day
    screen are measured, and 80 attendances through the handlers take ~25 s in moto.
    """
    exam_event = event_repo.get_event(event_id)
    assert exam_event is not None
    belts = belt_repo.list_belts()
    ids = []
    for number in range(first, last + 1):
        student = Student(
            **{
                **vars(make_student()),
                "id": f"student-{number:02d}",
                "full_name": f"Aluno {number:02d}",
            }
        )
        student_repo.create_student(student)
        exam = exam_rules.confirm_attendance(
            exam_event, student, belts, confirmed_by=EXAMINER.sub, now_iso=SCENARIO_NOW
        )
        exam_repo.create_exam(exam, student)
        ids.append(student.id)
    return ids


def _exam_day_reads(
    calls: list[tuple[str, str]], event_path: dict[str, str], student_id: str, size: int
) -> Counter[tuple[str, str]]:
    """The DynamoDB calls of the exam-day screen and of opening one exam (§ 6.3, § 6.4)."""
    calls.clear()
    _ok(event_handlers.list_events, EXAMINER)
    roster = _ok(
        student_handlers.list_students,
        EXAMINER,
        query={"active": "true", "reference_date": EVENT_DATE},
    )
    present = _ok(exam_handlers.list_event_exams, EXAMINER, path=event_path)
    sheet = _ok(
        exam_handlers.get_exam_sheet, EXAMINER, path={**event_path, "student_id": student_id}
    )
    assert (len(roster), len(present), len(sheet["items"])) == (size, size, 24)
    assert all(student["eligibility"]["eligible"] for student in roster)
    assert all(exam["student_name"] for exam in present)
    return Counter(calls)


def test_section8_exam_day_list_does_not_read_per_student(
    seeded: list[Belt], monkeypatch: pytest.MonkeyPatch
) -> None:
    ScenarioClock(monkeypatch, SCENARIO_NOW)
    # The Cinza/Azul sheet of Appendix A, for opening an exam (the full load takes ~7 s).
    requirement_repo.seed_requirements(
        item for item in seed_requirements() if item.belt_id == seed_belt_id("Cinza/Azul")
    )
    exam_event = _ok(
        event_handlers.create_event,
        EXAMINER,
        201,
        body={"name": EVENT_NAME, "exam_date": EVENT_DATE},
    )
    event_path = {"id": exam_event["id"]}
    calls = _record_dynamodb_calls(monkeypatch)

    first = _students_present(exam_event["id"], 1, 2)
    with_two = _exam_day_reads(calls, event_path, first[0], 2)
    _students_present(exam_event["id"], 3, 80)
    with_eighty = _exam_day_reads(calls, event_path, first[0], 80)

    assert with_eighty == with_two
    # The only read by key of a student is the one of the exam opened (its sheet).
    assert with_two[("GetItem", os.environ["STUDENTS_TABLE"])] == 1
