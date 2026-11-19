"""QA coverage: the AWS CLI commands written in ``backend/README.md`` (card #68).

The README is the runbook of the deploys (the CD stack, the pipeline, the approval), and
its commands are only run by hand, against the real account. A typo in an operation, a
waiter or an option shows up only then. Checked offline, against the botocore model
(the same one the AWS CLI is built from):

- every ``aws <service> <operation>`` exists, and every ``aws <service> wait <waiter>``
  is a waiter of that service;
- every ``--option`` is a member of the input of the operation (of the waiter's
  operation, for ``wait``) or a global option of the CLI;
- every ``--query`` is valid JMESPath, and every ``--output`` is a format of the CLI.

Commands of the high-level CLI customizations (``aws s3 ...``, ``aws cloudformation
deploy`` and the like) are not in the model and are skipped.
"""

import re
import shlex
from pathlib import Path

import botocore.session
import jmespath
import pytest
from botocore import xform_name
from botocore.exceptions import UnknownServiceError

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "backend" / "README.md"

GLOBAL_OPTIONS = {
    "region",
    "profile",
    "output",
    "query",
    "debug",
    "endpoint-url",
    "no-verify-ssl",
    "no-paginate",
    "no-cli-pager",
    "cli-input-json",
    "cli-input-yaml",
    "cli-binary-format",
    "cli-read-timeout",
    "cli-connect-timeout",
    "color",
    "no-sign-request",
    "ca-bundle",
    "page-size",
    "max-items",
    "starting-token",
    "generate-cli-skeleton",
}
OUTPUT_FORMATS = {"json", "text", "table", "yaml", "yaml-stream"}
# High-level customizations of the CLI, not operations of the model.
CUSTOM_COMMANDS = {
    ("s3", None),
    ("configure", None),
    ("cloudformation", "deploy"),
    ("cloudformation", "package"),
}


def _commands(markdown: str) -> list[tuple[int, list[str]]]:
    """(line, tokens) of each ``aws ...`` command: code block lines, with the line breaks
    (``\\``) joined, and inline code of the text."""
    found: list[tuple[int, list[str]]] = []
    in_block, pending, start = False, "", 0
    for number, line in enumerate(markdown.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_block, pending = not in_block, ""
            continue
        if in_block:
            if not pending and not stripped.startswith("aws "):
                continue
            if not pending:
                start = number
            pending = f"{pending} {stripped}".strip()
            if pending.endswith("\\"):
                pending = pending[:-1].rstrip()
                continue
            found.append((start, shlex.split(pending)))
            pending = ""
            continue
        for span in re.findall(r"`(aws [^`]+)`", line):
            found.append((number, shlex.split(span)))
    return found


def _is_custom(service: str, verb: str) -> bool:
    return (service, None) in CUSTOM_COMMANDS or (service, verb) in CUSTOM_COMMANDS


@pytest.fixture(scope="module")
def commands() -> list[tuple[int, list[str]]]:
    found = [
        (line, tokens)
        for line, tokens in _commands(README.read_text(encoding="utf-8"))
        if len(tokens) >= 3 and not _is_custom(tokens[1], tokens[2])
    ]
    assert any(tokens[1] == "cloudformation" for _, tokens in found), (
        "nenhum comando 'aws cloudformation' encontrado no README: o leitor dos comandos "
        "deste teste deixou de achá-los"
    )
    return found


def test_readme_aws_cli_commands_use_existing_operations_waiters_and_options(
    commands: list[tuple[int, list[str]]],
) -> None:
    session = botocore.session.get_session()
    problems = []
    for line, tokens in commands:
        service, verb = tokens[1], tokens[2]
        try:
            model = session.get_service_model(service)
        except UnknownServiceError:
            problems.append(f"linha {line}: o serviço '{service}' não existe na AWS CLI")
            continue
        if verb == "wait":
            waiters = session.get_waiter_model(service)
            names = {xform_name(name, "-"): name for name in waiters.waiter_names}
            if len(tokens) < 4 or tokens[3] not in names:
                problems.append(f"linha {line}: '{service} wait' não tem o waiter {tokens[3:4]}")
                continue
            operation, options = waiters.get_waiter(names[tokens[3]]).operation, tokens[4:]
        else:
            operations = {xform_name(name, "-"): name for name in model.operation_names}
            if verb not in operations:
                problems.append(f"linha {line}: '{service}' não tem a operação '{verb}'")
                continue
            operation, options = operations[verb], tokens[3:]
        shape = model.operation_model(operation).input_shape
        members = {xform_name(name, "-") for name in (shape.members if shape else {})}
        command = " ".join(tokens[1 : len(tokens) - len(options)])
        for token in options:
            if not token.startswith("--"):
                continue
            name = token[2:].split("=", 1)[0]
            bare = name.removeprefix("no-")
            if name not in GLOBAL_OPTIONS and bare not in members:
                problems.append(f"linha {line}: '{command}' não aceita --{name}")

    assert not problems, "comandos do README que a AWS CLI recusaria:\n" + "\n".join(problems)


def test_readme_aws_cli_queries_and_output_formats_are_valid(
    commands: list[tuple[int, list[str]]],
) -> None:
    problems = []
    for line, tokens in commands:
        for index, token in enumerate(tokens[:-1]):
            value = tokens[index + 1]
            if token == "--query":
                try:
                    jmespath.compile(value)
                except jmespath.exceptions.JMESPathError as error:
                    problems.append(f"linha {line}: --query inválido ({error})")
            if token == "--output" and value not in OUTPUT_FORMATS:
                problems.append(f"linha {line}: --output {value} não é um formato da AWS CLI")

    assert not problems, "consultas e formatos inválidos no README:\n" + "\n".join(problems)
