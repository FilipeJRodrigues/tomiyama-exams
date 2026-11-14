"""The event chooses its requirement profile (RN016; #144, step 3b-1).

Decision of 2026-11-12: the profile is chosen per event (default: the main
one) and does not change once the event has exams. An event stored before
this step has no ``profile_id`` and is read as an event of the main profile.

Two guarantees are in the write itself, not in an earlier read:

- a change of profile is conditioned on the event's ``exam_count``, so an
  attendance confirmed between the read and the write refuses it;
- an event that starts using a stored profile (creation or change) is written
  in a transaction that checks the profile is ``READY`` in the profiles item,
  so a profile that left ``READY`` meanwhile is never taken by a new event.
"""

import os
import uuid
from dataclasses import replace
from datetime import date
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from conftest import (
    DYNAMODB_THROTTLING_CODES,
    EXAMINER,
    GUARDIAN,
    api_event,
    assert_service_busy,
    before_dynamodb_call,
    dynamodb_snapshot,
    make_student,
    response_json,
    throttle_dynamodb,
)

from domain import events as event_rules
from domain import requirement_profiles as profile_rules
from domain.errors import ConflictError, NotFoundError, ValidationError
from domain.events import EventStatus, ExamEvent
from domain.requirement_profiles import MAIN_PROFILE, MAIN_PROFILE_ID, ProfileStatus
from handlers import events as handlers
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import exams as exam_repo
from repository import requirement_profiles as profile_repo
from repository import students as student_repo
from repository.tables import EXAM_COUNT

NOW = "2026-11-01T12:00:00+00:00"
PROFILE_NOT_FOUND = "Perfil de requisitos não encontrado"
PROFILE_COPYING = (
    "O perfil ainda está sendo copiado. Aguarde o fim da cópia para usá-lo em um evento."
)
PROFILE_LOCKED = (
    "O perfil de requisitos do evento não pode ser alterado depois que o evento tem exames"
)
EVENT_NOT_FOUND = "Evento não encontrado"
TRY_AGAIN = "Outra alteração está em andamento. Tente de novo."


# --- helpers ---------------------------------------------------------------


def _store_profile(name: str, *, ready: bool = True) -> str:
    """Store a profile (no items: the events only need its status)."""
    profile_id = str(uuid.uuid4())
    profile_repo.create_profile(
        lambda stored: profile_rules.plan_new_profile(
            stored,
            profile_id=profile_id,
            name=name,
            source_profile_id=None,
            user_sub=EXAMINER.sub,
            now_iso=NOW,
        )
    )
    if ready:
        assert profile_repo.mark_ready(profile_id, NOW, 0, 0)
    return profile_id


def _settings_table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["SETTINGS_TABLE"])


def _events_table() -> Any:
    return boto3.resource("dynamodb").Table(os.environ["EVENTS_TABLE"])


def _remove_profile(profile_id: str) -> None:
    """Take the profile out of the profiles item, as step 3b-2's delete will."""
    _settings_table().update_item(
        Key={"id": profile_repo.REQUIREMENT_PROFILES_ID},
        UpdateExpression="REMOVE #profiles.#id",
        ExpressionAttributeNames={"#profiles": "profiles", "#id": profile_id},
    )


def _set_status(profile_id: str, status: str) -> None:
    _settings_table().update_item(
        Key={"id": profile_repo.REQUIREMENT_PROFILES_ID},
        UpdateExpression="SET #profiles.#id.#status = :status",
        ExpressionAttributeNames={"#profiles": "profiles", "#id": profile_id, "#status": "status"},
        ExpressionAttributeValues={":status": status},
    )


def _payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": "Exame março/2027", "exam_date": "2027-03-20"}
    payload.update(overrides)
    return payload


def _post(**overrides: Any) -> dict[str, Any]:
    return handlers.create_event(api_event(EXAMINER, body=_payload(**overrides)), None)


def _create(**overrides: Any) -> dict[str, Any]:
    response = _post(**overrides)
    assert response["statusCode"] == 201, response["body"]
    return response_json(response)


def _put(event_id: str, **overrides: Any) -> dict[str, Any]:
    return handlers.update_event(
        api_event(EXAMINER, path={"id": event_id}, body=_payload(**overrides)), None
    )


