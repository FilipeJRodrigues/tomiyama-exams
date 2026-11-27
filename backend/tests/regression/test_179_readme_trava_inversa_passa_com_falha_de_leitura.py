"""O bloco que tira o limite à mão o tira mesmo quando não conseguiu ler o parâmetro do app.

Erro observado: em "Voltar a stack de CD para antes do #179", o bloco do caso "Depois do
passo 3 e antes do passo 4" lê o parâmetro `FunctionPermissionsBoundary` da `tomiyama-dev`
(`describe-stacks ... --output text`) e só deveria seguir quando ele vem vazio. Com o ARN,
o caso é "Depois do passo 4", e tirar o limite à mão deixaria o template do app dizendo que
os papéis o têm. Quando o `describe-stacks` falha, a AWS CLI escreve o erro no stderr, sai
com 254 (erro do serviço, como `ExpiredToken`) ou 255 (sem conexão, por exemplo) e não
escreve nada no stdout. O `$( )` dá então o mesmo texto vazio de um parâmetro vazio, e o
bloco segue. Se o `list-stack-resources` logo depois responder (a falha foi passageira, ou
um código de MFA digitado errado só no primeiro comando), o bloco chama
`delete-role-permissions-boundary` em todos os papéis, sem ter lido o parâmetro. É o caso
que a trava existe para barrar. A trava do passo 3 não tem esse problema, porque só segue
com um ARN no formato certo, e uma saída vazia é recusada.

Esperado: se a leitura do parâmetro falhar, o bloco não altera nenhum papel e avisa
("Nenhum papel foi alterado", como as outras recusas do bloco). Para isso, ele pode
conferir o código de saída do `describe-stacks` ou trocar a saída vazia de uma falha por um
texto que não seja vazio. Continua sem `exit`.
Issue: #179
"""

import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="sem bash")

# Two pages of list-stack-resources, as the AWS CLI of Windows prints them.
ROLES = r"r-A\tr-B\r\nr-C\r\n"
CLEAN_ROLES = ["r-A", "r-B", "r-C"]
REFUSED = "Nenhum papel foi alterado"

# Logs each call (arguments split by \037, one call per line) in the file $CALLS, so that
# the stderr carries only the errors of the AWS CLI. describe-stacks fails like the AWS
# CLI when $DS_ERR is set: the message on stderr, nothing on stdout, the exit code $DS_RC.
FAKE_AWS = r"""
aws() {
  printf '%s\037' "$@" >> "$CALLS"; printf '\n' >> "$CALLS"
  case "$1 $2" in
    "cloudformation describe-stacks")
      if [ -n "$DS_ERR" ]; then printf '\n%s\n' "$DS_ERR" >&2; return "$DS_RC"; fi
      printf '%b' "$DS_OUT" ;;
    "cloudformation list-stack-resources") printf '%b' "$LS_OUT" ;;
  esac
}
"""


def _block_after(marker: str) -> str:
    lines = README.read_text(encoding="utf-8").splitlines()
    start = next(index for index, line in enumerate(lines) if marker in line)
    fence = next(index for index in range(start, len(lines)) if lines[index].strip() == "```bash")
    end = next(index for index in range(fence + 1, len(lines)) if lines[index].strip() == "```")
    return textwrap.dedent("\n".join(lines[fence + 1 : end]))


INVERSE_BLOCK = _block_after("**Depois do passo 3 e antes do passo 4")


def _run(tmp_path: Path, **values: str) -> tuple[list[list[str]], str]:
    env = {"DS_OUT": "", "DS_ERR": "", "DS_RC": "0", "LS_OUT": ROLES, **values}
    calls_file = tmp_path / "calls"
    calls_file.unlink(missing_ok=True)
    assert all("'" not in value for value in env.values())
    variables = "".join(f"{name}='{value}'\n" for name, value in env.items())
    script = f"{FAKE_AWS}{variables}CALLS='{calls_file.as_posix()}'\n{INVERSE_BLOCK}\n"
    done = subprocess.run([BASH], input=script.encode(), capture_output=True, check=False)
    lines = calls_file.read_text(encoding="utf-8").splitlines() if calls_file.exists() else []
    calls = [line.split("\x1f")[:-1] for line in lines]
    return calls, done.stdout.decode(errors="replace")


def _deleted(calls: list[list[str]]) -> list[str]:
    return [
        call[call.index("--role-name") + 1]
        for call in calls
        if call[:2] == ["iam", "delete-role-permissions-boundary"]
    ]


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (
            "An error occurred (ExpiredToken) when calling the DescribeStacks operation: "
            "The security token included in the request is expired",
            "254",
        ),
        (
            'Could not connect to the endpoint URL: "https://cloudformation.us-east-2.amazonaws.com/"',
            "255",
        ),
        (
            "An error occurred (Throttling) when calling the DescribeStacks operation "
            "(reached max retries: 2): Rate exceeded",
            "254",
        ),
    ],
    ids=["credencial-vencida", "sem-conexao", "limite-de-chamadas"],
)
def test_179_inverse_block_changes_no_role_when_the_parameter_read_fails(
    tmp_path: Path, error: str, code: str
) -> None:
    # The fake is not vacuous: with the parameter read and empty, every boundary goes.
    calls, _ = _run(tmp_path, DS_OUT=r"\r\n")
    assert _deleted(calls) == CLEAN_ROLES

    calls, out = _run(tmp_path, DS_ERR=error, DS_RC=code)

    assert any(call[:2] == ["cloudformation", "describe-stacks"] for call in calls), calls
    assert _deleted(calls) == [], (
        "O describe-stacks falhou (erro no stderr, saída vazia, código "
        f"{code}), e o bloco tirou o limite de {_deleted(calls)} sem ter lido o parâmetro "
        "FunctionPermissionsBoundary da tomiyama-dev: a saída vazia de uma falha foi lida "
        "como parâmetro vazio. Se o caso fosse 'Depois do passo 4', o template do app "
        "continuaria dizendo que os papéis têm o limite."
    )
    assert REFUSED in out, out
