"""QA coverage: the AWS CLI commands written in ``backend/README.md`` (card #68).

The README is the runbook of the deploys (the CD stack, the pipeline, the approval), and
its commands are only run by hand, against the real account. A typo in an operation, a
waiter or an option shows up only then. Checked offline, against the botocore model
(the same one the AWS CLI is built from):

- every ``aws <service> <operation>`` exists, and every ``aws <service> wait <waiter>``
  is a waiter of that service;
- every ``--option`` is a member of the input of the operation (of the waiter's
  operation, for ``wait``) or a global option of the CLI;
- every ``--query`` is valid JMESPath, and every ``--output`` is a format of the CLI;
- every field a ``--query`` names exists in the output of its operation, and every
  literal it compares with an enum field is a value of that enum (card #179: the
  runbook reads the boundary ARN from the outputs of the CD stack and the roles of the
  app from its resources; a misspelt field gives an empty list, not an error, and the
  loop of the runbook would then set no boundary).

Commands of the high-level CLI customizations (``aws s3 ...``, ``aws cloudformation
deploy`` and the like) are not in the model and are skipped.
"""

import re
import shlex
from pathlib import Path
from typing import Any

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


# ------------------------------------------------------------------ fields of --query
class _ListOf:
    """The list a projection yields, of the shape its right side gives each item."""

    type_name = "list"

    def __init__(self, member: Any) -> None:
        self.member = member


def _query_problems(node: dict[str, Any], shape: Any, problems: list[str]) -> Any:
    """Walks the JMESPath AST over the botocore output shape; returns the shape of the
    result (None when unknown) and appends each field that is not in its structure and
    each literal compared with an enum field that is not one of its values."""
    kind, children = node["type"], node.get("children", [])

    def walk(child: dict[str, Any], current: Any) -> Any:
        return _query_problems(child, current, problems)

    def item(current: Any) -> Any:
        return current.member if getattr(current, "type_name", None) == "list" else None

    if kind == "field":
        if shape is None:
            return None
        if shape.type_name != "structure" or node["value"] not in shape.members:
            names = sorted(shape.members) if shape.type_name == "structure" else shape.type_name
            problems.append(f"{node['value']} não existe em {shape.name} ({names})")
            return None
        return shape.members[node["value"]]
    if kind == "subexpression":
        for child in children:
            shape = walk(child, shape)
        return shape
    if kind == "index_expression":
        return item(walk(children[0], shape))
    if kind in ("index", "slice", "identity", "current"):
        return shape
    if kind == "flatten":
        return walk(children[0], shape)
    if kind == "projection":
        return _ListOf(walk(children[1], item(walk(children[0], shape))))
    if kind == "filter_projection":
        element = item(walk(children[0], shape))
        walk(children[2], element)
        return _ListOf(walk(children[1], element))
    if kind == "comparator":
        shapes = [walk(child, shape) for child in children]
        literals = [child["value"] for child in children if child["type"] == "literal"]
        for found in shapes:
            for literal in literals:
                if getattr(found, "enum", None) and literal not in found.enum:
                    problems.append(f"{literal!r} não é valor de {found.name} ({found.enum})")
        return None
    if kind == "pipe":
        return walk(children[1], walk(children[0], shape))
    if kind in ("multi_select_hash", "multi_select_dict"):
        for pair in children:
            walk(pair["children"][0], shape)
        return None
    if kind in (
        "multi_select_list",
        "function_expression",
        "and_expression",
        "or_expression",
        "not_expression",
    ):
        for child in children:
            walk(child, shape)
        return None
    if kind == "literal":
        return None
    problems.append(f"nó {kind} da consulta que este teste não sabe conferir")
    return None


def test_readme_aws_cli_queries_name_fields_of_the_output(
    commands: list[tuple[int, list[str]]],
) -> None:
    """A query with a misspelt field (or an enum value that does not exist) is valid
    JMESPath and runs: it prints nothing. The runbook of #179 feeds such outputs to a
    loop ("for ROLE in $ROLES"), which would then do nothing without an error."""
    session = botocore.session.get_session()
    problems, checked = [], 0
    for line, tokens in commands:
        if "--query" not in tokens or tokens[2] == "wait":
            continue
        model = session.get_service_model(tokens[1])
        operations = {xform_name(name, "-"): name for name in model.operation_names}
        output = model.operation_model(operations[tokens[2]]).output_shape
        query = tokens[tokens.index("--query") + 1]
        found: list[str] = []
        _query_problems(jmespath.compile(query).parsed, output, found)
        problems.extend(f"linha {line} ({tokens[1]} {tokens[2]}): {p}" for p in found)
        checked += 1

    assert checked >= 10, checked  # the reader still finds the runbook's queries
    assert not problems, "consultas do README que não acham o que procuram:\n" + "\n".join(problems)


@pytest.mark.parametrize(
    ("operation", "query", "expected"),
    [
        (
            ("cloudformation", "ListStackResources"),
            "StackResourceSummaries[?ResourceType=='AWS::IAM::Role'].PhysicalResourceIds",
            "PhysicalResourceIds não existe",
        ),
        (
            ("cloudformation", "DescribeStacks"),
            "Stacks[0].Output[?OutputKey=='FunctionPermissionsBoundaryArn'].OutputValue",
            "Output não existe",
        ),
        (
            ("cloudformation", "ListStackResources"),
            "StackResourceSummaries[?ResourceStatus=='UPDATE_FAIL'].LogicalResourceId",
            "'UPDATE_FAIL' não é valor",
        ),
    ],
    ids=["campo-do-item", "campo-da-stack", "enum"],
)
def test_query_field_check_catches_a_misspelt_query(
    operation: tuple[str, str], query: str, expected: str
) -> None:
    """The check above is not vacuous."""
    model = botocore.session.get_session().get_service_model(operation[0])
    found: list[str] = []
    _query_problems(
        jmespath.compile(query).parsed, model.operation_model(operation[1]).output_shape, found
    )

    assert any(expected in problem for problem in found), found