def _stored(event_id: str) -> dict[str, Any]:
    return _events_table().get_item(Key={"id": event_id}, ConsistentRead=True)["Item"]


def _assert_refused(response: dict[str, Any], status: int, message: str) -> None:
    assert response["statusCode"] == status, response["body"]
    assert response_json(response) == {"message": message}


def _confirm_attendance(event_id: str, student_id: str = "student-1") -> None:
    """Confirm a real attendance (the transaction that adds 1 to ``exam_count``)."""
    if student_repo.get_student(student_id) is None:
        student_repo.create_student(replace(make_student(), id=student_id))
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": student_id}), None
    )
    assert response["statusCode"] == 201, response["body"]


def _cancelled(*reasons: str) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "x"},
            "CancellationReasons": [{"Code": reason} for reason in reasons],
        },
        "TransactWriteItems",
    )


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(event_repo.time, "sleep", lambda _seconds: None)


# --- the rule (pure) -------------------------------------------------------


def test_rn016_new_event_takes_the_profile_of_the_body_or_main() -> None:
    assert event_rules.create_event(_payload(), NOW).profile_id == MAIN_PROFILE_ID
    assert event_rules.create_event(_payload(profile_id=None), NOW).profile_id == MAIN_PROFILE_ID
    assert event_rules.create_event(_payload(profile_id="  "), NOW).profile_id == MAIN_PROFILE_ID
    assert event_rules.create_event(_payload(profile_id=" p-1 "), NOW).profile_id == "p-1"
    with pytest.raises(ValidationError) as invalid:
        event_rules.create_event(_payload(profile_id=7), NOW)
    assert invalid.value.message == "Perfil: valor inválido"


def test_rn016_edit_keeps_the_profile_unless_the_body_names_another() -> None:
    existing = ExamEvent("e", "Exame", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW, "p-1")

    for body in (_payload(), _payload(profile_id=None), _payload(profile_id=""), _payload()):
        assert event_rules.update_event(existing, body, NOW).profile_id == "p-1"
    assert event_rules.update_event(existing, _payload(profile_id="p-1"), NOW).profile_id == "p-1"
    assert event_rules.update_event(existing, _payload(profile_id="p-2"), NOW).profile_id == "p-2"
    assert (
        event_rules.update_event(existing, _payload(profile_id="main"), NOW).profile_id
        == MAIN_PROFILE_ID
    )
    with pytest.raises(ValidationError) as too_long:
        event_rules.update_event(existing, _payload(profile_id="x" * 65), NOW)
    assert too_long.value.message == "Perfil: máximo de 64 caracteres"


def test_rn016_event_without_profile_is_of_the_main_profile_and_shows_it() -> None:
    event = ExamEvent("e", "Exame", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)

    assert event.profile_id == MAIN_PROFILE_ID
    assert event.to_dict()["profile_id"] == "main"


def test_rn016_only_a_ready_profile_may_be_chosen() -> None:
    copying = replace(MAIN_PROFILE, id="p-1", is_main=False, status=ProfileStatus.COPYING)

    event_rules.check_profile_usable(MAIN_PROFILE)
    event_rules.check_profile_usable(replace(copying, status=ProfileStatus.READY))
    with pytest.raises(ConflictError) as refused:
        event_rules.check_profile_usable(copying)
    assert refused.value.message == PROFILE_COPYING


# --- POST /events ----------------------------------------------------------


@pytest.mark.parametrize(
    "body", [{}, {"profile_id": None}, {"profile_id": ""}, {"profile_id": " "}]
)
def test_rn016_create_defaults_to_the_main_profile(aws: None, body: dict[str, Any]) -> None:
    created = _create(**body)

    assert created["profile_id"] == "main"
    assert _stored(created["id"])["profile_id"] == "main"
    got = handlers.get_event(api_event(EXAMINER, path={"id": created["id"]}), None)
    assert response_json(got) == created
    listed = response_json(handlers.list_events(api_event(EXAMINER), None))
    assert listed == [created]


def test_rn016_create_with_the_main_profile_named(aws: None) -> None:
    assert _create(profile_id="main")["profile_id"] == "main"


