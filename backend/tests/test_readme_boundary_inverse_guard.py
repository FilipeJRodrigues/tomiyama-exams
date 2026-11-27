"""Card #179: the shell blocks of the runbook that change the function roles by hand,
taken from ``backend/README.md`` itself and run in bash with a fake ``aws``.

- The inverse block of "Voltar a stack de CD para antes do #179" (between steps 3 and 4
  of "Implantar o limite de permissões") removes the boundary only when the
  ``FunctionPermissionsBoundary`` parameter of the app stack is empty. After step 4 the
  app template says that the roles have the boundary (the parameter holds the ARN).
  Removing it by hand there would leave the template and the roles disagreeing, so the
  block refuses and says that nothing was changed. Any other non-empty value (``None``)
  is refused as unexpected, without pointing to the "Depois do passo 4" case.
- Both blocks (that one and step 3, "Ponha o limite nos papéis atuais das funções")
  check the exit code of their two reads. A failing AWS CLI writes nothing on stdout
  (the ``$( )`` gives the same empty text as an empty parameter) or, when a page of
  ``list-stack-resources`` fails, only the roles of the pages before it. Either way the
  block changes no role and says that a read failed.

Skipped where there is no bash.
"""

import re
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
# Only the first page, as the AWS CLI leaves it when the request of the second one fails.
FIRST_PAGE = r"r-A\tr-B\r\n"
REFUSED = "Nenhum papel foi alterado"
READ_FAILURE = "A AWS CLI falhou ao ler"
# Exit codes of the AWS CLI v2: 254 for an error of the service (ExpiredToken,
# Throttling), 255 for a failure of the CLI itself (no connection, for instance).
FAILURE_CODES = pytest.mark.parametrize("code", ["254", "255"], ids=["erro-do-servico", "falha"])

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

# Logs each call (arguments split by \037, one call per line) in the file $CALLS, so that
# stderr carries only the errors. Each read prints its output ($DS_OUT, $LS_OUT) and then
# fails like the AWS CLI when its code ($DS_RC, $LS_RC) is not 0: the error on stderr.
FAKE_AWS_FAILING = r"""
aws() {
  local rc=0
  printf '%s\037' "$@" >> "$CALLS"; printf '\n' >> "$CALLS"
  case "$1 $2" in
    "cloudformation describe-stacks") printf '%b' "$DS_OUT"; rc=$DS_RC ;;
    "cloudformation list-stack-resources") printf '%b' "$LS_OUT"; rc=$LS_RC ;;
  esac
  if [ "$rc" != 0 ]; then
    printf '\nAn error occurred (Throttling) when calling the %s operation\n' "$2" >&2
  fi
  return "$rc"
}
"""


def _block_after(marker: str) -> str:
    lines = README.read_text(encoding="utf-8").splitlines()
    start = next(index for index, line in enumerate(lines) if marker in line)
    fence = next(index for index in range(start, len(lines)) if lines[index].strip() == "```bash")
    end = next(index for index in range(fence + 1, len(lines)) if lines[index].strip() == "```")
    return textwrap.dedent("\n".join(lines[fence + 1 : end]))


INVERSE_BLOCK = _block_after("**Depois do passo 3 e antes do passo 4")
PUT_BLOCK = _block_after("3. **Ponha o limite nos papéis atuais das funções**")
STATE_BLOCK = _block_after("**Primeiro, veja em que ponto está.**")


def _run(app_boundary: str, roles: str = ROLES) -> tuple[list[list[str]], str]:
    assert "'" not in app_boundary + roles
    script = (
        f"{FAKE_AWS}FAKE_APP_BOUNDARY='{app_boundary}'\nFAKE_ROLES='{roles}'\n{INVERSE_BLOCK}\n"
    )
    done = subprocess.run([BASH], input=script.encode(), capture_output=True, check=False)
    calls = [call.split("\x1f")[:-1] for call in done.stderr.decode().split("\x1e") if call]
    return calls, done.stdout.decode(errors="replace")


