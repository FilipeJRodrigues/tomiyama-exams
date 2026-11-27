"""Card #179: the inverse block of "Voltar a stack de CD para antes do #179" (between steps
3 and 4 of "Implantar o limite de permissões") removes the boundary only when the
``FunctionPermissionsBoundary`` parameter of the app stack is empty.

After step 4 the app template says that the roles have the boundary (the parameter holds
the ARN). Removing it by hand there would leave the template and the roles disagreeing,
so the block refuses and says that nothing was changed. The block is taken from
``backend/README.md`` itself and run in bash with a fake ``aws``. Skipped where there is
no bash.
"""

import shlex
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "backend" / "README.md"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="sem bash")

ARN = "arn:aws:iam::123456789012:policy/cd/cd-tomiyama-dev-function-boundary"
# Two pages of list-stack-resources, as the AWS CLI of Windows prints them.
ROLES = r"r-A\tr-B\r\nr-C\r\n"
CLEAN_ROLES = ["r-A", "r-B", "r-C"]
REFUSED = "Nenhum papel foi alterado"

# Logs each call (arguments split by \037, calls by \036) on stderr, and answers the two
# reads with the values of the case (escapes such as \r\n read by printf %b).
FAKE_AWS = r"""
aws() {
  printf '%s\037' "$@" >&2; printf '\036' >&2
  case "$1 $2" in
    "cloudformation describe-stacks") printf '%b' "$FAKE_APP_BOUNDARY" ;;
    "cloudformation list-stack-resources") printf '%b' "$FAKE_ROLES" ;;
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
STATE_BLOCK = _block_after("**Primeiro, veja em que ponto está.**")


def _run(app_boundary: str, roles: str = ROLES) -> tuple[list[list[str]], str]:
    assert "'" not in app_boundary + roles
    script = (
        f"{FAKE_AWS}FAKE_APP_BOUNDARY='{app_boundary}'\nFAKE_ROLES='{roles}'\n{INVERSE_BLOCK}\n"
    )
    done = subprocess.run([BASH], input=script.encode(), capture_output=True, check=False)
    calls = [call.split("\x1f")[:-1] for call in done.stderr.decode().split("\x1e") if call]
    return calls, done.stdout.decode(errors="replace")


def _deleted(calls: list[list[str]]) -> list[str]:
    return [
        call[call.index("--role-name") + 1]
        for call in calls
        if call[:2] == ["iam", "delete-role-permissions-boundary"]
    ]


def _option(tokens: list[str], name: str) -> str:
    return tokens[tokens.index(name) + 1]


def test_179_inverse_block_is_valid_bash() -> None:
    assert "delete-role-permissions-boundary" in INVERSE_BLOCK
    done = subprocess.run(
        [BASH, "-n"], input=INVERSE_BLOCK.encode(), capture_output=True, check=False
    )
    assert done.returncode == 0, done.stderr.decode(errors="replace")


@pytest.mark.parametrize(
    "app_boundary",
    [ARN + r"\r\n", ARN + r"\n", ARN, r"None\r\n", "arn:aws:iam::123456789012:policy/outra"],
    ids=["arn-git-bash", "arn-linux", "arn-sem-quebra", "None", "outra-politica"],
)
def test_179_inverse_block_refuses_when_the_app_parameter_is_not_empty(app_boundary: str) -> None:
    calls, out = _run(app_boundary)

    assert _deleted(calls) == []
    assert not any(call[:1] == ["iam"] for call in calls), calls
    assert REFUSED in out
    assert "Depois do passo 4" in out


@pytest.mark.parametrize("app_boundary", ["", r"\n", r"\r\n"], ids=["nada", "lf", "crlf"])
def test_179_inverse_block_goes_on_when_the_app_parameter_is_empty(app_boundary: str) -> None:
    """The guard is not vacuous: an empty parameter (the text output of the AWS CLI is an
    empty line, with \\r\\n on Windows) lets the block remove every boundary."""
    calls, out = _run(app_boundary)

    assert _deleted(calls) == CLEAN_ROLES
    assert REFUSED not in out


def test_179_inverse_block_reads_the_parameter_of_the_app_stack() -> None:
    """The guard reads the same parameter, of the same stack, as the command at the top of
    the section that tells the cases apart."""
    calls, _ = _run(ARN)
    reads = [call for call in calls if call[:2] == ["cloudformation", "describe-stacks"]]
    state = [
        shlex.split(line)
        for line in STATE_BLOCK.replace("\\\n", " ").splitlines()
        if line.strip().startswith("aws cloudformation describe-stacks")
    ]

    assert len(reads) == 1 and len(state) == 1
    assert _option(reads[0], "--stack-name") == _option(state[0][1:], "--stack-name")
    assert _option(reads[0], "--stack-name") == "tomiyama-dev"
    assert _option(reads[0], "--query") == _option(state[0][1:], "--query")
    assert "FunctionPermissionsBoundary" in _option(reads[0], "--query")
    assert _option(reads[0], "--output") == "text"