def test_rn016_create_with_a_ready_profile(aws: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")

    created = _create(profile_id=profile_id)

    assert created["profile_id"] == profile_id
    assert created["status"] == "OPEN"
    stored = event_repo.get_event(created["id"])
    assert stored is not None
    assert stored.profile_id == profile_id
    assert response_json(handlers.list_events(api_event(EXAMINER), None)) == [created]
    assert event_repo.get_events([created["id"]])[created["id"]].profile_id == profile_id


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (7, "Perfil: valor inválido"),
        (["main"], "Perfil: valor inválido"),
        ({"id": "main"}, "Perfil: valor inválido"),
        (True, "Perfil: valor inválido"),
        ("x" * 65, "Perfil: máximo de 64 caracteres"),
    ],
)
def test_rn016_create_rejects_an_invalid_profile_id(aws: None, value: Any, message: str) -> None:
    _assert_refused(_post(profile_id=value), 400, message)
    assert event_repo.list_all() == []


@pytest.mark.parametrize("profile_id", ["missing", "MAIN", "Main", "x" * 64])
def test_rn016_create_with_unknown_profile_is_404(aws: None, profile_id: str) -> None:
    _store_profile("Perfil do Sensei")

    _assert_refused(_post(profile_id=profile_id), 404, PROFILE_NOT_FOUND)
    assert event_repo.list_all() == []


def test_rn016_create_with_unknown_profile_is_404_before_any_profile_exists(aws: None) -> None:
    _assert_refused(_post(profile_id="missing"), 404, PROFILE_NOT_FOUND)
    assert event_repo.list_all() == []


def test_rn016_create_with_copying_profile_is_409(aws: None) -> None:
    profile_id = _store_profile("Perfil em cópia", ready=False)

    _assert_refused(_post(profile_id=profile_id), 409, PROFILE_COPYING)
    assert event_repo.list_all() == []

    # Once the copy finishes, the same request is accepted.
    assert profile_repo.mark_ready(profile_id, NOW, 0, 0)
    assert _create(profile_id=profile_id)["profile_id"] == profile_id


def test_rn016_create_validation_comes_before_the_profile(aws: None) -> None:
    _assert_refused(_post(name="", profile_id="missing"), 400, "Campo obrigatório: Nome")
    assert event_repo.list_all() == []


