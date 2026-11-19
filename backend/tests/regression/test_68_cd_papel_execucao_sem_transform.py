"""O papel de execução da esteira não podia usar as transforms do template do app.

Erro observado (2026-11-18, primeira execução real da esteira na AWS): a stack
tomiyama-cd-dev foi criada com o infra/cd-pipeline.yaml do main e rodou com o commit
c603913. Source e Build passaram; a ação CreateChangeSet do estágio Deploy falhou, e o
change set codepipeline-changeset da stack tomiyama-dev ficou FAILED com este motivo
(conta mascarada):

    User: arn:aws:sts::<conta>:assumed-role/cd-tomiyama-dev-cfn-exec/AWSCloudFormation
    is not authorized to perform: cloudformation:CreateChangeSet on resource:
    arn:aws:cloudformation:us-east-2:aws:transform/LanguageExtensions because no
    identity-based policy allows the cloudformation:CreateChangeSet action

Com papel de serviço, o CloudFormation usa as credenciais do papel em toda operação da
stack ("CloudFormation always uses that role for all operations that are performed on
that stack", página "CloudFormation service role" do User Guide), inclusive na
conferência de cada transform do template, que é um cloudformation:CreateChangeSet no
ARN arn:<partição>:cloudformation:<região>:aws:transform/<nome> (exemplo 2 de "Control
access with IAM", User Guide). O infra/template.yaml declara AWS::LanguageExtensions e
AWS::Serverless-2016-10-31, e as duas passam por essa conferência, nessa ordem. Só o
PipelineRole tem a permissão (Sid AppTemplateTransforms); o CloudFormationExecutionRole
e as políticas gerenciadas anexadas a ele (ExecutionComputePolicy, ExecutionDataPolicy,
ExecutionIdentityApiPolicy) não têm.

Esperado: o papel de execução pode cloudformation:CreateChangeSet no ARN de cada
transform que o infra/template.yaml declara (lidas do próprio template, não fixas aqui),
e só nelas: nada de CreateChangeSet em stacks, em "*" ou em outra transform.
Issue: #68
"""

from typing import Any

import pytest
import test_cd_pipeline_template as cd_tests

ACCOUNT, REGION = cd_tests.ACCOUNT, cd_tests.REGION
CREATE_CHANGE_SET = "cloudformation:CreateChangeSet"

# The transforms hosted by CloudFormation (Transform reference, Template Reference
# Guide). Any of them that the app template does not declare must stay out of reach.
AWS_TRANSFORMS = [
    "AWS::CodeDeployBlueGreen",
    "AWS::Include",
    "AWS::LanguageExtensions",
    "AWS::SecretsManager-2020-07-23",
    "AWS::SecretsManager-2024-09-16",
    "AWS::Serverless-2016-10-31",
    "AWS::ServiceCatalog",
]


