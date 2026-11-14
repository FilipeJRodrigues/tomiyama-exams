"""QA coverage of "the event chooses its requirement profile" (RN006, RN016; #144, step 3b-1).

Cases the step's own tests left out:

- ids that look like pieces of an expression (``#``, ``.``, ``:``) reach the
  ``ConditionCheck`` only as attribute names: 404, never a 500 nor a write;
- spaces around the id are trimmed, on creation and on edit;
- an event stored with a blank ``profile_id`` is an event of the main profile;
- an event whose profile disappeared can still be renamed and moved away;
- combinations of cancellation reasons of the event transaction;
- the sheet of two events (main and another profile) once the v2 marker is
  written and both profiles are read from ``by_profile_belt``.
"""

import os
import uuid
from dataclasses import replace
from datetime import date
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from conftest import EXAMINER, api_event, belt_id, dynamodb_snapshot, make_student, response_json

from domain import requirement_profiles as profile_rules
from domain.errors import ConflictError, NotFoundError, ServiceUnavailableError
from domain.events import EventStatus, ExamEvent
from domain.requirement_profiles import MAIN_PROFILE_ID
from domain.requirements import seed_requirements
from handlers import events as handlers
from handlers import exams as exam_handlers
from repository import events as event_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
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
TRY_AGAIN = "Outra alteração está em andamento. Tente de novo."
ODD_IDS = ["a#b", "a.b", "profiles.x.status", ":ready", "#id", "status", "a b", "çã/é", "0"]
TARGET = "Cinza/Azul"  # target belt of the default student (Cinza)


