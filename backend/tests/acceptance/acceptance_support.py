"""Shared helpers of the acceptance tests (``tests/acceptance/``).

Every step of an acceptance test goes through the HTTP handlers, the way the
frontend calls the API (``backend/README.md``): the users' tokens are built from
the mocked Cognito pool (``sub`` and ``cognito:groups``, as the JWT authorizer
delivers them) and the initial data comes from the deploy's own custom resource
(``InitialData``): the belts of § 4 and the items of Appendix A, never invented
ones.

The messages below are copied by hand from
``requirements/requisitos-exame-graduacao.md`` (§ 2 and § 5), not imported from
``domain/``: the tests check what the requirement says.

This is a plain module, not a ``conftest.py``: the folder has no
``__init__.py``, and a second ``conftest`` would shadow ``tests/conftest.py``
for ``from conftest import ...``.
"""

import base64
import struct
import zlib
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from conftest import SCENARIO_NOW, add_user, api_event, response_json

from domain import dates
from domain.requirements import seed_requirements
from domain.users import ADMIN_GROUP, MASTER_GROUP, User
from handlers import belts as belt_handlers
from handlers import cognito_triggers
from handlers import events as event_handlers
from handlers import exams as exam_handlers
from handlers import seed as seed_handlers
from handlers import settings as settings_handlers
from handlers import students as student_handlers

Handler = Callable[[dict[str, Any], Any], dict[str, Any]]

# The belts in graduation order (§ 4).
BELT_SEQUENCE = (
    "Branca",
    "Branca/Cinza",
    "Cinza",
    "Cinza/Azul",
    "Azul",
    "Azul/Amarela",
    "Amarela",
    "Amarela/Laranja",
    "Laranja",
    "Verde",
    "Roxa",
    "Marrom",
)

# The default exam: the event of § 9, with the exam day on its date (09:00 in
# Brasília) and the sensei deciding two days later.
EVENT_NAME = "Exame março/2027"
EVENT_DATE = "2027-03-13"
EXAM_DAY_AT = "2027-03-13T12:00:00+00:00"
DECISION_AT = "2027-03-15T13:00:00+00:00"

# A student no eligibility rule blocks on any belt: 27 years old on the event
# date (minimum ages go up to 14, and the waiting period is waived from 16).
ADULT_BIRTH = "2000-01-01"
ADULT_SINCE = "2026-03-14"

# § 2 and the HTTP layer.
MSG_LOGIN = "Faça login para continuar"
MSG_EXAMINERS_ONLY = "Esta área é dos examinadores"
# § 5, by rule.
MSG_BLACK_BELT = "Faixa preta é exame da federação"  # RN003
MSG_ALREADY_CONFIRMED = "Presença já confirmada neste evento"  # RN005
MSG_IN_PROGRESS_ELSEWHERE = "O aluno já tem um exame em andamento em outro evento."  # RN005
MSG_GRADUATION_IN_PROGRESS = (  # RN005
    "Não é possível alterar a graduação com exame em andamento. Decida o exame primeiro."
)
MSG_ITEM_NOT_IN_BELT = "Item não pertence à faixa do exame"  # RN006
MSG_ONLY_SENSEI = "Somente o sensei pode decidir o exame"  # RN008
MSG_NO_SENSEI = "Defina o sensei nas configurações da academia"  # RN008
MSG_ONLY_MASTER_CHOOSES_SENSEI = "Somente o administrador master escolhe o sensei"  # RN008
MSG_EXAM_DECIDED = "Exame já decidido"  # RN010
MSG_INVALID_IMAGE = "Envie PNG ou JPEG de até 2 MB"  # RN012
MSG_GRADUATION_LOCKED = "Somente examinadores alteram a graduação após o primeiro exame"  # RN013
MSG_INVALID_DATES = "Datas inválidas: verifique nascimento e data da faixa atual"  # RN014
MSG_EVENT_HAS_EXAMS = "Evento possui exames registrados"  # RN016
MSG_STUDENT_HAS_EXAMS = "Aluno possui exames registrados"  # RN018
# Not worded by the requirement (it only says the action is blocked); these are
# the messages of ``backend/README.md``.
MSG_EVENT_CLOSED = "Evento encerrado"  # RN016
MSG_STUDENT_INACTIVE = "Aluno inativo não pode fazer exame"  # RN005
MSG_STUDENT_NOT_FOUND = "Aluno não encontrado"  # RN013
MSG_EVENT_NOT_FOUND = "Evento não encontrado"  # RN016
MSG_LOGO_NOT_FOUND = "Logo não encontrado"  # RN012
MSG_ONLY_MASTER_OR_SENSEI = "Somente o master e o sensei gerem as assinaturas"  # RN012
MSG_BELT_NAME_TAKEN = "Já existe uma faixa com este nome"  # RN015
MSG_BELT_ORDER_TAKEN = "Já existe uma faixa com esta ordem"  # RN015
MSG_MASTER_ONLY_BELT_FIELDS = (  # RN015, decision of 2026-11-12 (#142)
    "Somente o administrador master altera nome, kyū, ordem, nível e cores da faixa"
)
MSG_REQUIREMENT_BELT_NOT_FOUND = "Faixa: faixa não encontrada"  # RN017
MSG_REQUIREMENT_NOT_FOUND = "Requisito não encontrado"  # RN017