def _run_failing(
    tmp_path: Path, block: str, prelude: str = "", **values: str
) -> tuple[list[list[str]], str, str]:
    """Runs the block with FAKE_AWS_FAILING; ``prelude`` runs before it, in the same shell."""
    env = {"DS_OUT": "", "DS_RC": "0", "LS_OUT": ROLES, "LS_RC": "0", **values}
    calls_file = tmp_path / "calls"
    calls_file.unlink(missing_ok=True)
    assert all("'" not in value for value in env.values())
    variables = "".join(f"{name}='{value}'\n" for name, value in env.items())
    script = f"{FAKE_AWS_FAILING}{variables}CALLS='{calls_file.as_posix()}'\n{prelude}\n{block}\n"
    done = subprocess.run([BASH], input=script.encode(), capture_output=True, check=False)
    lines = calls_file.read_text(encoding="utf-8").splitlines() if calls_file.exists() else []
    calls = [line.split("\x1f")[:-1] for line in lines]
    return calls, done.stdout.decode(errors="replace"), done.stderr.decode(errors="replace")


def _role_names(calls: list[list[str]], operation: str) -> list[str]:
    return [call[call.index("--role-name") + 1] for call in calls if call[:2] == ["iam", operation]]


def _deleted(calls: list[list[str]]) -> list[str]:
    return _role_names(calls, "delete-role-permissions-boundary")


def _reads(calls: list[list[str]]) -> list[list[str]]:
    return [call[:2] for call in calls if call[:1] == ["cloudformation"]]


def _option(tokens: list[str], name: str) -> str:
    return tokens[tokens.index(name) + 1]


@pytest.mark.parametrize("block", [INVERSE_BLOCK, PUT_BLOCK], ids=["inverso", "passo-3"])
def test_179_blocks_are_valid_bash(block: str) -> None:
    assert "role-permissions-boundary" in block
    done = subprocess.run([BASH, "-n"], input=block.encode(), capture_output=True, check=False)
    assert done.returncode == 0, done.stderr.decode(errors="replace")


@pytest.mark.parametrize(
    "app_boundary",
    [ARN + r"\r\n", ARN + r"\n", ARN, "arn:aws:iam::123456789012:policy/outra"],
    ids=["arn-git-bash", "arn-linux", "arn-sem-quebra", "outra-politica"],
)
def test_179_inverse_block_refuses_an_arn_as_the_case_after_step_4(app_boundary: str) -> None:
    calls, out = _run(app_boundary)

    assert _deleted(calls) == []
    assert not any(call[:1] == ["iam"] for call in calls), calls
    assert REFUSED in out
    assert "Depois do passo 4" in out


@pytest.mark.parametrize(
    "app_boundary",
    [r"None\r\n", r"None\n", r"algo\r\n", r"arn:aws:iam::123:policy/curta\r\n"],
    ids=["None", "None-lf", "texto", "arn-conta-curta"],
)
def test_179_inverse_block_refuses_another_value_as_unexpected(app_boundary: str) -> None:
    """A non-empty value that is not a policy ARN changes nothing either, and the message
    does not send the reader to the "Depois do passo 4" case."""
    calls, out = _run(app_boundary)

    assert _deleted(calls) == []
    assert not any(call[:1] == ["iam"] for call in calls), calls
    assert REFUSED in out
    assert "inesperado" in out
    assert "Depois do passo 4" not in out


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


# --- reads that fail -------------------------------------------------------------------


def test_179_failing_fake_is_not_vacuous(tmp_path: Path) -> None:
    """With both reads answering (exit code 0), the two blocks change every role: the
    refusals below come from the failed read, not from the fake."""
    calls, out, _ = _run_failing(tmp_path, INVERSE_BLOCK, DS_OUT=r"\r\n")
    assert _deleted(calls) == CLEAN_ROLES
    assert REFUSED not in out

    calls, out, _ = _run_failing(tmp_path, PUT_BLOCK, DS_OUT=ARN + r"\r\n")
    assert _role_names(calls, "put-role-permissions-boundary") == CLEAN_ROLES
    assert REFUSED not in out


