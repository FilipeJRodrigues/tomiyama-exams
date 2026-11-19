"""O README manda acrescentar --include-property-values a uma consulta que descarta os valores.

Erro observado (qa, 2026-11-19, reteste do #68): o passo 4 de "Criar a stack de CD", no
backend/README.md, diz "Para ver o antes e o depois de cada propriedade, como o texto das
políticas, acrescente `--include-property-values` ao `describe-change-set`, como em
'Confira as mudanças de IAM'". O único describe-change-set do caminho de update é o do
bloco logo acima, com
`--query "{Status: Status, StatusReason: StatusReason, Changes:
Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]}"`. A opção
acrescenta, em cada ResourceChange, o `Details[].Target` (com `BeforeValue` e
`AfterValue`) e o `BeforeContext`/`AfterContext` (modelo DescribeChangeSet do botocore),
mas a consulta só projeta as quatro colunas: a tabela sai igual, sem o texto de nenhuma
política. Quem segue a frase não vê o antes e o depois do CloudFormationExecutionRole (a
política inline app-template-transforms, a mudança que esse update existe para aplicar) e
pode executar achando que conferiu. O comando que mostra os valores, em "Confira as
mudanças de IAM", é de outra stack (tomiyama-dev) e de outro change set
(codepipeline-changeset), e o README não diz que é preciso trocar os dois.

Esperado: entre o create-change-set de update da stack de CD e o execute-change-set dele,
a seção traz um `aws cloudformation describe-change-set --stack-name tomiyama-cd-dev
--change-set-name <o mesmo nome> --include-property-values` cuja consulta, se houver,
mantém o antes e o depois das propriedades.
Issue: #68
"""

import json
import re
import shlex
from pathlib import Path

import botocore.session
import jmespath

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
CD_STACK = "tomiyama-cd-dev"
POLICY = "app-template-transforms"

# DescribeChangeSet with IncludePropertyValues: the execution role gains an inline policy.
CHANGE_SET_WITH_VALUES = {
    "Status": "CREATE_COMPLETE",
    "ExecutionStatus": "AVAILABLE",
    "Changes": [
        {
            "Type": "Resource",
            "ResourceChange": {
                "Action": "Modify",
                "LogicalResourceId": "CloudFormationExecutionRole",
                "ResourceType": "AWS::IAM::Role",
                "Replacement": "False",
                "Details": [
                    {
                        "Target": {
                            "Attribute": "Properties",
                            "Name": "Policies",
                            "Path": "/Properties/Policies/0",
                            "AttributeChangeType": "Add",
                            "BeforeValue": None,
                            "AfterValue": json.dumps({"PolicyName": POLICY}),
                        },
                        "Evaluation": "Static",
                        "ChangeSource": "DirectModification",
                    }
                ],
                "BeforeContext": json.dumps({"Properties": {"Policies": []}}),
                "AfterContext": json.dumps({"Properties": {"Policies": [{"PolicyName": POLICY}]}}),
            },
        }
    ],
}


def _section(markdown: str, title: str) -> str:
    start = markdown.index(f"\n### {title}\n")
    end = markdown.find("\n### ", start + 1)
    return markdown[start : end if end != -1 else len(markdown)]


def _cloudformation_commands(section: str) -> list[list[str]]:
    """The `aws cloudformation ...` commands of the section, in order: the lines of the
    code blocks (line breaks joined) and the inline code of the text."""
    text = re.sub(r"\\\n\s*", " ", section)
    commands, in_block = [], False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_block = not in_block
            continue
        if in_block:
            if stripped.startswith("aws cloudformation "):
                commands.append(shlex.split(stripped))
            continue
        for span in re.findall(r"`(aws cloudformation [^`]+)`", line):
            commands.append(shlex.split(span))
    return commands


def _option(command: list[str], name: str) -> str | None:
    for index, token in enumerate(command):
        if token == name and index + 1 < len(command):
            return command[index + 1]
        if token.startswith(f"{name}="):
            return token.split("=", 1)[1]
    return None


def _is(command: list[str], verb: str) -> bool:
    return command[2:3] == [verb]


def _shows_the_values(command: list[str]) -> bool:
    if "--include-property-values" not in command:
        return False
    query = _option(command, "--query")
    if query is None:
        return True
    return POLICY in json.dumps(jmespath.search(query, CHANGE_SET_WITH_VALUES))


def test_68_readme_shows_the_property_values_of_the_cd_stack_update() -> None:
    model = botocore.session.get_session().get_service_model("cloudformation")
    # Why the query matters: the option only adds fields; a projection can drop them.
    assert "IncludePropertyValues" in model.shape_for("DescribeChangeSetInput").members
    assert {"BeforeContext", "AfterContext", "Details"} <= set(
        model.shape_for("ResourceChange").members
    )
    assert {"BeforeValue", "AfterValue"} <= set(model.shape_for("ResourceTargetDefinition").members)

    commands = _cloudformation_commands(
        _section(README.read_text(encoding="utf-8"), "Criar a stack de CD")
    )
    updates = [
        index
        for index, command in enumerate(commands)
        if _is(command, "create-change-set")
        and _option(command, "--stack-name") == CD_STACK
        and _option(command, "--change-set-type") == "UPDATE"
    ]
    assert updates, "a seção 'Criar a stack de CD' deveria criar o change set de update"
    creation = updates[-1]
    name = _option(commands[creation], "--change-set-name")
    executions = [
        index
        for index in range(creation + 1, len(commands))
        if _is(commands[index], "execute-change-set")
        and _option(commands[index], "--stack-name") == CD_STACK
        and _option(commands[index], "--change-set-name") == name
    ]
    assert executions, f"a seção deveria executar o change set {name} da stack {CD_STACK}"
    describes = [
        command
        for command in commands[creation + 1 : executions[0]]
        if _is(command, "describe-change-set")
        and _option(command, "--stack-name") == CD_STACK
        and _option(command, "--change-set-name") == name
    ]

    assert any(_shows_the_values(command) for command in describes), (
        f"Antes de executar o change set {name} da stack {CD_STACK}, o README manda "
        "acrescentar --include-property-values ao describe-change-set para ver o antes e o "
        "depois das propriedades, mas o describe-change-set desse caminho tem um --query que "
        "só projeta Action, LogicalResourceId, ResourceType e Replacement: com a opção, a "
        "saída é a mesma, sem o texto das políticas. Dê o comando completo, com "
        f"'--stack-name {CD_STACK} --change-set-name {name} --include-property-values' e uma "
        "consulta que mantenha Details[].Target.BeforeValue/AfterValue ou "
        "BeforeContext/AfterContext (ou sem --query)."
    )
