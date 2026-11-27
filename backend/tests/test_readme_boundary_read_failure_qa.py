"""Card #179 (qa): the two blocks of the runbook that change the function roles by hand
check the exit code of their two reads in every combination, and in the terminal of
whoever pastes them.

Both blocks are taken from ``backend/README.md`` itself and run in bash with a fake
``aws``: step 3 of "Implantar o limite de permissões" ("Ponha o limite nos papéis atuais
das funções", ``put-role-permissions-boundary``) and the inverse block of "Voltar a stack
de CD para antes do #179" (between steps 3 and 4, ``delete-role-permissions-boundary``).

- Each read failing alone (exit codes 254 and 255, nothing on stdout), a page of the
  roles failing (only the first page on stdout), both reads failing, and the block pasted
  again in a terminal where the mark of a failed read is still set: the block changes no
  role, says that a read failed (and only that), and the error of the AWS CLI comes above
  the message, as the message says.
- ``set -e``, ``set -u`` and ``set -o pipefail`` in the terminal of whoever pastes the
  block: a failed read still changes no role and still prints the message (the shell is
  not ended before it), and good reads still change every role.

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
# Only the first page, as the AWS CLI leaves it when the request of the second one fails.
FIRST_PAGE = r"r-A\tr-B\r\n"
REFUSED = "Nenhum papel foi alterado"
READ_FAILURE = "A AWS CLI falhou ao ler"
CLI_ERROR = "An error occurred (Throttling)"
# Texts of the other refusals: none of them may come with a failed read.
OTHER_REFUSALS = ["e não arn:aws:iam::", "Depois do passo 4", "inesperado", "Não veio nenhum"]

# Logs each call (arguments split by \037, one call per line) in the file $CALLS. Each read
# prints its output and then fails like the AWS CLI when its code is not 0: the error on
# stderr. The script runs with stderr on stdout, so the order of the two is kept.
FAKE_AWS = r"""
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


PUT_BLOCK = _block_after("3. **Ponha o limite nos papéis atuais das funções**")
INVERSE_BLOCK = _block_after("**Depois do passo 3 e antes do passo 4")

# (block, the stdout of a good describe-stacks, the operation that changes the roles)
BLOCKS = pytest.mark.parametrize(
    ("block", "good_read", "operation"),
    [
        (PUT_BLOCK, ARN + r"\r\n", "put-role-permissions-boundary"),
        (INVERSE_BLOCK, r"\r\n", "delete-role-permissions-boundary"),
    ],
    ids=["passo-3", "inverso"],
)

SHELL_OPTIONS = pytest.mark.parametrize(
    "options",
    [
        "",
        "set -e",
        "set -u",
        "set -o pipefail",
        "set -euo pipefail",
        "set -euo pipefail; shopt -s inherit_errexit",
    ],
    ids=["padrao", "e", "u", "pipefail", "euo-pipefail", "inherit-errexit"],
)

# (describe-stacks: stdout, code; list-stack-resources: stdout, code). An empty stdout in
# describe-stacks stands for the good read of the case (the ARN or the empty parameter).
GOOD = None
FAILURES = pytest.mark.parametrize(
    ("ds_out", "ds_rc", "ls_out", "ls_rc"),
    [
        ("", "254", ROLES, "0"),
        ("", "255", ROLES, "0"),
        (GOOD, "0", "", "254"),
        (GOOD, "0", "", "255"),
        (GOOD, "0", FIRST_PAGE, "254"),
        (GOOD, "0", FIRST_PAGE, "255"),
        ("", "254", "", "254"),
        ("", "255", FIRST_PAGE, "255"),
    ],
    ids=[
        "describe-254",
        "describe-255",
        "lista-254",
        "lista-255",
        "pagina-parcial-254",
        "pagina-parcial-255",
        "as-duas-254",
        "as-duas-255-pagina-parcial",
    ],
)


def _run(
    tmp_path: Path, block: str, prelude: str = "", **values: str
) -> tuple[list[list[str]], str, int]:
    """Runs ``prelude`` and then the block in one bash, with stderr on stdout."""
    env = {"DS_OUT": "", "DS_RC": "0", "LS_OUT": ROLES, "LS_RC": "0", **values}
    calls_file = tmp_path / "calls"
    calls_file.unlink(missing_ok=True)
    assert all("'" not in value for value in env.values())
    variables = "".join(f"{name}='{value}'\n" for name, value in env.items())
    script = (
        f"exec 2>&1\n{FAKE_AWS}{variables}CALLS='{calls_file.as_posix()}'\n"
        f"{prelude}\n{block}\necho FIM-DO-BLOCO\n"
    )
    done = subprocess.run([BASH], input=script.encode(), capture_output=True, check=False)
    lines = calls_file.read_text(encoding="utf-8").splitlines() if calls_file.exists() else []
    calls = [line.split("\x1f")[:-1] for line in lines]
    return calls, done.stdout.decode(errors="replace"), done.returncode