@FAILURE_CODES
def test_179_inverse_block_changes_no_role_when_a_page_of_the_roles_fails(
    tmp_path: Path, code: str
) -> None:
    """The parameter is read and empty, but list-stack-resources fails on its second page:
    the first page alone would remove the boundary of only part of the roles."""
    calls, out, err = _run_failing(
        tmp_path, INVERSE_BLOCK, DS_OUT=r"\r\n", LS_OUT=FIRST_PAGE, LS_RC=code
    )

    assert _reads(calls) == [
        ["cloudformation", "describe-stacks"],
        ["cloudformation", "list-stack-resources"],
    ]
    assert _deleted(calls) == []
    assert not any(call[:1] == ["iam"] for call in calls), calls
    assert REFUSED in out and READ_FAILURE in out
    assert "Throttling" in err


@FAILURE_CODES
def test_179_inverse_block_says_the_parameter_read_failed(tmp_path: Path, code: str) -> None:
    """The refusal of a failed describe-stacks has its own message: not the one of an
    empty, an unexpected or an ARN parameter."""
    calls, out, _ = _run_failing(tmp_path, INVERSE_BLOCK, DS_RC=code)

    assert _deleted(calls) == []
    assert REFUSED in out and READ_FAILURE in out
    assert "Depois do passo 4" not in out and "inesperado" not in out


@FAILURE_CODES
def test_179_step_3_changes_no_role_when_a_page_of_the_roles_fails(
    tmp_path: Path, code: str
) -> None:
    """The ARN is right, but list-stack-resources fails on its second page: the first page
    alone would set the boundary on only part of the roles."""
    calls, out, err = _run_failing(
        tmp_path, PUT_BLOCK, DS_OUT=ARN + r"\r\n", LS_OUT=FIRST_PAGE, LS_RC=code
    )

    assert _reads(calls) == [
        ["cloudformation", "describe-stacks"],
        ["cloudformation", "list-stack-resources"],
    ]
    assert _role_names(calls, "put-role-permissions-boundary") == []
    assert not any(call[:1] == ["iam"] for call in calls), calls
    assert REFUSED in out and READ_FAILURE in out
    assert "Throttling" in err


@FAILURE_CODES
def test_179_step_3_says_the_read_of_the_cd_stack_failed(tmp_path: Path, code: str) -> None:
    """describe-stacks of the CD stack fails (nothing on stdout) and the roles come: the
    block changes nothing and says that the read failed, not that the ARN has another
    format."""
    calls, out, err = _run_failing(tmp_path, PUT_BLOCK, DS_RC=code)

    describe = [call for call in calls if call[:2] == ["cloudformation", "describe-stacks"]]
    assert len(describe) == 1 and _option(describe[0], "--stack-name") == "tomiyama-cd-dev"
    assert _role_names(calls, "put-role-permissions-boundary") == []
    assert REFUSED in out and READ_FAILURE in out
    assert "e não arn:aws:iam::" not in out
    assert "Throttling" in err


@pytest.mark.parametrize(
    ("block", "read", "operation"),
    [
        (INVERSE_BLOCK, r"\r\n", "delete-role-permissions-boundary"),
        (PUT_BLOCK, ARN + r"\r\n", "put-role-permissions-boundary"),
    ],
    ids=["inverso", "passo-3"],
)
def test_179_blocks_can_be_pasted_again_after_a_failed_read(
    tmp_path: Path, block: str, read: str, operation: str
) -> None:
    """Pasted in a terminal where a run already failed, every variable the block assigns
    still holds a value ("1"). The block sets its own state again, and good reads change
    every role."""
    # Assignments that start a line or follow a "||" (the mark of a failed read).
    names = sorted(set(re.findall(r"(?:^|\|\|)\s*([A-Z_]+)=", block, flags=re.MULTILINE)))
    assert len(names) >= 3, names
    stale = "".join(f"{name}=1\n" for name in names)

    calls, out, _ = _run_failing(tmp_path, block, prelude=stale, DS_OUT=read)

    assert _role_names(calls, operation) == CLEAN_ROLES
    assert REFUSED not in out
