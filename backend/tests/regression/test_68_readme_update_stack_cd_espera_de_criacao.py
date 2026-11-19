"""O README manda esperar o update da stack de CD com o waiter de criação.

Erro observado (qa, 2026-11-18, na correção do papel de execução do #68): para aplicar a
correção, a stack tomiyama-cd-dev, já criada, precisa de um update. A seção "Criar a
stack de CD" do backend/README.md diz "Para mudar a stack de CD depois, siga o mesmo
caminho com `--change-set-type UPDATE`". Esse caminho termina em
`aws cloudformation wait stack-create-complete`, o único waiter da seção. No modelo do
waiter StackCreateComplete (waiters-2.json do CloudFormation, igual no botocore e na
AWS CLI v2), UPDATE_IN_PROGRESS, UPDATE_FAILED, UPDATE_ROLLBACK_FAILED e
UPDATE_ROLLBACK_COMPLETE contam como sucesso. Seguindo o README, o waiter termina com
sucesso (código 0) logo na primeira consulta, com o update ainda em andamento, ou
depois de o update falhar e voltar. O operador acha que o papel de execução já tem a
permissão, roda a esteira de novo e vê o mesmo FAILED do change set, sem saber que o
update da stack de CD não foi aplicado.

Esperado: o caminho de update da stack de CD no README espera com
`aws cloudformation wait stack-update-complete --stack-name tomiyama-cd-dev`, que só
termina com sucesso em UPDATE_COMPLETE e falha em UPDATE_FAILED,
UPDATE_ROLLBACK_FAILED e UPDATE_ROLLBACK_COMPLETE.
Issue: #68
"""

import json
import re
from pathlib import Path

import botocore

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
CD_STACK = "tomiyama-cd-dev"
WAITERS = (
    Path(botocore.__file__).parent / "data" / "cloudformation" / "2010-05-15" / "waiters-2.json"
)


def _acceptors(waiter: str) -> dict[str, str]:
    """Stack status -> state ("success", "failure", "retry") of a CloudFormation waiter."""
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


def test_68_readme_waits_for_the_cd_stack_update_with_the_update_waiter() -> None:
    create, update = _acceptors("StackCreateComplete"), _acceptors("StackUpdateComplete")
    # Why the create waiter cannot confirm an update: it accepts a failed one.
    assert create.get("UPDATE_ROLLBACK_COMPLETE") == "success"
    assert create.get("UPDATE_IN_PROGRESS") == "success"
    assert update.get("UPDATE_ROLLBACK_COMPLETE") == "failure"
    assert update.get("UPDATE_FAILED") == "failure"

    section = _section(README.read_text(encoding="utf-8"), "Criar a stack de CD")
    text = re.sub(r"\\\n\s*", " ", section)

    assert "--change-set-type UPDATE" in text, (
        "a seção 'Criar a stack de CD' deveria explicar como atualizar a stack de CD"
    )
    assert re.search(
        rf"wait\s+stack-update-complete\b[^`\n]*--stack-name\s+{re.escape(CD_STACK)}\b", text
    ), (
        "O README manda atualizar a stack de CD pelo mesmo caminho da criação, que espera "
        "com 'aws cloudformation wait stack-create-complete'. Esse waiter conta "
        "UPDATE_IN_PROGRESS, UPDATE_FAILED e UPDATE_ROLLBACK_COMPLETE como sucesso: o "
        "operador vê o update como concluído quando ele ainda roda ou já voltou. No caminho "
        f"de update, espere com 'aws cloudformation wait stack-update-complete --stack-name "
        f"{CD_STACK}'."
    )