def _changed(calls: list[list[str]]) -> list[list[str]]:
    return [call for call in calls if call[:1] == ["iam"]]


def _reads(calls: list[list[str]]) -> list[str]:
    return [call[1] for call in calls if call[:1] == ["cloudformation"]]


def _assert_read_failure_refused(calls: list[list[str]], out: str) -> None:
    assert _changed(calls) == [], calls
    # Both reads ran: the block does not stop at the first failure, so the error of each
    # one is on the screen.
    assert _reads(calls) == ["describe-stacks", "list-stack-resources"], calls
    assert READ_FAILURE in out and REFUSED in out, out
    for text in OTHER_REFUSALS:
        assert text not in out, (text, out)
    # "o erro dela está acima": the error of the AWS CLI comes before the message.
    assert CLI_ERROR in out, out
    assert out.index(CLI_ERROR) < out.index(READ_FAILURE), out


@BLOCKS
@FAILURES
def test_179_a_failed_read_changes_no_role_and_says_so(
    tmp_path: Path,
    block: str,
    good_read: str,
    operation: str,
    ds_out: str | None,
    ds_rc: str,
    ls_out: str,
    ls_rc: str,
) -> None:
    calls, out, _ = _run(
        tmp_path,
        block,
        DS_OUT=good_read if ds_out is GOOD else ds_out,
        DS_RC=ds_rc,
        LS_OUT=ls_out,
        LS_RC=ls_rc,
    )

    assert operation in block
    _assert_read_failure_refused(calls, out)


@BLOCKS
def test_179_pasted_again_while_the_read_still_fails(
    tmp_path: Path, block: str, good_read: str, operation: str
) -> None:
    """A terminal where the last run failed (the mark still "1") and the read fails again:
    zeroing the mark does not let the second run through."""
    calls, out, _ = _run(
        tmp_path, block, prelude="READ_FAILED=1", DS_OUT=good_read, LS_OUT="", LS_RC="254"
    )

    _assert_read_failure_refused(calls, out)


@BLOCKS
def test_179_a_stale_mark_does_not_refuse_good_reads(
    tmp_path: Path, block: str, good_read: str, operation: str
) -> None:
    """Only the mark is stale ("1" from a failed run, or any other text): good reads
    change every role."""
    for stale in ["1", "sim", "0"]:
        calls, out, _ = _run(tmp_path, block, prelude=f"READ_FAILED={stale}", DS_OUT=good_read)

        names = [call[call.index("--role-name") + 1] for call in _changed(calls)]
        assert names == CLEAN_ROLES, (stale, out)
        assert all(call[1] == operation for call in _changed(calls))
        assert REFUSED not in out and READ_FAILURE not in out


@BLOCKS
@SHELL_OPTIONS
def test_179_shell_options_keep_the_refusal_of_a_failed_read(
    tmp_path: Path, block: str, good_read: str, operation: str, options: str
) -> None:
    """With errexit, nounset or pipefail on, a failed read (a page of the roles here) still
    changes no role, and the shell reaches the message and the end of the block."""
    calls, out, code = _run(
        tmp_path, block, prelude=options, DS_OUT=good_read, LS_OUT=FIRST_PAGE, LS_RC="254"
    )

    _assert_read_failure_refused(calls, out)
    assert "FIM-DO-BLOCO" in out and code == 0, out


@BLOCKS
@SHELL_OPTIONS
def test_179_shell_options_keep_the_change_with_good_reads(
    tmp_path: Path, block: str, good_read: str, operation: str, options: str
) -> None:
    """The same options do not stop the block when both reads answer."""
    calls, out, code = _run(tmp_path, block, prelude=options, DS_OUT=good_read)

    names = [call[call.index("--role-name") + 1] for call in _changed(calls)]
    assert names == CLEAN_ROLES, out
    assert all(call[1] == operation for call in _changed(calls))
    assert REFUSED not in out
    assert "FIM-DO-BLOCO" in out and code == 0, out
