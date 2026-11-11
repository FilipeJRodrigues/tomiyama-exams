"""Acceptance, rule by rule: registrations and settings (RN012–RN018 of § 5).

Every step goes through the HTTP handlers (see ``acceptance_support``). Each
test sets up its own academy, on a fixed clock (``SCENARIO_NOW``, 2026-11-01).

Where the requirement only says an action is refused, without wording the
message (the validations of RN015 and RN017, for instance), the message checked
is the one of ``backend/README.md`` and of the API.
"""

from typing import Any

import pytest
from acceptance_support import (
    DECISION_AT,
    EVENT_DATE,
    EVENT_NAME,
    EXAM_DAY_AT,
    MSG_BELT_NAME_TAKEN,
    MSG_BELT_ORDER_TAKEN,
    MSG_EVENT_CLOSED,
    MSG_EVENT_HAS_EXAMS,
    MSG_EVENT_NOT_FOUND,
    MSG_EXAMINERS_ONLY,
    MSG_GRADUATION_LOCKED,
    MSG_INVALID_DATES,
    MSG_INVALID_IMAGE,
    MSG_LOGIN,
    MSG_LOGO_NOT_FOUND,
    MSG_ONLY_MASTER_OR_SENSEI,
    MSG_REQUIREMENT_BELT_NOT_FOUND,
    MSG_REQUIREMENT_NOT_FOUND,
    MSG_STUDENT_HAS_EXAMS,
    MSG_STUDENT_NOT_FOUND,
    Academy,
    graduation,
    image_body,
    msg_minimum_age,
    ok,
    open_academy,
    png,
    refused,
    student_form,
)
from conftest import api_event, response_json

from domain.users import User
from handlers import belts as belt_handlers
from handlers import events as event_handlers
from handlers import logos as logo_handlers
from handlers import requirements as requirement_handlers
from handlers import settings as settings_handlers
from handlers import signatures as signature_handlers
from handlers import students as student_handlers

TWO_MB = 2 * 1024 * 1024
# The start of a JPEG file (SOI and the JFIF header) and its end (EOI).
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
GIF = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;"
PDF = b"%PDF-1.4\n%%EOF\n"


def _padded_png(size: int) -> bytes:
    """A file of ``size`` bytes that starts as a PNG."""
    data = png()
    return data + bytes(size - len(data))


# Uploads RN012 refuses, by case: (declared type, bytes).
_INVALID_IMAGES: dict[str, tuple[str, bytes]] = {
    "gif": ("image/gif", GIF),
    "pdf": ("application/pdf", PDF),
    # The declared type alone is not enough: the file's own signature decides.
    "gif declared as png": ("image/png", GIF),
    "pdf declared as jpeg": ("image/jpeg", PDF),
    "text declared as png": ("image/png", b"isto nao e uma imagem"),
    # Each one a valid image, but not of the type it is declared as.
    "png declared as jpeg": ("image/jpeg", png()),
    "jpeg declared as png": ("image/png", JPEG),
    "one byte over 2 MB": ("image/png", _padded_png(TWO_MB + 1)),
}


def _stored_fields(student: dict[str, Any]) -> dict[str, Any]:
    return {
        field: student[field]
        for field in ("id", "owner_id", "full_name", "birth_date", "federation_id", "active")
    } | dict(zip(("belt", "since", "stripes"), graduation(student), strict=True))


# --- RN012 ---------------------------------------------------------------------------------