def _store_profile(name: str, *, ready: bool = True) -> str:
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
    _settings_table().update_item(
        Key={"id": profile_repo.REQUIREMENT_PROFILES_ID},
        UpdateExpression="REMOVE #profiles.#id",
        ExpressionAttributeNames={"#profiles": "profiles", "#id": profile_id},
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
    if student_repo.get_student(student_id) is None:
        student_repo.create_student(replace(make_student(), id=student_id))
    response = exam_handlers.confirm_attendance(
        api_event(EXAMINER, path={"id": event_id}, body={"student_id": student_id}), None
    )
    assert response["statusCode"] == 201, response["body"]


def _cancelled(reasons: list[dict[str, Any]] | None) -> ClientError:
    response: dict[str, Any] = {"Error": {"Code": "TransactionCanceledException", "Message": "x"}}
    if reasons is not None:
        response["CancellationReasons"] = reasons
    return ClientError(response, "TransactWriteItems")  # type: ignore[arg-type]


def _always(monkeypatch: pytest.MonkeyPatch, error: ClientError) -> list[int]:
    calls: list[int] = []

    def transact(_items: list[dict[str, Any]]) -> None:
        calls.append(1)
        raise error

    monkeypatch.setattr(event_repo, "_transact", transact)
    monkeypatch.setattr(event_repo.time, "sleep", lambda _seconds: None)
    return calls


def _event(profile_id: str = MAIN_PROFILE_ID, event_id: str = "event-1") -> ExamEvent:
    return ExamEvent(event_id, "Exame", date(2027, 3, 20), EventStatus.OPEN, NOW, NOW, profile_id)


# --- odd ids ---------------------------------------------------------------------


@pytest.mark.parametrize("profile_id", ODD_IDS)
def test_rn016_odd_profile_id_is_404_on_create_and_edit(aws: None, profile_id: str) -> None:
    _store_profile("Perfil do Sensei")
    created = _create()
    snapshot = dynamodb_snapshot()

    _assert_refused(_post(profile_id=profile_id), 404, PROFILE_NOT_FOUND)
    _assert_refused(_put(created["id"], profile_id=profile_id), 404, PROFILE_NOT_FOUND)
    assert dynamodb_snapshot() == snapshot


@pytest.mark.parametrize("profile_id", ODD_IDS)
def test_rn016_odd_profile_id_is_only_a_name_in_the_condition(aws: None, profile_id: str) -> None:
    """The write's own condition (no early check) takes the id as an attribute name."""
    ready = _store_profile("Perfil do Sensei")
    event_repo.create_event(_event())
    snapshot = dynamodb_snapshot()

    with pytest.raises(NotFoundError) as created:
        event_repo.create_event(_event(profile_id, "event-2"))
    with pytest.raises(NotFoundError) as changed:
        event_repo.change_event_profile(_event(profile_id))

    assert created.value.message == changed.value.message == PROFILE_NOT_FOUND
    assert dynamodb_snapshot() == snapshot
    # The stored profile is still usable: the odd id did not touch the item.
    event_repo.change_event_profile(_event(ready))
    assert event_repo.get_event("event-1").profile_id == ready


def test_rn016_profile_id_is_trimmed(aws: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")

    assert _create(profile_id=f"  {profile_id}\t")["profile_id"] == profile_id
    created = _create(profile_id=" main ")
    assert created["profile_id"] == MAIN_PROFILE_ID

    changed = _put(created["id"], profile_id=f"\n{profile_id} ")
    assert changed["statusCode"] == 200, changed["body"]
    assert _stored(created["id"])["profile_id"] == profile_id
    back = _put(created["id"], profile_id=" main ")
    assert back["statusCode"] == 200, back["body"]
    assert _stored(created["id"])["profile_id"] == MAIN_PROFILE_ID


def test_rn016_profile_id_of_65_characters_is_400_on_edit(aws: None) -> None:
    created = _create()
    snapshot = dynamodb_snapshot()

    _assert_refused(
        _put(created["id"], profile_id="x" * 65), 400, "Perfil: máximo de 64 caracteres"
    )
    _assert_refused(_put(created["id"], profile_id=["main"]), 400, "Perfil: valor inválido")
    _assert_refused(_put(created["id"], profile_id="x" * 64), 404, PROFILE_NOT_FOUND)
    assert dynamodb_snapshot() == snapshot


# --- stored events ---------------------------------------------------------------


def test_rn016_event_stored_with_blank_profile_is_of_the_main_profile(seeded: None) -> None:
    other = _store_profile("Perfil do Sensei")
    _events_table().put_item(
        Item={
            "id": "blank-event",
            "name": "Exame antigo",
            "exam_date": "2027-03-20",
            "status": "OPEN",
            "created_at": NOW,
            "updated_at": NOW,
            "profile_id": "",
        }
    )

    assert event_repo.get_event("blank-event").profile_id == MAIN_PROFILE_ID
    assert event_repo.get_events(["blank-event"])["blank-event"].profile_id == MAIN_PROFILE_ID
    assert [item.profile_id for item in event_repo.list_all()] == [MAIN_PROFILE_ID]

    # Renaming it (with or without "main" in the body) is not a change of profile.
    for body in ({}, {"profile_id": "main"}, {"profile_id": None}, {"profile_id": "  "}):
        renamed = _put("blank-event", name="Exame de março", **body)
        assert renamed["statusCode"] == 200, renamed["body"]
        assert response_json(renamed)["profile_id"] == MAIN_PROFILE_ID
    assert _stored("blank-event")["name"] == "Exame de março"

    # With an exam, it keeps the main profile like any other event.
    _confirm_attendance("blank-event")
    _assert_refused(_put("blank-event", profile_id=other), 409, PROFILE_LOCKED)
    assert _put("blank-event", profile_id="main")["statusCode"] == 200
    assert _stored("blank-event")[EXAM_COUNT] == 1


def test_rn016_edit_without_a_change_of_profile_keeps_profile_and_counter(seeded: None) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    created = _create(profile_id=profile_id)
    _confirm_attendance(created["id"])

    closed = _put(created["id"], name="Exame fechado", status="CLOSED")

    assert closed["statusCode"] == 200, closed["body"]
    assert response_json(closed)["profile_id"] == profile_id
    stored = _stored(created["id"])
    assert (stored["name"], stored["status"], stored["profile_id"], stored[EXAM_COUNT]) == (
        "Exame fechado",
        "CLOSED",
        profile_id,
        1,
    )


def test_rn016_event_of_a_profile_that_disappeared_can_be_renamed_and_moved(aws: None) -> None:
    gone = _store_profile("Perfil apagado")
    other = _store_profile("Outro perfil")
    created = _create(profile_id=gone)
    _remove_profile(gone)

    # Same profile resent: not checked again, the name is written.
    renamed = _put(created["id"], name="Exame renomeado", profile_id=gone)
    assert renamed["statusCode"] == 200, renamed["body"]
    assert _stored(created["id"])["profile_id"] == gone

    # Without exams it may leave the missing profile, to a stored one or to main.
    assert _put(created["id"], profile_id=other)["statusCode"] == 200
    assert _stored(created["id"])["profile_id"] == other
    # ... but never go back to it.
    _assert_refused(_put(created["id"], profile_id=gone), 404, PROFILE_NOT_FOUND)
    assert _put(created["id"], profile_id="main")["statusCode"] == 200
    assert _stored(created["id"])["profile_id"] == MAIN_PROFILE_ID


def test_rn016_change_between_two_stored_profiles_checks_the_new_one(aws: None) -> None:
    first = _store_profile("Primeiro")
    copying = _store_profile("Em cópia", ready=False)
    created = _create(profile_id=first)
    snapshot = dynamodb_snapshot()

    _assert_refused(
        _put(created["id"], name="Outro nome", profile_id=copying), 409, PROFILE_COPYING
    )
    assert dynamodb_snapshot() == snapshot

    # The repository alone (no early check) refuses it too, by the condition.
    with pytest.raises(ConflictError) as refused:
        event_repo.change_event_profile(
            replace(event_repo.get_event(created["id"]), profile_id=copying)
        )
    assert refused.value.message == PROFILE_COPYING
    assert dynamodb_snapshot() == snapshot


# --- cancellation reasons ----------------------------------------------------------


def test_rn016_cancellation_without_reasons_is_not_hidden(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = _store_profile("Perfil do Sensei")
    for reasons in (None, [], [{}, {}], [{"Code": None}, {"Message": "x"}]):
        calls = _always(monkeypatch, _cancelled(reasons))
        with pytest.raises(ClientError):
            event_repo.create_event(_event(profile_id))
        assert calls == [1]  # not retried: nothing says it is transient


def test_rn016_failed_profile_check_is_never_retried_whatever_the_other_reason(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    copying = _store_profile("Em cópia", ready=False)
    for first in ("None", "TransactionConflict", "ThrottlingError"):
        calls = _always(
            monkeypatch, _cancelled([{"Code": first}, {"Code": "ConditionalCheckFailed"}])
        )
        with pytest.raises(ConflictError) as refused:
            event_repo.create_event(_event(copying))
        assert refused.value.message == PROFILE_COPYING
        assert calls == [1]


def test_rn016_profile_ready_again_at_the_reread_asks_to_try_again(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready = _store_profile("Perfil do Sensei")
    calls = _always(monkeypatch, _cancelled([{"Code": "None"}, {"Code": "ConditionalCheckFailed"}]))

    with pytest.raises(ConflictError) as refused:
        event_repo.create_event(_event(ready))

    assert refused.value.message == TRY_AGAIN
    assert calls == [1]
    assert event_repo.list_all() == []


def test_rn016_throttled_item_wins_over_conflict_after_the_retries(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready = _store_profile("Perfil do Sensei")
    event_repo.create_event(_event())
    calls = _always(
        monkeypatch,
        _cancelled([{"Code": "TransactionConflict"}, {"Code": "ProvisionedThroughputExceeded"}]),
    )

    with pytest.raises(ServiceUnavailableError):
        event_repo.change_event_profile(_event(ready))

    assert len(calls) == 4
    assert event_repo.get_event("event-1").profile_id == MAIN_PROFILE_ID


def test_rn016_repeated_event_id_in_the_transaction_is_not_taken_for_a_profile_error(
    aws: None,
) -> None:
    """A new event whose id exists (UUID collision) writes nothing and is not a 404/409."""
    ready = _store_profile("Perfil do Sensei")
    event_repo.create_event(_event())
    snapshot = dynamodb_snapshot()

    with pytest.raises(ClientError) as collided:
        event_repo.create_event(_event(ready))

    assert collided.value.response["Error"]["Code"] == "TransactionCanceledException"
    assert dynamodb_snapshot() == snapshot


# --- the sheet once the v2 migration finished -----------------------------------------


def test_rn006_sheets_of_two_profiles_after_the_v2_marker(seeded: None) -> None:
    """With the marker, the main profile also comes from ``by_profile_belt``: still no mixing."""
    target = belt_id(TARGET)
    main_items = [item for item in seed_requirements() if item.belt_id == target]
    for item in main_items:
        requirement_repo.create_requirement(item)
    other = _store_profile("Perfil do Sensei")
    own = replace(main_items[0], id="own-item", profile_id=other, description="Só do perfil")
    requirement_repo.create_requirement(own)
    _settings_table().put_item(Item={"id": requirement_repo.PROFILE_BELT_MIGRATION_MARKER_ID})
    requirement_repo.reset_cache()
    assert requirement_repo.profile_index_complete()

    sheets = {}
    for student_id, profile_id in (("student-1", None), ("student-2", other)):
        event_id = _create(name=f"Exame {student_id}", profile_id=profile_id)["id"]
        _confirm_attendance(event_id, student_id)
        path = {"id": event_id, "student_id": student_id}
        response = exam_handlers.get_exam_sheet(api_event(EXAMINER, path=path), None)
        assert response["statusCode"] == 200, response["body"]
        sheets[student_id] = response_json(response)
        # An item of the other event's profile is refused.
        foreign = own.id if profile_id is None else main_items[0].id
        marked = exam_handlers.mark_answer(
            api_event(EXAMINER, path={**path, "requirement_id": foreign}, body={"correct": True}),
            None,
        )
        _assert_refused(marked, 400, "Item não pertence ao perfil de requisitos do exame")

    assert sorted(item["id"] for item in sheets["student-1"]["items"]) == sorted(
        item.id for item in main_items
    )
    assert [item["id"] for item in sheets["student-2"]["items"]] == [own.id]
    assert sheets["student-2"]["event"]["profile_id"] == other
    assert sheets["student-1"]["event"]["profile_id"] == MAIN_PROFILE_ID
