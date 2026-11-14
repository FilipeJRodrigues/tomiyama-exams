"""Exclusão de perfil confirmada com a leitura de eventos de uma marca já desfeita.

Erro observado: ``confirm_deletion`` só exige "``DELETING`` sem ``delete_checked``";
não exige que a marca seja a mesma sob a qual o pedido leu os eventos. Com três
``DELETE`` do mesmo perfil ao mesmo tempo:

1. o pedido A marca o perfil e lê os eventos (um evento usa o perfil);
2. o evento sai do perfil; o pedido B encontra a marca de A (ainda não
   confirmada), lê os eventos, não acha nenhum e fica para trás;
3. A desfaz a marca (409, o perfil volta a ``READY``);
4. um evento novo escolhe o perfil (permitido: está ``READY``);
5. o pedido C marca o perfil de novo;
6. B, com a leitura do passo 2, confirma a marca de C e dispara a exclusão.

O perfil fica ``DELETING`` confirmado (nunca mais cancelado) com um evento que o
usa; a função assíncrona apaga os itens e remove o perfil, e o evento passa a
apontar para um perfil que não existe.

Esperado: a confirmação só vale para a marca sob a qual os eventos foram lidos
(por exemplo, condicionada ao ``delete_updated_at`` ou à ``version`` da marca).
B não confirma; C acha o evento, desfaz a marca e responde 409; o perfil
continua ``READY``, com todos os itens, e nenhuma exclusão é disparada
(decisão 5 do #144: "perfil só pode ser excluído se nenhum evento o usar").
Issue: #144
"""

import threading
from typing import Any

import pytest
from conftest import EXAMINER, CopyInvocations, api_event, belt_id, response_json

from domain.requirements import Requirement, RequirementKind
from handlers import events as event_handlers
from handlers import requirement_profile_copy as copy_worker
from handlers import requirement_profile_delete as delete_worker
from handlers import requirement_profiles as handlers
from repository import events as event_repo
from repository import requirement_profiles as profile_repo
from repository import requirements as requirement_repo
from repository import tables
from repository.tables import REQUIREMENTS_TABLE_ENV

DELETE_FUNCTION = "test-delete-requirement-profile"
IN_USE_MESSAGE = "O perfil é usado por um evento e não pode ser excluído"
WAIT_SECONDS = 30


def _delete(profile_id: str) -> dict[str, Any]:
    return handlers.delete_profile(api_event(EXAMINER, path={"id": profile_id}), None)


def _profile_items(profile_id: str) -> list[str]:
    items = tables.paginate(tables.table(REQUIREMENTS_TABLE_ENV).scan, ConsistentRead=True)
    return sorted(item["id"] for item in items if item.get("profile_id") == profile_id)


def test_rn017_deletion_is_not_confirmed_with_the_events_read_under_an_undone_mark(
    seeded: list, copy_invocations: CopyInvocations, monkeypatch: pytest.MonkeyPatch
) -> None:
    cinza = belt_id("Cinza")
    for number in (1, 2):
        requirement_repo.create_requirement(
            Requirement(
                f"m-{number}", cinza, RequirementKind.THEORY, "Vocabulário", "Rei", "x", number
            )
        )
    created = handlers.create_profile(api_event(EXAMINER, body={"name": "Perfil do Sensei"}), None)
    assert created["statusCode"] == 202, created["body"]
    profile_id = response_json(created)["id"]
    copied = copy_worker.copy_profile(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert copied["outcome"] == "READY"
    items = _profile_items(profile_id)
    assert len(items) == 2

    def event_body(name: str, **more: Any) -> dict[str, Any]:
        return {"name": name, "exam_date": "2027-03-20", **more}

    first = event_handlers.create_event(
        api_event(EXAMINER, body=event_body("Primeiro", profile_id=profile_id)), None
    )
    assert first["statusCode"] == 201, first["body"]
    first_id = response_json(first)["id"]

    real_read = event_repo.any_event_uses_profile
    main_thread = threading.current_thread()
    b_read_the_events = threading.Event()
    b_may_go_on = threading.Event()
    answers: dict[str, Any] = {}
    main_reads: list[bool] = []
    request_b = threading.Thread(target=lambda: answers.update(b=_delete(profile_id)), daemon=True)

    def read_events(asked_id: str) -> bool:
        if threading.current_thread() is not main_thread:
            # Request B: reads the events (none uses the profile) and falls behind.
            found = real_read(asked_id)
            answers["b_found"] = found
            b_read_the_events.set()
            assert b_may_go_on.wait(WAIT_SECONDS)
            return found
        if not main_reads:
            # Request A: finds the first event; then the event leaves the
            # profile and B, which meets A's unconfirmed mark, reads the events.
            found = real_read(asked_id)
            main_reads.append(found)
            left = event_handlers.update_event(
                api_event(
                    EXAMINER,
                    path={"id": first_id},
                    body=event_body("Primeiro", profile_id="main"),
                ),
                None,
            )
            assert left["statusCode"] == 200, left["body"]
            request_b.start()
            assert b_read_the_events.wait(WAIT_SECONDS)
            return found
        # Request C, after its own mark: B wakes up and confirms; then C reads.
        b_may_go_on.set()
        request_b.join(WAIT_SECONDS)
        found = real_read(asked_id)
        main_reads.append(found)
        return found

    monkeypatch.setattr(event_repo, "any_event_uses_profile", read_events)

    # A: marked, found the first event, undid the mark.
    answer_a = _delete(profile_id)
    assert (answer_a["statusCode"], response_json(answer_a)["message"]) == (409, IN_USE_MESSAGE)
    assert answers["b_found"] is False
    stored = profile_repo.get_profile(profile_id)
    assert stored is not None and stored.status.value == "READY"

    # The profile is READY again: a new event may choose it.
    second = event_handlers.create_event(
        api_event(EXAMINER, body=event_body("Segundo", profile_id=profile_id)), None
    )
    assert second["statusCode"] == 201, second["body"]

    # C marks it again; B, still holding its old read, tries to confirm.
    answer_c = _delete(profile_id)
    assert not request_b.is_alive()
    assert main_reads == [True, True]
    monkeypatch.setattr(event_repo, "any_event_uses_profile", real_read)

    # An event uses the profile: no deletion is confirmed nor started.
    assert real_read(profile_id)
    stored = profile_repo.get_profile(profile_id)
    assert stored is not None
    assert not stored.delete_checked, "exclusão confirmada com um evento usando o perfil"
    started = [call for call in copy_invocations.calls if call["FunctionName"] == DELETE_FUNCTION]
    assert started == []
    assert (answer_c["statusCode"], response_json(answer_c)["message"]) == (409, IN_USE_MESSAGE)
    assert stored.status.value == "READY"
    # And the background function, whoever invokes it, deletes nothing.
    outcome = delete_worker.delete_profile_items(
        profile_id, items_per_second=1_000_000, sleep=lambda _seconds: None
    )
    assert outcome["outcome"] != "DELETED"
    assert _profile_items(profile_id) == items
