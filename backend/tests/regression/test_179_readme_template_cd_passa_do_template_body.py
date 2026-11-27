"""O passo 2 de "Implantar o limite de permissões (#179)" cai em ValidationError: o
`infra/cd-pipeline.yaml` passou do tamanho que o `--template-body` aceita.

Erro observado: o README cria e atualiza a stack de CD com `aws cloudformation
create-change-set ... --template-body file://cd-pipeline.yaml`, nos passos 3 e 4 de
"Criar a stack de CD". O passo 4 é o que usam o passo 2 de "Implantar o limite de
permissões (#179)" e o passo 2 do caso "Depois do passo 4" de "Voltar a stack de CD para
antes do #179". O CloudFormation aceita no máximo 51.200 bytes no `TemplateBody` (é o
que diz a referência da API, no modelo do botocore), e o `infra/cd-pipeline.yaml` do
#179 tem 52.591 bytes. O de antes do #179 tinha 43.315. O `CreateChangeSet` é recusado
("Member must have length less than or equal to 51200"), e a stack de CD não recebe o
limite. O template do PR intermediário do caso "Depois do passo 4" também não cabe
(cerca de 52.550 bytes).

Esperado: todo arquivo do repositório que o README manda pelo `--template-body` cabe no
limite. Outra saída é o README mandar o template por um objeto do S3
(`--template-url`, que aceita até 1 MB). Nesse caso, nenhum comando manda arquivo do
repositório pelo `--template-body`, e este teste passa.
Issue: #179
"""

import re
import shlex
from pathlib import Path

import botocore.session

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
INFRA = ROOT / "infra"


def _template_body_limit() -> int:
    """The maximum of TemplateBody, from the API reference in the botocore model (the
    model itself has only the minimum)."""
    model = botocore.session.get_session().get_service_model("cloudformation")
    shape = model.operation_model("CreateChangeSet").input_shape.members["TemplateBody"]
    found = re.search(r"maximum length of ([\d,]+) bytes", shape.documentation)
    assert found, shape.documentation
    return int(found.group(1).replace(",", ""))


def _block_commands(markdown: str) -> list[list[str]]:
    """Each ``aws ...`` command of the code blocks, with the line breaks (``\\``) joined."""
    commands: list[list[str]] = []
    in_block, pending = False, ""
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_block, pending = not in_block, ""
            continue
        if not in_block:
            continue
        pending = f"{pending} {stripped}".strip()
        if pending.endswith("\\"):
            pending = pending[:-1].rstrip()
            continue
        if pending.startswith("aws "):
            commands.append(shlex.split(pending))
        pending = ""
    return commands


def test_179_cd_template_fits_the_template_body_of_the_readme() -> None:
    limit = _template_body_limit()
    commands = _block_commands(README.read_text(encoding="utf-8"))
    change_sets = [
        tokens
        for tokens in commands
        if tokens[1:3] == ["cloudformation", "create-change-set"] and "tomiyama-cd-dev" in tokens
    ]
    assert change_sets, "o README deixou de ter o create-change-set da stack de CD"

    too_big = []
    for tokens in commands:
        if tokens[1] != "cloudformation" or "--template-body" not in tokens:
            continue
        value = tokens[tokens.index("--template-body") + 1]
        name = value.removeprefix("file://")
        if "$" in name:
            continue  # a file the runbook writes itself (the template before #179)
        path = INFRA / name
        assert path.is_file(), f"{value}: o arquivo não existe em infra/"
        size = len(path.read_bytes())
        if size > limit:
            too_big.append(f"aws cloudformation {tokens[2]} {value}: {size} bytes")

    assert not too_big, (
        f"o CloudFormation recusa um --template-body com mais de {limit} bytes, e o README "
        "manda por ele um template maior:\n" + "\n".join(too_big)
    )