def test_rn016_only_examiners_choose_the_profile(aws: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create()
    snapshot = dynamodb_snapshot()

    post = handlers.create_event(api_event(GUARDIAN, body=_payload(profile_id=profile_id)), None)
    put = handlers.update_event(
        api_event(GUARDIAN, path={"id": created["id"]}, body=_payload(profile_id=profile_id)),
        None,
    )

    _assert_refused(post, 403, "Esta área é dos examinadores")
    _assert_refused(put, 403, "Esta área é dos examinadores")
    assert dynamodb_snapshot() == snapshot


# --- events stored before this step ----------------------------------------


def test_rn016_event_stored_without_profile_is_read_as_main(aws: None) -> None:
    _events_table().put_item(
        Item={
            "id": "old-event",
            "name": "Exame antigo",
            "exam_date": "2026-06-13",
            "status": "CLOSED",
            "created_at": NOW,
            "updated_at": NOW,
            "exam_count": 2,
        }
    )

    assert event_repo.get_event("old-event").profile_id == MAIN_PROFILE_ID
    assert event_repo.get_events(["old-event"])["old-event"].profile_id == MAIN_PROFILE_ID
    assert [item.profile_id for item in event_repo.list_all()] == [MAIN_PROFILE_ID]
    got = handlers.get_event(api_event(EXAMINER, path={"id": "old-event"}), None)
    assert response_json(got)["profile_id"] == "main"
    assert response_json(handlers.list_events(api_event(EXAMINER), None))[0]["profile_id"] == "main"

    # Editing it (resending "main", as the form does) works even with exams.
    renamed = _put("old-event", name="Exame de junho", exam_date="2026-06-13", profile_id="main")
    assert renamed["statusCode"] == 200, renamed["body"]
    assert response_json(renamed)["profile_id"] == "main"
    stored = _stored("old-event")
    assert stored["name"] == "Exame de junho"
    assert stored["exam_count"] == 2
    # And another profile is refused: it has exams.
    other = _store_profile("Perfil do Sensei")
    _assert_refused(
        _put("old-event", exam_date="2026-06-13", profile_id=other), 409, PROFILE_LOCKED
    )


# --- PUT /events/{id} without exams -----------------------------------------


def test_rn016_change_profile_while_the_event_has_no_exams(aws: None) -> None:
    first = _store_profile("Perfil A")
    second = _store_profile("Perfil B")
    created = _create()

    to_first = _put(created["id"], name="Exame abril/2027", status="CLOSED", profile_id=first)
    assert to_first["statusCode"] == 200, to_first["body"]
    body = response_json(to_first)
    assert (body["profile_id"], body["name"], body["status"]) == (
        first,
        "Exame abril/2027",
        "CLOSED",
    )
    assert body["created_at"] == created["created_at"]
    assert event_repo.get_event(created["id"]).profile_id == first

    to_second = _put(created["id"], profile_id=second)
    assert to_second["statusCode"] == 200, to_second["body"]
    assert event_repo.get_event(created["id"]).profile_id == second

    to_main = _put(created["id"], profile_id="main")
    assert to_main["statusCode"] == 200, to_main["body"]
    assert response_json(to_main)["profile_id"] == "main"
    stored = event_repo.get_event(created["id"])
    assert stored.profile_id == MAIN_PROFILE_ID
    # A status left out of the body is kept through the changes.
    assert stored.status == EventStatus.CLOSED


@pytest.mark.parametrize(
    "body", [{}, {"profile_id": None}, {"profile_id": ""}, {"profile_id": " "}]
)
def test_rn016_update_without_profile_keeps_the_current_one(
    aws: None, body: dict[str, Any]
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id)

    response = _put(created["id"], name="Outro nome", **body)

    assert response["statusCode"] == 200, response["body"]
    assert response_json(response)["profile_id"] == profile_id
    stored = event_repo.get_event(created["id"])
    assert (stored.name, stored.profile_id) == ("Outro nome", profile_id)


def test_rn016_change_to_unknown_profile_is_404_and_writes_nothing(aws: None) -> None:
    created = _create()
    snapshot = dynamodb_snapshot()

    _assert_refused(_put(created["id"], name="Novo", profile_id="missing"), 404, PROFILE_NOT_FOUND)
    assert dynamodb_snapshot() == snapshot


def test_rn016_change_to_copying_profile_is_409_and_writes_nothing(aws: None) -> None:
    copying = _store_profile("Perfil em cópia", ready=False)
    created = _create()
    snapshot = dynamodb_snapshot()

    _assert_refused(_put(created["id"], name="Novo", profile_id=copying), 409, PROFILE_COPYING)
    assert dynamodb_snapshot() == snapshot


def test_rn016_update_refusals_follow_the_documented_order(seeded: None) -> None:
    copying = _store_profile("Perfil em cópia", ready=False)
    created = _create()
    _confirm_attendance(created["id"])
    snapshot = dynamodb_snapshot()

    # Unknown event first, whatever the body.
    _assert_refused(_put("missing", name="", profile_id="missing"), 404, EVENT_NOT_FOUND)
    # Then the fields, the profile id's format included.
    _assert_refused(
        _put(created["id"], name="", profile_id="missing"), 400, "Campo obrigatório: Nome"
    )
    _assert_refused(_put(created["id"], profile_id=7), 400, "Perfil: valor inválido")
    _assert_refused(
        _put(created["id"], exam_date="2027-04-10", profile_id="missing"),
        400,
        "A data do evento não pode ser alterada",
    )
    # Then the profile (404, 409), before the lock of an event with exams.
    _assert_refused(_put(created["id"], profile_id="missing"), 404, PROFILE_NOT_FOUND)
    _assert_refused(_put(created["id"], profile_id=copying), 409, PROFILE_COPYING)
    assert dynamodb_snapshot() == snapshot


# --- PUT /events/{id} with exams --------------------------------------------


def test_rn016_profile_cannot_change_once_the_event_has_exams(seeded: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create()
    _confirm_attendance(created["id"])
    snapshot = dynamodb_snapshot()

    response = _put(created["id"], name="Exame abril/2027", status="CLOSED", profile_id=profile_id)

    _assert_refused(response, 409, PROFILE_LOCKED)
    # Nothing of the request is written: neither the profile nor the name or status.
    assert dynamodb_snapshot() == snapshot
    stored = event_repo.get_event(created["id"])
    assert (stored.profile_id, stored.name, stored.status) == (
        MAIN_PROFILE_ID,
        created["name"],
        EventStatus.OPEN,
    )


def test_rn016_profile_cannot_go_back_to_main_once_the_event_has_exams(seeded: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id)
    _confirm_attendance(created["id"])
    snapshot = dynamodb_snapshot()

    _assert_refused(_put(created["id"], name="Novo", profile_id="main"), 409, PROFILE_LOCKED)
    assert dynamodb_snapshot() == snapshot
    assert event_repo.get_event(created["id"]).profile_id == profile_id


def test_rn016_exam_without_counter_still_blocks_the_change(aws: None) -> None:
    # An exam written without the attendance transaction (no exam_count on the
    # event): the read of the exams answers, as in the delete.
    profile_id = _store_profile("Perfil do Sensei")
    created = _create()
    boto3.resource("dynamodb").Table(os.environ["EXAMS_TABLE"]).put_item(
        Item={"event_id": created["id"], "student_id": "student-1"}
    )

    _assert_refused(_put(created["id"], profile_id=profile_id), 409, PROFILE_LOCKED)
    assert event_repo.get_event(created["id"]).profile_id == MAIN_PROFILE_ID


def test_rn016_same_profile_resent_is_accepted_with_exams(seeded: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id)
    _confirm_attendance(created["id"])

    response = _put(
        created["id"], name="Exame abril/2027", status="CLOSED", profile_id=f" {profile_id} "
    )

    assert response["statusCode"] == 200, response["body"]
    body = response_json(response)
    assert (body["name"], body["status"], body["profile_id"]) == (
        "Exame abril/2027",
        "CLOSED",
        profile_id,
    )
    stored = _stored(created["id"])
    assert (stored["name"], stored["status"], stored["profile_id"]) == (
        "Exame abril/2027",
        "CLOSED",
        profile_id,
    )
    # The counter kept by the attendance survives the edit.
    assert stored[EXAM_COUNT] == 1


def test_rn016_same_profile_resent_is_not_checked_again(seeded: None) -> None:
    # The form resends the event's own profile: accepted without looking the
    # profile up, so an edit of the name never depends on the profile's status.
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id)
    _set_status(profile_id, "COPYING")

    response = _put(created["id"], name="Novo nome", profile_id=profile_id)

    assert response["statusCode"] == 200, response["body"]
    assert event_repo.get_event(created["id"]).name == "Novo nome"


def test_rn016_events_of_other_events_exams_do_not_lock_the_profile(seeded: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    with_exam = _create(name="Com exame")
    without_exam = _create(name="Sem exame", exam_date="2027-06-12")
    _confirm_attendance(with_exam["id"])

    response = _put(without_exam["id"], exam_date="2027-06-12", profile_id=profile_id)

    assert response["statusCode"] == 200, response["body"]
    assert event_repo.get_event(without_exam["id"]).profile_id == profile_id
    assert event_repo.get_event(with_exam["id"]).profile_id == MAIN_PROFILE_ID


# --- race: attendance x change of profile -----------------------------------


@pytest.mark.parametrize("to_main", [False, True], ids=["to-stored-profile", "to-main"])
def test_rn016_attendance_between_read_and_write_blocks_the_change(
    seeded: None, monkeypatch: pytest.MonkeyPatch, to_main: bool
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id if to_main else None)
    before = event_repo.get_event(created["id"])
    original = event_repo.change_event_profile
    raced: list[str] = []

    def change_after_concurrent_attendance(event: ExamEvent) -> None:
        # The handler already read the event and found no exams.
        _confirm_attendance(created["id"])
        raced.append(event.profile_id)
        original(event)

    monkeypatch.setattr(event_repo, "change_event_profile", change_after_concurrent_attendance)

    response = _put(
        created["id"], name="Exame abril/2027", profile_id="main" if to_main else profile_id
    )

    assert raced == [MAIN_PROFILE_ID if to_main else profile_id]
    assert exam_repo.list_by_event(created["id"]), "the concurrent exam exists"
    _assert_refused(response, 409, PROFILE_LOCKED)
    after = event_repo.get_event(created["id"])
    assert after == before  # neither the profile nor the name was written
    assert _stored(created["id"])[EXAM_COUNT] == 1


def test_rn016_change_then_attendance_uses_the_new_profile(seeded: None) -> None:
    # The other order of the same race: the change wins, the attendance follows.
    profile_id = _store_profile("Perfil do Sensei")
    created = _create()

    assert _put(created["id"], profile_id=profile_id)["statusCode"] == 200
    _confirm_attendance(created["id"])

    stored = _stored(created["id"])
    assert (stored["profile_id"], stored[EXAM_COUNT]) == (profile_id, 1)


def test_rn016_event_deleted_between_read_and_write_is_404(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    for target in (profile_id, "main"):
        created = _create(profile_id=None if target == profile_id else profile_id)
        original = event_repo.change_event_profile

        def change_after_delete(
            event: ExamEvent, original: Any = original, event_id: str = created["id"]
        ) -> None:
            event_repo.delete_event(event_id)
            original(event)

        monkeypatch.setattr(event_repo, "change_event_profile", change_after_delete)

        _assert_refused(_put(created["id"], profile_id=target), 404, EVENT_NOT_FOUND)
        # The write did not bring the deleted event back.
        assert event_repo.get_event(created["id"]) is None
        monkeypatch.setattr(event_repo, "change_event_profile", original)


def test_rn016_slow_edit_does_not_undo_a_change_of_profile(aws: None) -> None:
    # An edit of the name that read the event before a concurrent change of
    # profile must not write the old profile back (the profile it read might
    # even have been deleted by then).
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id)
    read_before = event_repo.get_event(created["id"])
    assert _put(created["id"], profile_id="main")["statusCode"] == 200

    event_repo.save_event(replace(read_before, name="Nome novo", updated_at=NOW))

    stored = event_repo.get_event(created["id"])
    assert (stored.name, stored.profile_id) == ("Nome novo", MAIN_PROFILE_ID)


# --- race: profile x event (the condition in the transaction) ----------------


def _racing_transact(monkeypatch: pytest.MonkeyPatch, before_write: Any) -> list[int]:
    """Run ``before_write`` right before the event's transaction is sent (once)."""
    original = event_repo._transact
    calls: list[int] = []

    def transact(items: list[dict[str, Any]]) -> None:
        if not calls:
            before_write()
        calls.append(len(items))
        original(items)

    monkeypatch.setattr(event_repo, "_transact", transact)
    return calls


def test_rn016_event_with_a_stored_profile_is_written_with_the_profile_check(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    sent: list[list[dict[str, Any]]] = []
    original = event_repo._transact

    def record(items: list[dict[str, Any]]) -> None:
        sent.append(items)
        original(items)

    monkeypatch.setattr(event_repo, "_transact", record)

    created = _create(profile_id=profile_id)
    other = _create(name="Outro", exam_date="2027-06-12")
    assert _put(other["id"], exam_date="2027-06-12", profile_id=profile_id)["statusCode"] == 200
    # Main profile (not stored): single-item writes, no transaction.
    assert _put(other["id"], exam_date="2027-06-12", profile_id="main")["statusCode"] == 200
    assert _put(created["id"], name="Só o nome")["statusCode"] == 200

    assert [[next(iter(item)) for item in items] for items in sent] == [
        ["Put", "ConditionCheck"],
        ["Update", "ConditionCheck"],
    ]
    for items in sent:
        check = items[1]["ConditionCheck"]
        assert check["TableName"] == os.environ["SETTINGS_TABLE"]
        assert check["Key"] == {"id": "requirement_profiles"}
        assert check["ConditionExpression"] == "#profiles.#id.#status = :ready"
        assert check["ExpressionAttributeNames"] == {
            "#profiles": "profiles",
            "#id": profile_id,
            "#status": "status",
        }
        assert check["ExpressionAttributeValues"] == {":ready": "READY"}
    update = sent[1][0]["Update"]
    assert update["ConditionExpression"] == (
        "attribute_exists(id) AND (attribute_not_exists(exam_count) OR exam_count = :zero)"
    )


LEAVE_READY = pytest.mark.parametrize(
    ("leave_ready", "status", "message"),
    [
        (_remove_profile, 404, PROFILE_NOT_FOUND),
        (lambda profile_id: _set_status(profile_id, "COPYING"), 409, PROFILE_COPYING),
    ],
    ids=["removed", "copying"],
)


@LEAVE_READY
def test_rn016_profile_leaving_ready_before_the_write_refuses_the_new_event(
    aws: None, monkeypatch: pytest.MonkeyPatch, leave_ready: Any, status: int, message: str
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    calls = _racing_transact(monkeypatch, lambda: leave_ready(profile_id))

    # The handler read the profile READY; the condition in the write decides.
    _assert_refused(_post(profile_id=profile_id), status, message)

    assert calls == [2]
    assert event_repo.list_all() == []


def test_rn016_profile_in_any_status_but_ready_refuses_the_new_event(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Step 3b-2 will mark a profile being deleted with a status of its own:
    # whatever it is, the event is not written once the status is not READY.
    profile_id = _store_profile("Perfil do Sensei")
    calls = _racing_transact(monkeypatch, lambda: _set_status(profile_id, "DELETING"))
    event = ExamEvent("event-1", "Exame", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW, profile_id)

    # This code does not know the status yet, so reading it back to choose the
    # message fails; the transaction had already refused the event.
    with pytest.raises(ValueError, match="DELETING"):
        event_repo.create_event(event)

    assert calls == [2]
    assert event_repo.list_all() == []


@LEAVE_READY
def test_rn016_profile_leaving_ready_before_the_write_refuses_the_change(
    aws: None, monkeypatch: pytest.MonkeyPatch, leave_ready: Any, status: int, message: str
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create()
    before = event_repo.get_event(created["id"])
    calls = _racing_transact(monkeypatch, lambda: leave_ready(profile_id))

    _assert_refused(_put(created["id"], name="Novo", profile_id=profile_id), status, message)

    assert calls == [2]
    assert event_repo.get_event(created["id"]) == before


def test_rn016_repository_refuses_a_missing_profile_by_the_condition_alone(aws: None) -> None:
    # No handler, no earlier read: only the ConditionCheck of the transaction.
    event = ExamEvent("event-1", "Exame", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW, "gone")

    with pytest.raises(NotFoundError) as not_stored:
        event_repo.create_event(event)
    assert not_stored.value.message == PROFILE_NOT_FOUND
    assert event_repo.list_all() == []

    copying = _store_profile("Perfil em cópia", ready=False)
    with pytest.raises(ConflictError) as not_ready:
        event_repo.create_event(replace(event, profile_id=copying))
    assert not_ready.value.message == PROFILE_COPYING
    assert event_repo.list_all() == []

    main_event = replace(event, profile_id=MAIN_PROFILE_ID)
    event_repo.create_event(main_event)
    with pytest.raises(NotFoundError) as change_missing:
        event_repo.change_event_profile(replace(main_event, name="Novo", profile_id="gone"))
    assert change_missing.value.message == PROFILE_NOT_FOUND
    with pytest.raises(ConflictError) as change_copying:
        event_repo.change_event_profile(replace(main_event, name="Novo", profile_id=copying))
    assert change_copying.value.message == PROFILE_COPYING
    assert event_repo.get_event("event-1") == main_event


def test_rn016_both_conditions_failing_answer_in_the_documented_order(seeded: None) -> None:
    ready = _store_profile("Perfil pronto")
    event = ExamEvent("event-1", "Exame", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW)

    # Event deleted and profile missing: the event's 404 first.
    with pytest.raises(NotFoundError) as deleted:
        event_repo.change_event_profile(replace(event, profile_id="gone"))
    assert deleted.value.message == EVENT_NOT_FOUND

    # Event with exams and profile missing: the profile's 404 before the lock.
    event_repo.create_event(event)
    _confirm_attendance(event.id)
    with pytest.raises(NotFoundError) as missing:
        event_repo.change_event_profile(replace(event, profile_id="gone"))
    assert missing.value.message == PROFILE_NOT_FOUND

    # Event with exams and a ready profile: the lock.
    with pytest.raises(ConflictError) as locked:
        event_repo.change_event_profile(replace(event, profile_id=ready))
    assert locked.value.message == PROFILE_LOCKED
    assert event_repo.get_event(event.id).profile_id == MAIN_PROFILE_ID


# --- capacity and conflicts in the transaction --------------------------------


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
def test_rn016_throttled_event_transaction_is_503(
    aws: None, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create()
    snapshot = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, "TransactWriteItems", "EVENTS_TABLE", code=code)

    post = _post(profile_id=profile_id)
    put = _put(created["id"], name="Novo", profile_id=profile_id)

    assert_service_busy(post, stub)
    assert_service_busy(put, stub)
    # Botocore already retried each request: no extra round here.
    assert len(stub.calls) == 2
    stub.active = False
    assert dynamodb_snapshot() == snapshot


@pytest.mark.parametrize("code", DYNAMODB_THROTTLING_CODES)
def test_rn016_throttled_change_to_main_is_503(
    aws: None, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id)
    snapshot = dynamodb_snapshot()
    stub = throttle_dynamodb(monkeypatch, "UpdateItem", "EVENTS_TABLE", code=code)

    assert_service_busy(_put(created["id"], name="Novo", profile_id="main"), stub)
    stub.active = False
    assert dynamodb_snapshot() == snapshot


@pytest.mark.parametrize("reason", ["ThrottlingError", "ProvisionedThroughputExceeded"])
def test_rn016_throttled_item_in_event_transaction_is_retried_then_503(
    aws: None, monkeypatch: pytest.MonkeyPatch, no_sleep: None, reason: str
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    stub = throttle_dynamodb(
        monkeypatch, "TransactWriteItems", "EVENTS_TABLE", cancellation_reason=reason
    )

    assert_service_busy(_post(profile_id=profile_id), stub)
    assert len(stub.calls) == event_repo._MAX_ATTEMPTS
    stub.active = False
    assert event_repo.list_all() == []


def test_rn016_persistent_conflict_in_event_transaction_is_409_try_again(
    aws: None, monkeypatch: pytest.MonkeyPatch, no_sleep: None
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    calls: list[int] = []

    def always(items: list[dict[str, Any]]) -> None:
        calls.append(1)
        raise _cancelled("None", "TransactionConflict")

    monkeypatch.setattr(event_repo, "_transact", always)

    _assert_refused(_post(profile_id=profile_id), 409, TRY_AGAIN)
    assert len(calls) == event_repo._MAX_ATTEMPTS
    assert event_repo.list_all() == []


def test_rn016_conflict_in_event_transaction_passes_on_retry(
    aws: None, monkeypatch: pytest.MonkeyPatch, no_sleep: None
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    original = event_repo._transact
    calls: list[int] = []

    def once(items: list[dict[str, Any]]) -> None:
        calls.append(1)
        if len(calls) == 1:
            raise _cancelled("TransactionConflict", "None")
        original(items)

    monkeypatch.setattr(event_repo, "_transact", once)

    created = _create(profile_id=profile_id)

    assert len(calls) == 2
    assert event_repo.get_event(created["id"]).profile_id == profile_id


def test_rn016_unknown_cancellation_of_event_transaction_is_not_hidden(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    event = ExamEvent("event-1", "Exame", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW, profile_id)

    def refused(items: list[dict[str, Any]]) -> None:
        raise _cancelled("ValidationError", "None")

    monkeypatch.setattr(event_repo, "_transact", refused)

    with pytest.raises(ClientError):
        event_repo.create_event(event)


def test_rn016_throttled_profile_reread_after_refused_event_is_503(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    stub = throttle_dynamodb(monkeypatch, "GetItem", "SETTINGS_TABLE", active=False)

    def profile_removed_then_reads_throttled() -> None:
        _remove_profile(profile_id)
        stub.active = True

    triggered = before_dynamodb_call(
        monkeypatch, "TransactWriteItems", "EVENTS_TABLE", profile_removed_then_reads_throttled
    )

    response = _post(profile_id=profile_id)

    assert triggered, "the transaction was sent"
    assert_service_busy(response, stub)
    stub.active = False
    assert event_repo.list_all() == []


@pytest.mark.parametrize("to_main", [False, True], ids=["to-stored-profile", "to-main"])
def test_rn016_throttled_event_reread_after_refused_change_is_503(
    seeded: None, monkeypatch: pytest.MonkeyPatch, to_main: bool
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id if to_main else None)
    before = event_repo.get_event(created["id"])
    stub = throttle_dynamodb(monkeypatch, "GetItem", "EVENTS_TABLE", active=False)
    original = event_repo.change_event_profile

    def change_after_attendance(event: ExamEvent) -> None:
        _confirm_attendance(created["id"])
        stub.active = True
        original(event)

    monkeypatch.setattr(event_repo, "change_event_profile", change_after_attendance)

    response = _put(created["id"], name="Novo", profile_id="main" if to_main else profile_id)

    assert_service_busy(response, stub)
    stub.active = False
    assert event_repo.get_event(created["id"]) == before
