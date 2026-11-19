"""O README confere e executa o change set da stack de CD sem esperar que ele fique pronto.

Erro observado (qa, 2026-11-19, na correção do papel de execução do #68): a correção só
chega à AWS com um update da stack tomiyama-cd-dev, pelo caminho da seção "Criar a stack
de CD" do backend/README.md ("siga o mesmo caminho com `--change-set-type UPDATE`"). O
bloco dessa seção roda, em sequência, create-change-set, describe-change-set,
execute-change-set e o waiter da stack. O create-change-set é assíncrono: "After the
CreateChangeSet call successfully completes, CloudFormation starts creating the change
set" (CreateChangeSet, API Reference). Colado como está, o describe-change-set roda com o
change set ainda em CREATE_PENDING ou CREATE_IN_PROGRESS, quando Changes ainda está
vazio: a tabela sai sem nenhuma linha, e o operador não vê o Modify do
CloudFormationExecutionRole que deveria conferir. Em seguida, o execute-change-set falha
com InvalidChangeSetStatus ("the change set status might be CREATE_IN_PROGRESS",
ExecuteChangeSet, API Reference) ou, se a criação já terminou, executa um change set que
ninguém viu. Um change set FAILED (sem mudanças, por exemplo) também passa calado, porque
a consulta só lista Changes, sem o Status nem o StatusReason.

Esperado: entre o create-change-set e o describe-change-set (e antes do
execute-change-set) de cada change set da stack de CD, o README espera com
`aws cloudformation wait change-set-create-complete --stack-name tomiyama-cd-dev
--change-set-name <o mesmo nome>`, que só termina com sucesso em CREATE_COMPLETE e falha
em FAILED.
Issue: #68
"""

import json
import re
import shlex
from pathlib import Path

import botocore

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
CD_STACK = "tomiyama-cd-dev"
WAITERS = (
    Path(botocore.__file__).parent / "data" / "cloudformation" / "2010-05-15" / "waiters-2.json"
)


def _acceptors(waiter: str) -> dict[str, str]:
    """Status -> state ("success", "failure", "retry") of a CloudFormation waiter."""
    model = json.loads(WAITERS.read_text(encoding="utf-8"))["waiters"][waiter]
    return {
        acceptor["expected"]: acceptor["state"]
        for acceptor in model["acceptors"]
        if acceptor.get("matcher") in ("path", "pathAll", "pathAny")
    }


def _section(markdown: str, title: str) -> str:
    start = markdown.index(f"\n### {title}\n")
    end = markdown.find("\n### ", start + 1)
    return markdown[start : end if end != -1 else len(markdown)]


def _cloudformation_commands(section: str) -> list[list[str]]:
    """The `aws cloudformation ...` commands of the section, in order, line breaks joined."""
    text = re.sub(r"\\\n\s*", " ", section)
    commands = []
    for line in text.splitlines():
        line = line.strip().strip("`").strip()
        if line.startswith("aws cloudformation "):
            commands.append(shlex.split(line))
    return commands


def _option(command: list[str], name: str) -> str | None:
    for index, token in enumerate(command):
        if token == name and index + 1 < len(command):
            return command[index + 1]
        if token.startswith(f"{name}="):
            return token.split("=", 1)[1]
    return None


def _is(command: list[str], *verb: str) -> bool:
    return command[2 : 2 + len(verb)] == list(verb)


def test_68_readme_waits_for_the_cd_change_set_before_describing_and_executing_it() -> None:
    waiter = _acceptors("ChangeSetCreateComplete")
    # Why this waiter: it returns only when the change set can be read and executed.
    assert waiter.get("CREATE_COMPLETE") == "success"
    assert waiter.get("FAILED") == "failure"

    section = _section(README.read_text(encoding="utf-8"), "Criar a stack de CD")
    commands = _cloudformation_commands(section)
    executions = [
        index
        for index, command in enumerate(commands)
        if _is(command, "execute-change-set") and _option(command, "--stack-name") == CD_STACK
    ]

    assert executions, "a seção 'Criar a stack de CD' deveria executar o change set da stack"
    for execution in executions:
        name = _option(commands[execution], "--change-set-name")
        creations = [
            index
            for index in range(execution)
            if _is(commands[index], "create-change-set")
            and _option(commands[index], "--stack-name") == CD_STACK
            and _option(commands[index], "--change-set-name") == name
        ]
        assert creations, f"o change set {name} é executado sem ter sido criado na seção"
        between = commands[creations[-1] + 1 : execution]
        waits = [
            index
            for index, command in enumerate(between)
            if _is(command, "wait", "change-set-create-complete")
            and _option(command, "--stack-name") == CD_STACK
            and _option(command, "--change-set-name") == name
        ]
        describes = [
            index for index, command in enumerate(between) if _is(command, "describe-change-set")
        ]

        assert waits and all(waits[0] < describe for describe in describes), (
            f"O README cria o change set {name} da stack {CD_STACK} e logo em seguida o "
            "descreve e o executa, sem esperar a criação, que é assíncrona. Colado como "
            "está, o describe-change-set mostra uma tabela vazia (o change set ainda está "
            "em CREATE_IN_PROGRESS) e o execute-change-set falha com InvalidChangeSetStatus, "
            "ou executa um change set que ninguém conferiu. Depois do create-change-set, "
            f"espere com 'aws cloudformation wait change-set-create-complete --stack-name "
            f"{CD_STACK} --change-set-name {name}' e só então descreva e execute."
        )