def test_rn012_logos_only_png_or_jpeg_up_to_2mb_by_examiners(
    user_pool: str, images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    primary, secondary = {"slot": "primary"}, {"slot": "secondary"}

    # PNG and JPEG are accepted, and an examiner reads them back.
    sent = ok(logo_handlers.put_logo, academy.examiner, body=image_body(png()), path=primary)
    assert (sent["content_type"], sent["size"]) == ("image/png", len(png()))
    sent = ok(
        logo_handlers.put_logo,
        academy.examiner,
        body=image_body(JPEG, "image/jpeg"),
        path=secondary,
    )
    assert (sent["content_type"], sent["size"]) == ("image/jpeg", len(JPEG))
    shown = ok(logo_handlers.get_logo, academy.sensei, path=primary)
    assert (shown["content_type"], shown["size"]) == ("image/png", len(png()))
    assert shown["url"].startswith("https://")
    shown = ok(logo_handlers.get_logo, academy.master, path=secondary)
    assert (shown["content_type"], shown["size"]) == ("image/jpeg", len(JPEG))

    # Anything else is refused, and the logo already there stays.
    for case, (content_type, data) in _INVALID_IMAGES.items():
        response = logo_handlers.put_logo(
            _upload_event(academy.examiner, primary, content_type, data), None
        )
        assert response["statusCode"] == 400, case
        assert _message(response) == MSG_INVALID_IMAGE, case
    shown = ok(logo_handlers.get_logo, academy.examiner, path=primary)
    assert (shown["content_type"], shown["size"]) == ("image/png", len(png()))

    # Exactly 2 MB is still "até 2 MB".
    sent = ok(
        logo_handlers.put_logo,
        academy.examiner,
        body=image_body(_padded_png(TWO_MB)),
        path=primary,
    )
    assert sent["size"] == TWO_MB

    # Upload, read and removal are of the examiners only.
    for caller, status, message in ((guardian, 403, MSG_EXAMINERS_ONLY), (None, 401, MSG_LOGIN)):
        refused(
            logo_handlers.put_logo, caller, status, message, body=image_body(png()), path=primary
        )
        refused(logo_handlers.get_logo, caller, status, message, path=primary)
        refused(logo_handlers.delete_logo, caller, status, message, path=primary)
    assert ok(logo_handlers.get_logo, academy.examiner, path=primary)["size"] == TWO_MB

    # The images never go in the settings JSON (§ 3.7).
    settings = ok(settings_handlers.get_settings, academy.examiner)
    assert not [key for key in settings if "logo" in key or "signature" in key]

    # Removal by an examiner.
    ok(logo_handlers.delete_logo, academy.examiner, 204, path=primary)
    refused(logo_handlers.get_logo, academy.examiner, 404, MSG_LOGO_NOT_FOUND, path=primary)
    assert ok(logo_handlers.get_logo, academy.examiner, path=secondary)["size"] == len(JPEG)


def _upload_event(
    user: User, path: dict[str, str], content_type: str, data: bytes
) -> dict[str, Any]:
    return api_event(user, body=image_body(data, content_type), path=path)


def _message(response: dict[str, Any]) -> str:
    body = response_json(response)
    assert set(body) == {"message"}
    return body["message"]


def test_rn012_signatures_are_written_and_read_only_by_master_and_sensei(
    user_pool: str, images_bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    fields = {"name": "Tomiyama", "graduation": "Sensei, 6º Dan"}

    # The master and the sensei create, edit, send the image, read and reorder.
    first = ok(signature_handlers.create_signature, academy.master, 201, body=fields)
    second = ok(
        signature_handlers.create_signature,
        academy.sensei,
        201,
        body={"name": "Jigoro Kano", "graduation": "Fundador (in memoriam)"},
    )
    first_path, second_path = {"id": first["id"]}, {"id": second["id"]}
    sent = ok(
        signature_handlers.put_signature_image,
        academy.sensei,
        body=image_body(png()),
        path=first_path,
    )
    assert (sent["image"]["content_type"], sent["complete"]) == ("image/png", True)
    sent = ok(
        signature_handlers.put_signature_image,
        academy.master,
        body=image_body(JPEG, "image/jpeg"),
        path=second_path,
    )
    assert (sent["image"]["content_type"], sent["complete"]) == ("image/jpeg", True)
    edited = ok(
        signature_handlers.update_signature,
        academy.sensei,
        body={**fields, "graduation": "Sensei, 7º Dan"},
        path=first_path,
    )
    assert edited["graduation"] == "Sensei, 7º Dan"
    for reader in (academy.master, academy.sensei):
        listed = ok(signature_handlers.list_signatures, reader)
        assert [item["name"] for item in listed["signatures"]] == ["Tomiyama", "Jigoro Kano"]
        assert listed["has_complete"] is True
        shown = ok(signature_handlers.get_signature_image, reader, path=first_path)
        assert shown["url"].startswith("https://")
    reordered = ok(
        signature_handlers.reorder_signatures,
        academy.master,
        body={"ids": [second["id"], first["id"]]},
    )
    assert [item["name"] for item in reordered["signatures"]] == ["Jigoro Kano", "Tomiyama"]

    # Only PNG or JPEG of up to 2 MB, by the file's own signature.
    for case, (content_type, data) in _INVALID_IMAGES.items():
        response = signature_handlers.put_signature_image(
            _upload_event(academy.sensei, first_path, content_type, data), None
        )
        assert response["statusCode"] == 400, case
        assert _message(response) == MSG_INVALID_IMAGE, case

    before = ok(signature_handlers.list_signatures, academy.master)
    # Never a guardian nor another examiner (risk of a forged certificate), not even
    # to read; and nobody without login.
    for caller, status, message in (
        (academy.examiner, 403, MSG_ONLY_MASTER_OR_SENSEI),
        (guardian, 403, MSG_ONLY_MASTER_OR_SENSEI),
        (None, 401, MSG_LOGIN),
    ):
        refused(signature_handlers.list_signatures, caller, status, message)
        refused(signature_handlers.create_signature, caller, status, message, body=fields)
        refused(
            signature_handlers.update_signature,
            caller,
            status,
            message,
            body=fields,
            path=first_path,
        )
        refused(
            signature_handlers.reorder_signatures,
            caller,
            status,
            message,
            body={"ids": [first["id"], second["id"]]},
        )
        refused(
            signature_handlers.put_signature_image,
            caller,
            status,
            message,
            body=image_body(png()),
            path=first_path,
        )
        refused(signature_handlers.get_signature_image, caller, status, message, path=first_path)
        refused(signature_handlers.delete_signature_image, caller, status, message, path=first_path)
        refused(signature_handlers.delete_signature, caller, status, message, path=first_path)
    assert ok(signature_handlers.list_signatures, academy.master) == before

    # Removal: the image by the master, the signature by the sensei.
    ok(signature_handlers.delete_signature_image, academy.master, 204, path=second_path)
    ok(signature_handlers.delete_signature, academy.sensei, 204, path=first_path)
    listed = ok(signature_handlers.list_signatures, academy.sensei)
    assert [(item["name"], item["complete"]) for item in listed["signatures"]] == [
        ("Jigoro Kano", False)
    ]
    assert listed["has_complete"] is False


# --- RN013 ---------------------------------------------------------------------------------


def test_rn013_guardian_sees_and_edits_only_the_own_students(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    family = academy.guardian("familia@example.com")
    other_family = academy.guardian("outra.familia@example.com")
    ana = academy.register(family, "Ana", "Cinza")
    bruno = academy.register(other_family, "Bruno", "Azul")
    assert (ana["owner_id"], bruno["owner_id"]) == (family.sub, other_family.sub)

    def names(viewer: User) -> list[str]:
        return [student["full_name"] for student in ok(student_handlers.list_students, viewer)]

    # Each guardian sees the own students; the examiners see all.
    assert (names(family), names(other_family)) == (["Ana"], ["Bruno"])
    for examiner in (academy.examiner, academy.sensei, academy.master):
        assert names(examiner) == ["Ana", "Bruno"]
    refused(student_handlers.list_students, None, 401, MSG_LOGIN)

    # Someone else's student: as if it did not exist, to read, edit or delete.
    ana_path = {"id": ana["id"]}
    refused(student_handlers.get_student, other_family, 404, MSG_STUDENT_NOT_FOUND, path=ana_path)
    academy.update_student_refused(
        other_family, ana, 404, MSG_STUDENT_NOT_FOUND, full_name="Outro nome"
    )
    refused(
        student_handlers.delete_student, other_family, 404, MSG_STUDENT_NOT_FOUND, path=ana_path
    )
    refused(student_handlers.get_student, None, 401, MSG_LOGIN, path=ana_path)
    assert _stored_fields(academy.student(ana)) == _stored_fields(ana)

    # The owner is who registered, whatever the body says.
    carla = ok(
        student_handlers.create_student,
        family,
        201,
        body={**student_form(ana, full_name="Carla"), "owner_id": other_family.sub},
    )
    assert carla["owner_id"] == family.sub
    assert (names(family), names(other_family)) == (["Ana", "Carla"], ["Bruno"])

    # The guardian reads and edits the own student; an examiner edits anyone's.
    assert ok(student_handlers.get_student, family, path=ana_path)["full_name"] == "Ana"
    academy.update_student(family, ana, full_name="Ana Souza")
    academy.update_student(academy.examiner, bruno, full_name="Bruno Lima")
    assert (names(family), names(other_family)) == (["Ana Souza", "Carla"], ["Bruno Lima"])


def test_rn013_graduation_lock_after_the_first_exam(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Cinza")
    bia = academy.register(guardian, "Bia", "Cinza")

    # Before the first exam the guardian corrects the graduation freely.
    ana = academy.update_student(
        guardian,
        ana,
        current_belt_id=academy.belt_id("Azul"),
        current_belt_since="2026-02-01",
        stripes=1,
    )
    assert graduation(ana) == (academy.belt_id("Azul"), "2026-02-01", 1)

    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)
    academy.attend(exam_event, bia)
    academy.clock.set(DECISION_AT)
    academy.decide(exam_event, ana, "FAILED")
    academy.decide(exam_event, bia, "APPROVED")
    # The exam itself changes the graduation (Bia was approved).
    promoted = academy.student(bia)
    assert graduation(promoted) == (academy.belt_id("Cinza/Azul"), EVENT_DATE, 0)

    # After the first exam (already decided), the guardian no longer changes the belt,
    # its date or the stripes.
    changes: tuple[dict[str, Any], ...] = (
        {"current_belt_id": academy.belt_id("Amarela")},
        {"current_belt_since": "2026-01-10"},
        {"stripes": 2},
    )
    for student in (ana, promoted):
        for change in changes:
            academy.update_student_refused(guardian, student, 403, MSG_GRADUATION_LOCKED, **change)
        # Refused as a whole: the name sent with the change is not recorded either.
        academy.update_student_refused(
            guardian, student, 403, MSG_GRADUATION_LOCKED, full_name="Outro nome", stripes=2
        )
        assert _stored_fields(academy.student(student)) == _stored_fields(student)
    # A form opened before the approval resends the former graduation: it would undo
    # the exam's result, so it is a change like any other.
    academy.update_student_refused(guardian, bia, 403, MSG_GRADUATION_LOCKED, full_name="Bia Lima")

    # The lock compares with the current values: resending them (the form sends every
    # field) does not block the name or the federation id.
    for student, new_name in ((ana, "Ana Souza"), (promoted, "Bia Lima")):
        edited = academy.update_student(
            guardian, student, full_name=new_name, federation_id="SP-123"
        )
        assert (edited["full_name"], edited["federation_id"]) == (new_name, "SP-123")
        assert graduation(academy.student(student)) == graduation(student)

    # An examiner still changes the graduation after the first exam.
    fixed = academy.update_student(
        academy.examiner,
        academy.student(ana),
        current_belt_id=academy.belt_id("Amarela"),
        current_belt_since="2026-01-10",
        stripes=2,
    )
    assert graduation(fixed) == (academy.belt_id("Amarela"), "2026-01-10", 2)
    assert graduation(academy.student(ana)) == graduation(fixed)


# --- RN014 ---------------------------------------------------------------------------------

TODAY = "2026-11-01"  # ``SCENARIO_NOW`` in Brasília
TOMORROW = "2026-11-02"
# (birth_date, current_belt_since) RN014 refuses, by case.
_INVALID_DATES = {
    "birth in the future": (TOMORROW, TOMORROW),
    "belt date in the future": ("2018-05-10", TOMORROW),
    "belt date before the birth": ("2018-05-10", "2018-05-09"),
}


def test_rn014_birth_and_belt_dates(user_pool: str, monkeypatch: pytest.MonkeyPatch) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    ana = academy.register(guardian, "Ana", "Cinza", birth="2018-05-10", since="2026-03-14")

    for case, (birth, since) in _INVALID_DATES.items():
        # On the registration, by a guardian or an examiner.
        for author in (guardian, academy.examiner):
            response = student_handlers.create_student(
                _student_event(author, student_form(ana, birth_date=birth), since), None
            )
            assert response["statusCode"] == 400, case
            assert _message(response) == MSG_INVALID_DATES, case
        # And on the edit.
        for editor in (guardian, academy.examiner):
            academy.update_student_refused(
                editor, ana, 400, MSG_INVALID_DATES, birth_date=birth, current_belt_since=since
            )
    # Nothing was recorded.
    students = ok(student_handlers.list_students, academy.examiner)
    assert [student["full_name"] for student in students] == ["Ana"]
    assert _stored_fields(academy.student(ana)) == _stored_fields(ana)

    # The limits are accepted: today is not the future, and the belt date may be the
    # birth date itself.
    born_today = academy.register(guardian, "Bebê", "Branca", birth=TODAY, since=TODAY)
    assert (born_today["birth_date"], born_today["current_belt_since"]) == (TODAY, TODAY)
    edited = academy.update_student(
        guardian, ana, birth_date="2018-05-10", current_belt_since="2018-05-10"
    )
    assert (edited["birth_date"], edited["current_belt_since"]) == ("2018-05-10", "2018-05-10")
    edited = academy.update_student(guardian, edited, current_belt_since=TODAY)
    assert edited["current_belt_since"] == TODAY


def _student_event(user: User, form: dict[str, Any], since: str) -> dict[str, Any]:
    return api_event(user, body={**form, "current_belt_since": since})


# --- RN015 ---------------------------------------------------------------------------------


def _belt_form(belt: dict[str, Any], **changes: Any) -> dict[str, Any]:
    """The body of ``PUT /belts/{id}``: every field of the belt but the id."""
    return {**{key: value for key, value in belt.items() if key != "id"}, **changes}


def test_rn015_only_examiners_edit_belts_with_valid_unique_values(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    # 7 on the event date; Azul/Amarela asks for 8 (§ 4).
    academy.register(guardian, "Bruno", "Azul", birth="2019-06-20", since="2026-07-01")
    cinza, target = academy.belts["Cinza"], academy.belts["Azul/Amarela"]
    cinza_path, target_path = {"id": cinza["id"]}, {"id": target["id"]}
    original = ok(belt_handlers.list_belts, academy.examiner)

    # Any logged user reads the belts (the student form picks one); only examiners edit.
    assert ok(belt_handlers.list_belts, guardian) == original
    refused(belt_handlers.list_belts, None, 401, MSG_LOGIN)
    refused(
        belt_handlers.update_belt,
        guardian,
        403,
        MSG_EXAMINERS_ONLY,
        body=_belt_form(target, min_age_years=7),
        path=target_path,
    )
    refused(
        belt_handlers.update_belt,
        None,
        401,
        MSG_LOGIN,
        body=_belt_form(target, min_age_years=7),
        path=target_path,
    )

    # Unique name and order; age and waiting period >= 0; colours as #RRGGBB.
    invalid: tuple[tuple[dict[str, Any], int, str], ...] = (
        ({"name": "Azul"}, 409, MSG_BELT_NAME_TAKEN),
        # The name of another belt in another case is still the same name.
        ({"name": "azul"}, 409, MSG_BELT_NAME_TAKEN),
        ({"sort_order": 4}, 409, MSG_BELT_ORDER_TAKEN),
        ({"min_age_years": -1}, 400, "Idade mínima: deve estar entre 0 e 99"),
        ({"min_months_previous": -1}, 400, "Carência: deve estar entre 0 e 240"),
        ({"color_primary": "cinza"}, 400, "Cor: use o formato #RRGGBB"),
        ({"color_primary": "#9E9E9"}, 400, "Cor: use o formato #RRGGBB"),
        ({"color_primary": "#9E9E9E0"}, 400, "Cor: use o formato #RRGGBB"),
        ({"color_primary": "9E9E9E"}, 400, "Cor: use o formato #RRGGBB"),
        ({"color_primary": "#9E9E9G"}, 400, "Cor: use o formato #RRGGBB"),
        ({"color_secondary": "azul"}, 400, "Cor das pontas: use o formato #RRGGBB"),
    )
    for change, status, message in invalid:
        refused(
            belt_handlers.update_belt,
            academy.examiner,
            status,
            message,
            body=_belt_form(cinza, **change),
            path=cinza_path,
        )
    assert ok(belt_handlers.list_belts, academy.examiner) == original
    assert academy.roster(EVENT_DATE)["Bruno"]["eligibility"] == academy.eligibility(
        "Azul/Amarela", "BELT", msg_minimum_age("Azul/Amarela", 8)
    )

    # A valid edit by an examiner, zero included; the rules follow the edited table.
    edited = ok(
        belt_handlers.update_belt,
        academy.examiner,
        body=_belt_form(target, min_age_years=7, min_months_previous=0, color_secondary="#FFD500"),
        path=target_path,
    )
    assert (edited["min_age_years"], edited["min_months_previous"], edited["color_secondary"]) == (
        7,
        0,
        "#FFD500",
    )
    zero_age = ok(
        belt_handlers.update_belt,
        academy.examiner,
        body=_belt_form(cinza, min_age_years=0, name="Cinza claro"),
        path=cinza_path,
    )
    assert (zero_age["min_age_years"], zero_age["name"]) == (0, "Cinza claro")
    now = ok(belt_handlers.list_belts, guardian)
    assert now == [{cinza["id"]: zero_age, target["id"]: edited}.get(b["id"], b) for b in original]
    assert academy.roster(EVENT_DATE)["Bruno"]["eligibility"] == academy.eligibility(
        "Azul/Amarela", "BELT"
    )


# --- RN016 ---------------------------------------------------------------------------------


def _event_form(exam_event: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        **{key: exam_event[key] for key in ("name", "exam_date", "status")},
        **changes,
    }


def test_rn016_only_examiners_manage_events_and_closed_blocks_attendance_and_marking(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Branca/Cinza",))
    guardian = academy.guardian()
    ana = academy.register(guardian, "Ana", "Branca")
    bia = academy.register(guardian, "Bia", "Branca")

    # An examiner creates (open by default), reads, lists and edits.
    exam_event = academy.event()
    assert (exam_event["name"], exam_event["exam_date"], exam_event["status"]) == (
        EVENT_NAME,
        EVENT_DATE,
        "OPEN",
    )
    event_path = {"id": exam_event["id"]}
    empty_event = academy.event("2027-10-09", "Exame outubro/2027")
    empty_path = {"id": empty_event["id"]}
    assert ok(event_handlers.get_event, academy.examiner, path=event_path) == exam_event
    # From the most recent to the oldest (§ 6.5).
    assert ok(event_handlers.list_events, academy.examiner) == [empty_event, exam_event]
    renamed = ok(
        event_handlers.update_event,
        academy.examiner,
        body=_event_form(exam_event, name="Exame de março"),
        path=event_path,
    )
    assert (renamed["name"], renamed["status"]) == ("Exame de março", "OPEN")

    # A guardian manages nothing, and nobody does without login.
    for caller, status, message in ((guardian, 403, MSG_EXAMINERS_ONLY), (None, 401, MSG_LOGIN)):
        refused(event_handlers.list_events, caller, status, message)
        refused(event_handlers.get_event, caller, status, message, path=event_path)
        refused(
            event_handlers.create_event,
            caller,
            status,
            message,
            body={"name": "Exame da família", "exam_date": "2027-06-12"},
        )
        refused(
            event_handlers.update_event,
            caller,
            status,
            message,
            body=_event_form(renamed, status="CLOSED"),
            path=event_path,
        )
        refused(event_handlers.delete_event, caller, status, message, path=empty_path)
    assert ok(event_handlers.list_events, academy.examiner) == [empty_event, renamed]

    academy.clock.set(EXAM_DAY_AT)
    academy.attend(renamed, ana)
    items = academy.sheet(renamed, ana)["items"]
    academy.mark(renamed, ana, items[0], True)

    # Closed: no attendance and no marking.
    closed = academy.set_event_status(renamed, "CLOSED")
    assert closed["status"] == "CLOSED"
    academy.attendance_refused(closed, bia, 400, MSG_EVENT_CLOSED)
    academy.mark_refused(closed, ana, items[1], 400, MSG_EVENT_CLOSED)
    assert [exam["student_name"] for exam in academy.event_exams(closed)] == ["Ana"]
    sheet = academy.sheet(closed, ana)
    assert [item["answer"] is not None for item in sheet["items"]] == [True] + [False] * 5

    # An event with exams cannot be deleted, closed or not, decided or not.
    refused(
        event_handlers.delete_event, academy.examiner, 409, MSG_EVENT_HAS_EXAMS, path=event_path
    )
    academy.clock.set(DECISION_AT)
    academy.decide(closed, ana, "FAILED")
    refused(
        event_handlers.delete_event, academy.examiner, 409, MSG_EVENT_HAS_EXAMS, path=event_path
    )
    academy.set_event_status(closed, "OPEN")
    refused(
        event_handlers.delete_event, academy.examiner, 409, MSG_EVENT_HAS_EXAMS, path=event_path
    )
    assert ok(event_handlers.get_event, academy.examiner, path=event_path)["status"] == "OPEN"
    assert [exam["status"] for exam in academy.event_exams(closed)] == ["FAILED"]

    # An event without exams can.
    ok(event_handlers.delete_event, academy.examiner, 204, path=empty_path)
    refused(event_handlers.get_event, academy.examiner, 404, MSG_EVENT_NOT_FOUND, path=empty_path)
    listed = ok(event_handlers.list_events, academy.examiner)
    assert [item["id"] for item in listed] == [exam_event["id"]]


# --- RN017 ---------------------------------------------------------------------------------


def _requirements(academy: Academy, **query: str) -> list[dict[str, Any]]:
    return ok(requirement_handlers.list_requirements, academy.examiner, query=query or None)


def test_rn017_only_examiners_manage_requirements_listed_by_belt_and_kind(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch, sheets=("Marrom", "Branca/Cinza"))
    guardian = academy.guardian()
    marrom, branca_cinza = academy.belt_id("Marrom"), academy.belt_id("Branca/Cinza")

    # The Marrom sheet comes whole: 139 items (42 theory, 97 practice), in sheet order.
    sheet = _requirements(academy, belt_id=marrom)
    assert len(sheet) == 139
    assert {item["belt_id"] for item in sheet} == {marrom}
    orders = [item["sort_order"] for item in sheet]
    assert orders == sorted(orders)
    assert len(set(orders)) == 139
    theory = _requirements(academy, belt_id=marrom, kind="THEORY")
    practice = _requirements(academy, belt_id=marrom, kind="PRACTICE")
    assert (len(theory), len(practice)) == (42, 97)
    assert theory == [item for item in sheet if item["kind"] == "THEORY"]
    assert practice == [item for item in sheet if item["kind"] == "PRACTICE"]
    # Without a filter: every item, in the order of the belts and of each sheet.
    small_sheet = _requirements(academy, belt_id=branca_cinza)
    assert len(small_sheet) == 6
    assert _requirements(academy) == small_sheet + sheet
    assert _requirements(academy, kind="PRACTICE") == [
        item for item in small_sheet + sheet if item["kind"] == "PRACTICE"
    ]

    new_item = {
        "belt_id": marrom,
        "kind": "THEORY",
        "category": "Histórico",
        "description": "Quem fundou o Judô?",
        "expected_answer": "Jigoro Kano",
    }
    first_path = {"id": sheet[0]["id"]}
    # A guardian manages nothing, and nobody does without login.
    for caller, status, message in ((guardian, 403, MSG_EXAMINERS_ONLY), (None, 401, MSG_LOGIN)):
        refused(requirement_handlers.list_requirements, caller, status, message)
        refused(requirement_handlers.create_requirement, caller, status, message, body=new_item)
        refused(
            requirement_handlers.update_requirement,
            caller,
            status,
            message,
            body=new_item,
            path=first_path,
        )
        refused(requirement_handlers.delete_requirement, caller, status, message, path=first_path)
    # The belt has to exist, on the creation and on the edit.
    for handler, status, path in (
        (requirement_handlers.create_requirement, 400, None),
        (requirement_handlers.update_requirement, 400, first_path),
    ):
        refused(
            handler,
            academy.examiner,
            status,
            MSG_REQUIREMENT_BELT_NOT_FOUND,
            body={**new_item, "belt_id": "faixa-que-nao-existe"},
            path=path,
        )
    assert _requirements(academy) == small_sheet + sheet

    # An examiner creates (at the end of the sheet), edits and deletes.
    created = ok(requirement_handlers.create_requirement, academy.examiner, 201, body=new_item)
    assert {key: created[key] for key in new_item} == new_item
    assert created["sort_order"] > max(orders)
    assert _requirements(academy, belt_id=marrom) == sheet + [created]  # 140: still not cut
    created_path = {"id": created["id"]}
    edited = ok(
        requirement_handlers.update_requirement,
        academy.examiner,
        body={**new_item, "kind": "PRACTICE", "description": "Demonstrar o-soto-gari"},
        path=created_path,
    )
    assert (edited["kind"], edited["description"]) == ("PRACTICE", "Demonstrar o-soto-gari")
    assert _requirements(academy, belt_id=marrom, kind="PRACTICE") == practice + [edited]
    assert _requirements(academy, belt_id=marrom, kind="THEORY") == theory
    ok(requirement_handlers.delete_requirement, academy.examiner, 204, path=created_path)
    assert _requirements(academy, belt_id=marrom) == sheet
    refused(
        requirement_handlers.update_requirement,
        academy.examiner,
        404,
        MSG_REQUIREMENT_NOT_FOUND,
        body=new_item,
        path=created_path,
    )


# --- RN018 ---------------------------------------------------------------------------------


def test_rn018_student_with_exams_is_not_deleted_and_the_history_stays(
    user_pool: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    academy = open_academy(user_pool, monkeypatch)
    guardian = academy.guardian()
    exam_event = academy.event()
    ana = academy.register(guardian, "Ana", "Branca")  # exam in progress
    bia = academy.register(guardian, "Bia", "Branca")  # exam decided
    caio = academy.register(guardian, "Caio", "Branca")  # no exam
    academy.clock.set(EXAM_DAY_AT)
    academy.attend(exam_event, ana)
    academy.attend(exam_event, bia)
    academy.clock.set(DECISION_AT)
    academy.decide(exam_event, bia, "APPROVED")
    exams = academy.event_exams(exam_event)
    histories = {student["id"]: academy.history(student) for student in (ana, bia)}
    assert [(exam["student_name"], exam["status"]) for exam in exams] == [
        ("Ana", "IN_PROGRESS"),
        ("Bia", "APPROVED"),
    ]
    assert [len(history) for history in histories.values()] == [1, 1]

    def roster_names() -> list[str]:
        return list(academy.roster(EVENT_DATE))

    # A student with exams is not deleted by the guardian (nor by an examiner: the
    # exams are never deleted in cascade).
    for student in (ana, bia):
        for caller in (guardian, academy.examiner):
            refused(
                student_handlers.delete_student,
                caller,
                409,
                MSG_STUDENT_HAS_EXAMS,
                path={"id": student["id"]},
            )
    assert roster_names() == ["Ana", "Bia", "Caio"]
    assert academy.event_exams(exam_event) == exams

    # The examiner makes the student inactive instead: out of the list of active
    # students, with the history preserved.
    inactive = academy.update_student(academy.examiner, academy.student(bia), active=False)
    assert inactive["active"] is False
    assert roster_names() == ["Ana", "Caio"]
    hidden = ok(student_handlers.list_students, academy.examiner, query={"active": "false"})
    assert [student["full_name"] for student in hidden] == ["Bia"]
    refused(
        student_handlers.delete_student,
        guardian,
        409,
        MSG_STUDENT_HAS_EXAMS,
        path={"id": bia["id"]},
    )
    assert academy.event_exams(exam_event) == exams
    for student in (ana, bia):
        assert academy.history(student) == histories[student["id"]]
    assert graduation(academy.student(bia)) == (academy.belt_id("Branca/Cinza"), EVENT_DATE, 0)

    # A student without exams is deleted by the guardian.
    ok(student_handlers.delete_student, guardian, 204, path={"id": caio["id"]})
    refused(
        student_handlers.get_student,
        guardian,
        404,
        MSG_STUDENT_NOT_FOUND,
        path={"id": caio["id"]},
    )
    assert [student["full_name"] for student in ok(student_handlers.list_students, guardian)] == [
        "Ana",
        "Bia",
    ]
    assert academy.event_exams(exam_event) == exams