def msg_minimum_age(belt_name: str, years: int) -> str:
    """RN001: the blocking message of the minimum age."""
    return f"Idade mínima para a faixa {belt_name}: {years} anos"


def msg_waiting_period(months: int, missing: int) -> str:
    """RN002: the blocking message of the waiting period."""
    return f"Carência mínima de {months} meses na faixa atual (faltam {missing})"


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


def deploy_initial_data(
    monkeypatch: pytest.MonkeyPatch, sheets: Iterable[str] | None = None
) -> None:
    """Run the ``InitialData`` custom resource as the first deploy does (Create).

    Args:
        monkeypatch: The test's ``monkeypatch``.
        sheets: Names of the belts whose Appendix A sheet is loaded; None for
            the whole appendix (692 items, ~7 s in moto). The belts of § 4 are
            always all loaded. The items are the real ones either way: a test
            that only opens the Cinza/Azul sheet does not pay for the other ten.
    """
    if sheets is not None:
        wanted = set(sheets)
        unknown = wanted - set(BELT_SEQUENCE)
        assert not unknown, f"faixas fora do § 4: {sorted(unknown)}"
        assert [belt.name for belt in seed_handlers.SEED_BELTS] == list(BELT_SEQUENCE)
        belt_ids = {belt.id for belt in seed_handlers.SEED_BELTS if belt.name in wanted}
        items = tuple(item for item in seed_requirements() if item.belt_id in belt_ids)
        monkeypatch.setattr(seed_handlers, "seed_requirements", lambda: items)
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


def token(pool_id: str, email: str) -> User:
    """The caller as the ID token carries it: ``sub`` and groups read from the pool."""
    client = boto3.client("cognito-idp")
    user = client.admin_get_user(UserPoolId=pool_id, Username=email)
    sub = next(attr["Value"] for attr in user["UserAttributes"] if attr["Name"] == "sub")
    groups = client.admin_list_groups_for_user(UserPoolId=pool_id, Username=email)["Groups"]
    return User(sub=sub, email=email, groups=frozenset(group["GroupName"] for group in groups))


def guardian_signs_up(pool_id: str, email: str) -> User:
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
    return token(pool_id, email)


# --- HTTP calls ---------------------------------------------------------------------------


