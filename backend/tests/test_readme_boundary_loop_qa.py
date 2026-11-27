"""QA coverage (card #179): the shell blocks of the runbook that change the function roles
by hand, taken from ``backend/README.md`` itself and run in bash with a fake ``aws``.

- Step 3 of "Implantar o limite de permissões (#179)" sets the boundary only when the
  ARN has the format of the CD stack's policy and some role came. With any other output
  the AWS CLI may give (empty, ``None``, another policy, another partition, two lines,
  blanks), it calls nothing and says so.
- With the right values, every role gets the boundary, with a clean name. The AWS CLI of
  Windows ends its lines with ``\\r\\n``, Git Bash strips only the last one, and the
  roles of each page of ``list-stack-resources`` come in a line of their own.
- The inverse block of "Voltar a stack de CD para antes do #179" (between steps 3 and 4)
  removes the boundary of every role, with a clean name, and calls nothing without roles.

Skipped where there is no bash.
"""

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
    "cloudformation describe-stacks") printf '%b' "$FAKE_BOUNDARY" ;;
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


PUT_BLOCK = _block_after("3. **Ponha o limite nos papéis atuais das funções**")
DELETE_BLOCK = _block_after("**Depois do passo 3 e antes do passo 4")


def _run(block: str, boundary: str, roles: str) -> tuple[list[list[str]], str]:
    assert "'" not in boundary + roles
    script = f"{FAKE_AWS}FAKE_BOUNDARY='{boundary}'\nFAKE_ROLES='{roles}'\n{block}\n"
    done = subprocess.run([BASH], input=script.encode(), capture_output=True, check=False)
    calls = [call.split("\x1f")[:-1] for call in done.stderr.decode().split("\x1e") if call]
    return calls, done.stdout.decode(errors="replace")


def _role_names(calls: list[list[str]], operation: str) -> list[str]:
    return [call[call.index("--role-name") + 1] for call in calls if call[:2] == ["iam", operation]]


def test_blocks_are_the_expected_ones_and_valid_bash() -> None:
    assert "put-role-permissions-boundary" in PUT_BLOCK
    assert "delete-role-permissions-boundary" in DELETE_BLOCK
    for block in (PUT_BLOCK, DELETE_BLOCK):
        done = subprocess.run([BASH, "-n"], input=block.encode(), capture_output=True, check=False)
        assert done.returncode == 0, done.stderr.decode(errors="replace")


def test_step_3_sets_the_boundary_on_every_role_with_a_clean_name() -> None:
    calls, out = _run(PUT_BLOCK, ARN + r"\r\n", ROLES)

    puts = [call for call in calls if call[:2] == ["iam", "put-role-permissions-boundary"]]
    assert puts == [
        [
            "iam",
            "put-role-permissions-boundary",
            "--role-name",
            role,
            "--permissions-boundary",
            ARN,
            "--profile",
            "tomiyama",
        ]
        for role in CLEAN_ROLES
    ]
    assert REFUSED not in out


@pytest.mark.parametrize(
    "boundary",
    [
        "",
        r"\r\n",
        r"None\r\n",
        ARN.replace("function-boundary", "other") + r"\r\n",
        ARN.replace("arn:aws:", "arn:aws-us-gov:") + r"\r\n",
        ARN.replace("123456789012", "12345678901"),
        ARN.replace("123456789012", "1234567890123"),
        ARN.replace("policy/cd/", "policy/"),
        ARN.replace("tomiyama-dev", "tomiyama-prod"),
        ARN + r"\r\n" + ARN + r"\r\n",
        ARN + r" \r\n",
        ARN + r"\t\r\n",
        " " + ARN,
        ARN + "2",
    ],
    ids=[
        "nada",
        "linha-vazia",
        "None",
        "outra-politica",
        "outra-particao",
        "conta-11-digitos",
        "conta-13-digitos",
        "sem-caminho-cd",
        "outra-stack",
        "duas-linhas",
        "espaco-no-fim",
        "tab-no-fim",
        "espaco-no-inicio",
        "sufixo",
    ],
)
def test_step_3_refuses_a_boundary_of_another_format(boundary: str) -> None:
    calls, out = _run(PUT_BLOCK, boundary, ROLES)

    assert _role_names(calls, "put-role-permissions-boundary") == []
    assert REFUSED in out


@pytest.mark.parametrize(
    "roles", ["", r"\r\n", r"None\r\n", r"None\n"], ids=["nada", "linha-vazia", "None", "None-lf"]
)
def test_step_3_refuses_no_roles(roles: str) -> None:
    calls, out = _run(PUT_BLOCK, ARN + r"\r\n", roles)

    assert _role_names(calls, "put-role-permissions-boundary") == []
    assert REFUSED in out


def test_step_3_check_is_not_vacuous_without_the_carriage_return_line() -> None:
    """Without the line that strips \\r, the same output does not give the clean calls:
    a role keeps the \\r of its line (Git Bash) or the ARN is refused (Linux)."""
    line = "BOUNDARY=${BOUNDARY//$'\\r'/}; ROLES=${ROLES//$'\\r'/}"
    assert line in PUT_BLOCK

    calls, _ = _run(PUT_BLOCK.replace(line, ":"), ARN + r"\r\n", ROLES)

    assert _role_names(calls, "put-role-permissions-boundary") != CLEAN_ROLES


def test_inverse_block_removes_the_boundary_of_every_role_with_a_clean_name() -> None:
    calls, _ = _run(DELETE_BLOCK, "", ROLES)

    deletes = [call for call in calls if call[:2] == ["iam", "delete-role-permissions-boundary"]]
    assert deletes == [
        ["iam", "delete-role-permissions-boundary", "--role-name", role, "--profile", "tomiyama"]
        for role in CLEAN_ROLES
    ]


@pytest.mark.parametrize("roles", ["", r"\r\n"], ids=["nada", "linha-vazia"])
def test_inverse_block_calls_nothing_without_roles(roles: str) -> None:
    calls, _ = _run(DELETE_BLOCK, "", roles)

    assert _role_names(calls, "delete-role-permissions-boundary") == []