def _declared_transforms(template: dict[str, Any]) -> list[str]:
    """The Transform section plus the name of any Fn::Transform inside the template."""
    names = set(cd_tests._as_list(template.get("Transform", [])))

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if isinstance(node.get("Fn::Transform"), dict):
                names.add(node["Fn::Transform"]["Name"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk({key: value for key, value in template.items() if key != "Transform"})
    return sorted(names)


APP_TRANSFORMS = _declared_transforms(cd_tests._load(cd_tests.APP_TEMPLATE))


def _transform_arn(name: str) -> str:
    assert name.startswith("AWS::"), (
        f"infra/template.yaml passou a usar a macro {name}, que não é uma transform da AWS: "
        "uma macro própria tem outro ARN e pede lambda:InvokeFunction na função dela (visão "
        "geral das macros, User Guide do CloudFormation). Amplie este teste e o papel de "
        "execução da esteira antes de usá-la."
    )
    return f"arn:aws:cloudformation:{REGION}:aws:transform/{name.removeprefix('AWS::')}"


def _execution_role_documents(cd: dict[str, Any]) -> list[dict[str, Any]]:
    """Every policy the execution role carries: inline, managed policies of this
    template attached through their Roles or through the role's ManagedPolicyArns,
    and AWS::IAM::Policy / AWS::IAM::RolePolicy resources that name the role."""
    role = cd_tests.EXECUTION_ROLE
    resources = cd["Resources"]
    documents = cd_tests._policy_documents(cd, role)
    for ref in resources[role]["Properties"].get("ManagedPolicyArns", []):
        policy = resources.get(ref.get("Ref")) if isinstance(ref, dict) else None
        if policy and policy["Type"] == "AWS::IAM::ManagedPolicy":
            if {"Ref": role} not in policy["Properties"].get("Roles", []):
                documents.append(policy["Properties"]["PolicyDocument"])
    for resource in resources.values():
        props = resource.get("Properties", {})
        if resource["Type"] == "AWS::IAM::Policy" and {"Ref": role} in props.get("Roles", []):
            documents.append(props["PolicyDocument"])
        if resource["Type"] == "AWS::IAM::RolePolicy" and props.get("RoleName") == {"Ref": role}:
            documents.append(props["PolicyDocument"])
    return documents


def _execution_statements(cd: dict[str, Any]) -> list[dict[str, Any]]:
    resolver = cd_tests.Resolver(cd)
    return [
        resolver.resolve(statement)
        for document in _execution_role_documents(cd)
        for statement in cd_tests._as_list(document["Statement"])
    ]


@pytest.fixture(scope="module")
def cd() -> dict[str, Any]:
    return cd_tests._load(cd_tests.CD_TEMPLATE)


@pytest.mark.parametrize("transform", APP_TRANSFORMS)
def test_68_execution_role_creates_change_sets_on_each_app_transform(
    cd: dict[str, Any], transform: str
) -> None:
    arn = _transform_arn(transform)

    assert cd_tests._allows(_execution_statements(cd), CREATE_CHANGE_SET, arn), (
        f"O CloudFormationExecutionRole não tem {CREATE_CHANGE_SET} em {arn}. Com o papel de "
        f"serviço, o CloudFormation confere a transform {transform} do infra/template.yaml "
        "com as credenciais do papel, e o change set da esteira fica FAILED (not authorized "
        "to perform: cloudformation:CreateChangeSet on resource ...:transform/...). Libere a "
        "ação no papel de execução (infra/cd-pipeline.yaml), só nos ARNs das transforms."
    )


def test_68_execution_role_creates_change_sets_only_on_the_app_transforms(
    cd: dict[str, Any],
) -> None:
    """The fix must not let the execution role create change sets of any stack."""
    statements = _execution_statements(cd)
    declared = {_transform_arn(name) for name in APP_TRANSFORMS}
    other_transforms = [
        _transform_arn(name) for name in AWS_TRANSFORMS if _transform_arn(name) not in declared
    ]
    stack = f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{{}}/0a1b2c3d"
    stacks = [stack.format(name) for name in (cd_tests.APP, cd_tests.CD_STACK, "outra-stack")]
    star_statements = [
        statement.get("Sid")
        for statement in statements
        if statement["Effect"] == "Allow"
        and cd_tests._matches(statement.get("Action", []), CREATE_CHANGE_SET)
        and "*" in cd_tests._as_list(statement["Resource"])
    ]
    unchecked = [
        arn
        for arn in cd["Resources"][cd_tests.EXECUTION_ROLE]["Properties"].get(
            "ManagedPolicyArns", []
        )
        if not (isinstance(arn, dict) and arn.get("Ref") in cd["Resources"])
    ]

    assert APP_TRANSFORMS
    assert not star_statements, star_statements
    for arn in [*stacks, *other_transforms]:
        assert not cd_tests._allows(statements, CREATE_CHANGE_SET, arn), arn
    assert not unchecked, (
        f"O CloudFormationExecutionRole anexa políticas de fora deste template {unchecked}: "
        "este teste não consegue conferir o que elas liberam."
    )