def ok(
    handler: Handler,
    user: User | None,
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


def refused(
    handler: Handler,
    user: User | None,
    status: int,
    message: str,
    *,
    body: Any = None,
    path: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
) -> None:
    """Call the route as ``user`` and check it answers ``status`` with only ``message``."""
    response = handler(api_event(user, body=body, path=path, query=query), None)
    assert response["statusCode"] == status, response.get("body")
    assert response_json(response) == {"message": message}


def png() -> bytes:
    """A valid 1x1 PNG (signature, IHDR, IDAT and IEND with their CRCs)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)  # 1x1, 8 bits, RGBA
    pixels = zlib.compress(b"\x00" + bytes((0x1E, 0x63, 0xC6, 0xFF)))
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


def image_body(data: bytes, content_type: str = "image/png") -> dict[str, str]:
    """The body of an image upload: the declared type and the file in base64."""
    return {"content_type": content_type, "data": base64.b64encode(data).decode("ascii")}


# --- the academy of a test ----------------------------------------------------------------

GRADUATION_FIELDS = ("current_belt_id", "current_belt_since", "stripes")
_FORM_FIELDS = (
    "full_name",
    "birth_date",
    "current_belt_id",
    "current_belt_since",
    "stripes",
    "federation_id",
    "active",
)


def student_form(student: dict[str, Any], **changes: Any) -> dict[str, Any]:
    """The body of ``PUT /students/{id}``: the form resends every field (RN013)."""
    return {**{field: student[field] for field in _FORM_FIELDS}, **changes}


def settings_body(sensei: User | None) -> dict[str, Any]:
    """The body of ``PUT /settings``: the form sends every field (§ 3.7)."""
    return {
        "academy_name": "Associação Tomiyama de Judô",
        "sensei_user_id": sensei.sub if sensei else None,
        "certificate_city": "Araraquara",
    }


def graduation(student: dict[str, Any]) -> tuple[Any, ...]:
    """``(current_belt_id, current_belt_since, stripes)`` of a student view."""
    return tuple(student[field] for field in GRADUATION_FIELDS)


def exam_path(exam_event: dict[str, Any], student: dict[str, Any]) -> dict[str, str]:
    """Path parameters of ``/events/{id}/exams/{student_id}``."""
    return {"id": exam_event["id"], "student_id": student["id"]}


@dataclass
class Academy:
    """A deployed academy: the clock, its examiners and shortcuts to the routes.

    Attributes:
        clock: The scenario's clock, at ``SCENARIO_NOW`` (2026-11-01) at first.
        pool_id: The mocked Cognito pool.
        master: The first examiner (groups ``admin`` and ``master``).
        sensei: The examiner the master chose as sensei, if asked to.
        examiner: Another examiner, neither master nor sensei.
        belts: The belts of ``GET /belts`` by name.
    """

    clock: ScenarioClock
    pool_id: str
    master: User
    sensei: User
    examiner: User
    belts: dict[str, dict[str, Any]]

    def belt_id(self, name: str) -> str:
        """The id of the belt called ``name``."""
        return self.belts[name]["id"]

    def guardian(self, email: str = "familia@example.com") -> User:
        """A guardian who signs up on the site."""
        return guardian_signs_up(self.pool_id, email)

    def add_examiner(self, email: str, name: str) -> User:
        """One more examiner (group ``admin``)."""
        add_user(self.pool_id, email, name=name, groups=(ADMIN_GROUP,))
        return token(self.pool_id, email)

    def choose_sensei(self, sensei: User | None, *, by: User | None = None) -> dict[str, Any]:
        """``PUT /settings`` by the master (or ``by``) with ``sensei`` (None removes)."""
        return ok(settings_handlers.update_settings, by or self.master, body=settings_body(sensei))

    def choose_sensei_refused(self, sensei: User | None, *, by: User) -> None:
        """``PUT /settings`` by ``by`` with another sensei: only the master chooses (RN008)."""
        refused(
            settings_handlers.update_settings,
            by,
            403,
            MSG_ONLY_MASTER_CHOOSES_SENSEI,
            body=settings_body(sensei),
        )

    def eligibility(self, belt_name: str, kind: str, *reasons: str) -> dict[str, Any]:
        """The ``eligibility`` of a student view: next exam and blocking reasons (§ 5)."""
        return {
            "eligible": not reasons,
            "kind": kind,
            "target_belt_id": self.belt_id(belt_name),
            "target_belt_name": belt_name,
            "reasons": list(reasons),
        }

    def register(
        self,
        owner: User,
        name: str,
        belt_name: str,
        *,
        birth: str = ADULT_BIRTH,
        since: str = ADULT_SINCE,
        stripes: int = 0,
        active: bool = True,
    ) -> dict[str, Any]:
        """``POST /students`` as ``owner``; by default an adult no rule blocks."""
        return ok(
            student_handlers.create_student,
            owner,
            201,
            body={
                "full_name": name,
                "birth_date": birth,
                "current_belt_id": self.belt_id(belt_name),
                "current_belt_since": since,
                "stripes": stripes,
                "active": active,
            },
        )

    def student(self, student: dict[str, Any]) -> dict[str, Any]:
        """``GET /students/{id}`` as an examiner."""
        return ok(student_handlers.get_student, self.examiner, path={"id": student["id"]})

    def update_student(self, by: User, student: dict[str, Any], **changes: Any) -> dict[str, Any]:
        """``PUT /students/{id}`` as ``by``: the form of ``student`` with ``changes`` (200)."""
        return ok(
            student_handlers.update_student,
            by,
            body=student_form(student, **changes),
            path={"id": student["id"]},
        )

    def update_student_refused(
        self, by: User, student: dict[str, Any], status: int, message: str, **changes: Any
    ) -> None:
        """``PUT /students/{id}`` as ``by``: refused with ``message``."""
        refused(
            student_handlers.update_student,
            by,
            status,
            message,
            body=student_form(student, **changes),
            path={"id": student["id"]},
        )

    def history(self, student: dict[str, Any]) -> list[dict[str, Any]]:
        """``GET /students/{id}/exams`` as an examiner."""
        return ok(student_handlers.list_student_exams, self.examiner, path={"id": student["id"]})

    def roster(self, exam_date: str | None = None) -> dict[str, dict[str, Any]]:
        """The exam-day list (§ 6.3) by student name: active students only.

        The eligibility is computed on ``exam_date``; without it, on today.
        """
        query = {"active": "true"}
        if exam_date is not None:
            query["reference_date"] = exam_date
        rows = ok(student_handlers.list_students, self.examiner, query=query)
        return {row["full_name"]: row for row in rows}

    def event(self, exam_date: str = EVENT_DATE, name: str = EVENT_NAME) -> dict[str, Any]:
        """``POST /events`` as an examiner: an open event."""
        return ok(
            event_handlers.create_event,
            self.examiner,
            201,
            body={"name": name, "exam_date": exam_date},
        )

    def set_event_status(self, exam_event: dict[str, Any], status: str) -> dict[str, Any]:
        """``PUT /events/{id}`` as an examiner, resending the name and the date."""
        return ok(
            event_handlers.update_event,
            self.examiner,
            body={
                "name": exam_event["name"],
                "exam_date": exam_event["exam_date"],
                "status": status,
            },
            path={"id": exam_event["id"]},
        )

    def attend(self, exam_event: dict[str, Any], student: dict[str, Any]) -> dict[str, Any]:
        """``POST /events/{id}/exams`` as an examiner: the attendance is confirmed (201)."""
        return ok(
            exam_handlers.confirm_attendance,
            self.examiner,
            201,
            body={"student_id": student["id"]},
            path={"id": exam_event["id"]},
        )

    def attendance_refused(
        self, exam_event: dict[str, Any], student: dict[str, Any], status: int, message: str
    ) -> None:
        """``POST /events/{id}/exams`` as an examiner: refused with ``message``."""
        refused(
            exam_handlers.confirm_attendance,
            self.examiner,
            status,
            message,
            body={"student_id": student["id"]},
            path={"id": exam_event["id"]},
        )

    def event_exams(self, exam_event: dict[str, Any]) -> list[dict[str, Any]]:
        """``GET /events/{id}/exams`` as an examiner."""
        return ok(exam_handlers.list_event_exams, self.examiner, path={"id": exam_event["id"]})

    def sheet(self, exam_event: dict[str, Any], student: dict[str, Any]) -> dict[str, Any]:
        """``GET /events/{id}/exams/{student_id}`` as an examiner."""
        return ok(exam_handlers.get_exam_sheet, self.examiner, path=exam_path(exam_event, student))

    def mark(
        self,
        exam_event: dict[str, Any],
        student: dict[str, Any],
        item: dict[str, Any],
        correct: bool,
        *,
        by: User | None = None,
    ) -> dict[str, Any]:
        """``PUT .../answers/{requirement_id}`` as an examiner (or ``by``)."""
        return ok(
            exam_handlers.mark_answer,
            by or self.examiner,
            body={"correct": correct},
            path={**exam_path(exam_event, student), "requirement_id": item["id"]},
        )

    def mark_refused(
        self,
        exam_event: dict[str, Any],
        student: dict[str, Any],
        item: dict[str, Any],
        status: int,
        message: str,
        *,
        by: User | None = None,
        anonymous: bool = False,
    ) -> None:
        """``PUT .../answers/{requirement_id}``: refused with ``message``."""
        refused(
            exam_handlers.mark_answer,
            None if anonymous else by or self.examiner,
            status,
            message,
            body={"correct": True},
            path={**exam_path(exam_event, student), "requirement_id": item["id"]},
        )

    def decide_refused(
        self,
        exam_event: dict[str, Any],
        student: dict[str, Any],
        status: int,
        message: str,
        *,
        by: User | None,
        result: str = "APPROVED",
    ) -> None:
        """``POST .../decision`` as ``by`` (None: no login): refused with ``message``."""
        refused(
            exam_handlers.decide_exam,
            by,
            status,
            message,
            body={"result": result},
            path=exam_path(exam_event, student),
        )

    def decide(
        self,
        exam_event: dict[str, Any],
        student: dict[str, Any],
        result: str,
        *,
        by: User | None = None,
    ) -> dict[str, Any]:
        """``POST .../decision`` as the sensei (or ``by``)."""
        return ok(
            exam_handlers.decide_exam,
            by or self.sensei,
            body={"result": result},
            path=exam_path(exam_event, student),
        )


def open_academy(
    pool_id: str,
    monkeypatch: pytest.MonkeyPatch,
    *,
    sheets: Iterable[str] | None = (),
    with_sensei: bool = True,
) -> Academy:
    """Deploy the initial data and create the master, the sensei and one more examiner.

    Args:
        pool_id: The mocked Cognito pool (fixture ``user_pool``).
        monkeypatch: The test's ``monkeypatch``.
        sheets: Appendix A sheets to load (see ``deploy_initial_data``); none by default.
        with_sensei: Whether the master chooses the sensei in the settings.
    """
    clock = ScenarioClock(monkeypatch, SCENARIO_NOW)
    deploy_initial_data(monkeypatch, sheets)
    add_user(pool_id, "master@example.com", name="Mestre", groups=(ADMIN_GROUP, MASTER_GROUP))
    add_user(pool_id, "sensei@example.com", name="Tomiyama", groups=(ADMIN_GROUP,))
    add_user(pool_id, "examinadora@example.com", name="Carla", groups=(ADMIN_GROUP,))
    examiner = token(pool_id, "examinadora@example.com")
    belts = {belt["name"]: belt for belt in ok(belt_handlers.list_belts, examiner)}
    academy = Academy(
        clock=clock,
        pool_id=pool_id,
        master=token(pool_id, "master@example.com"),
        sensei=token(pool_id, "sensei@example.com"),
        examiner=examiner,
        belts=belts,
    )
    if with_sensei:
        academy.choose_sensei(academy.sensei)
    return academy
