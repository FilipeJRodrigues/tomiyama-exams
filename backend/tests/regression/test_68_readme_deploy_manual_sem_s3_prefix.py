"""O deploy manual do dev descrito no README falha depois do primeiro deploy pela esteira.

Erro observado: a seção "Deploy do dev" do backend/README.md manda rodar
`sam deploy --stack-name tomiyama-dev ... --resolve-s3` sem `--s3-prefix`. Sem
prefixo, o SAM CLI grava o código das funções na raiz do bucket gerenciado
(`aws-sam-cli-managed-default-samclisourcebucket-…/<hash>`; conferido no
`samcli/lib/package/s3_uploader.py` da versão fixada, 1.171.0). Depois do primeiro
deploy pela esteira (#68), a stack guarda o papel `cd-tomiyama-dev-cfn-exec`, e o
CloudFormation passa a usá-lo também no `sam deploy` manual. Esse papel só lê código
em `…/tomiyama-dev/*` (`ReadFunctionPackages` em `infra/cd-pipeline.yaml`). Por isso o
comando da seção falha com AccessDenied do S3 ao atualizar as funções, e a stack
volta. A seção nova ("Papel guardado na stack e o `sam deploy` manual") pede o
`--s3-prefix`. Já a seção "Deploy do dev", que a seção da esteira diz que "continua
valendo", ficou com o comando antigo.

Esperado: todo `sam deploy` da stack do app com `--resolve-s3` nos blocos de comando do
README leva `--s3-prefix` com o nome da stack, o prefixo que o papel de execução lê.
Issue: #68
"""

import re
from pathlib import Path

from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
CD_TEMPLATE = ROOT / "infra" / "cd-pipeline.yaml"
SAM_MANAGED_BUCKET = "aws-sam-cli-managed-default-samclisourcebucket-*"


def _app_stack_name() -> str:
    template, errors = decode(str(CD_TEMPLATE))
    assert not errors, errors
    return template["Parameters"]["AppStackName"]["Default"]


def _execution_role_reads_only_the_stack_prefix() -> bool:
    """The execution role reads the SAM CLI bucket only under "<AppStackName>/"."""
    text = CD_TEMPLATE.read_text(encoding="utf-8")
    return f"{SAM_MANAGED_BUCKET}/${{AppStackName}}/*" in text


def _shell_commands(markdown: str) -> list[str]:
    """Commands of the fenced code blocks, with backslash continuations joined."""
    commands = []
    for block in re.findall(r"```(?:bash|sh)?\n(.*?)```", markdown, flags=re.S):
        joined = re.sub(r"\\\n\s*", " ", block)
        commands.extend(line.strip() for line in joined.splitlines() if line.strip())
    return commands


def test_readme_manual_sam_deploys_use_the_prefix_the_execution_role_reads() -> None:
    stack = _app_stack_name()
    assert _execution_role_reads_only_the_stack_prefix()
    deploys = [
        command
        for command in _shell_commands(README.read_text(encoding="utf-8"))
        if command.startswith("sam deploy")
        and f"--stack-name {stack}" in command
        and "--resolve-s3" in command
    ]

    assert deploys, "o README deveria ter o comando de deploy manual do dev"
    missing = [command for command in deploys if f"--s3-prefix {stack}" not in command]
    assert not missing, (
        f"Estes comandos do README gravam o código fora de {stack}/ e falham com AccessDenied "
        f"quando a stack guarda o papel de execução da esteira: {missing}"
    )
