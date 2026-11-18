"""Um deploy do app alcança os papéis e os buckets da esteira pelo papel de uma função.

Erro observado: o `CloudFormationExecutionRole` de `infra/cd-pipeline.yaml` mexe em
IAM só em `role/<AppStackName>-*`, e os papéis da esteira ficam em `role/cd/`. Mesmo
assim, nada limita **o que** ele pode dar a esses papéis. `iam:CreateRole` e
`iam:PutRolePolicy` aceitam qualquer política inline, sem permissions boundary, e
`iam:PassRole` entrega o papel à Lambda. Um commit do `main` que dê à `SeedFunction`
(`Policies` no `infra/template.yaml`) a política `iam:*` em `*` passa pela esteira assim:

1. o papel de execução grava essa política no papel da função;
2. o CloudFormation invoca a `SeedFunction` no `Custom::InitialData` do mesmo deploy;
3. o código da função grava `*` em `*` no próprio `cd-<AppStackName>-cfn-exec`, ou no
   papel do pipeline, ou apaga os buckets da esteira.

A negação `NeverManageTheCdBuckets` vale só para o papel de execução, não para os papéis
que ele cria. Assim, a afirmação do README ("um deploy do app não consegue alterar os
papéis da esteira, nem o próprio papel de execução") e o critério 5 do card ("os papéis
e os buckets do CD fora do alcance dele") não valem. O
`test_cd_roles_stay_outside_the_execution_role_scope` só confere o padrão do ARN.

Esperado: quando o papel de execução pode criar papéis ou mudar as políticas deles
(`CreateRole`, `PutRolePolicy`, `PutRolePermissionsBoundary` e o `AttachRolePolicy` que
não estiver preso a uma lista fixa por `iam:PolicyARN`), a permissão exige a condição
`iam:PermissionsBoundary`. A boundary é uma política
gerenciada da stack de CD que não deixa o papel da função mexer em IAM, nos papéis ou
nas políticas da esteira, nem nos buckets da esteira. O papel de execução não pode tirar
a boundary (`iam:DeleteRolePermissionsBoundary`), e as funções do app declaram
`PermissionsBoundary`. Outra saída aceita é o papel de execução não gravar política
nenhuma em papel.
Issue: #68
"""

from pathlib import Path
from typing import Any

import test_cd_pipeline_template as cd_tests
from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
ACCOUNT = cd_tests.ACCOUNT
APP = cd_tests.APP
FUNCTION_ROLE = f"arn:aws:iam::{ACCOUNT}:role/{APP}-SeedFunctionRole-AbC123dEf456"
ROLE_WRITES = (
    "iam:CreateRole",
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:PutRolePermissionsBoundary",
)
IAM_ON_ROLES = (
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:UpdateAssumeRolePolicy",
    "iam:DeleteRolePermissionsBoundary",
    "iam:DeleteRole",
)
S3_WRITES = ("s3:PutObject", "s3:DeleteObject", "s3:DeleteBucket", "s3:PutBucketPolicy")


def _load(path: Path) -> dict[str, Any]:
    parsed, errors = decode(str(path))
    assert not errors, errors
    return parsed


class Resolver(cd_tests.Resolver):
    """Also resolves managed policy ARNs and Fn::If (conditions with parameter defaults)."""

    def __init__(self, template: dict[str, Any]) -> None:
        super().__init__(template)
        self.conditions = template.get("Conditions", {})

    def ref(self, name: str) -> str:
        resource = self.resources.get(name)
        if resource and resource["Type"] == "AWS::IAM::ManagedPolicy":
            props = resource["Properties"]
            path = self.resolve(props.get("Path", "/"))
            return f"arn:aws:iam::{ACCOUNT}:policy{path}{self.resolve(props['ManagedPolicyName'])}"
        return super().ref(name)

    def condition(self, node: Any) -> bool:
        if isinstance(node, dict) and len(node) == 1:
            ((key, value),) = node.items()
            if key == "Condition":
                return self.condition(self.conditions[value])
            if key == "Fn::Equals":
                left, right = (self.resolve(v) for v in value)
                return str(left) == str(right)
            if key == "Fn::Not":
                return not self.condition(value[0])
            if key == "Fn::And":
                return all(self.condition(v) for v in value)
            if key == "Fn::Or":
                return any(self.condition(v) for v in value)
        raise KeyError(f"condição sem avaliação: {node}")

    def resolve(self, node: Any) -> Any:
        if isinstance(node, dict) and set(node) == {"Fn::If"}:
            name, when_true, when_false = node["Fn::If"]
            return self.resolve(when_true if self.condition(self.conditions[name]) else when_false)
        return super().resolve(node)


def _statements(resolver: Resolver, documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [resolver.resolve(statement) for doc in documents for statement in doc["Statement"]]


def _grants(statement: dict[str, Any], action: str, resource: str) -> bool:
    if statement["Effect"] != "Allow":
        return False
    if "Action" in statement:
        action_ok = cd_tests._matches(statement["Action"], action)
    else:
        action_ok = not cd_tests._matches(statement["NotAction"], action)
    return action_ok and cd_tests._matches(statement["Resource"], resource)


def _fixed_managed_policies(statement: dict[str, Any]) -> bool:
    """AttachRolePolicy limited to a fixed list of policies (iam:PolicyARN equality)."""
    for operator, keys in statement.get("Condition", {}).items():
        if operator in ("ArnEquals", "StringEquals"):
            if any(key.lower() == "iam:policyarn" for key in keys):
                return True
    return False


def _boundary(statement: dict[str, Any]) -> list[str]:
    values = []
    for operator, keys in statement.get("Condition", {}).items():
        if operator.startswith(("StringEquals", "ArnEquals", "ArnLike", "StringLike")):
            for key, value in keys.items():
                if key.lower() == "iam:permissionsboundary":
                    values.extend(cd_tests._as_list(value))
    return values


def test_function_roles_created_by_a_deploy_cannot_reach_the_cd() -> None:
    cd = _load(ROOT / "infra" / "cd-pipeline.yaml")
    app = _load(ROOT / "infra" / "template.yaml")
    resolver = Resolver(cd)
    statements = _statements(resolver, cd_tests._policy_documents(cd, cd_tests.EXECUTION_ROLE))

    writes = [
        (action, statement)
        for action in ROLE_WRITES
        for statement in statements
        if _grants(statement, action, FUNCTION_ROLE)
    ]
    # Attaching only a fixed list of managed policies (AWSLambdaBasicExecutionRole,
    # checked by test_execution_role_iam_actions_stay_in_the_app_prefix) is no way up.
    unbounded = sorted(
        {
            (action, s.get("Sid"))
            for action, s in writes
            if not _boundary(s)
            and not (action == "iam:AttachRolePolicy" and _fixed_managed_policies(s))
        }
    )
    assert not unbounded, (
        "O papel de execução grava papéis do app sem permissions boundary "
        f"({unbounded}): um commit do main que dê iam:* a uma função alcança os papéis e os "
        "buckets da esteira pelo papel dela."
    )
    assert not cd_tests._allows(statements, "iam:DeleteRolePermissionsBoundary", FUNCTION_ROLE)

    boundaries = {arn for _, statement in writes for arn in _boundary(statement)}
    if not boundaries:
        return  # the execution role writes no policy on any role
    policies = {
        resolver.ref(name): resource
        for name, resource in cd["Resources"].items()
        if resource["Type"] == "AWS::IAM::ManagedPolicy"
    }
    cd_roles = [resolver.get_att(role, "Arn") for role in cd_tests.ROLE_SERVICES]
    cd_buckets = [resolver.get_att(b, "Arn") for b in ("ArtifactsBucket", "PackagesBucket")]
    for arn in boundaries:
        assert arn in policies, f"a boundary {arn} deveria ser uma política da stack de CD"
        limits = _statements(resolver, [policies[arn]["Properties"]["PolicyDocument"]])
        for role in cd_roles:
            for action in IAM_ON_ROLES:
                assert not cd_tests._allows(limits, action, role), (arn, action, role)
        for policy in policies:
            assert not cd_tests._allows(limits, "iam:CreatePolicyVersion", policy), (arn, policy)
        for bucket in cd_buckets:
            for action in S3_WRITES:
                assert not cd_tests._allows(limits, action, bucket), (arn, action, bucket)
                assert not cd_tests._allows(limits, action, f"{bucket}/{APP}/x"), (arn, action)

    globals_boundary = app.get("Globals", {}).get("Function", {}).get("PermissionsBoundary")
    without = [
        name
        for name, resource in app["Resources"].items()
        if resource["Type"] == "AWS::Serverless::Function"
        and not (globals_boundary or resource["Properties"].get("PermissionsBoundary"))
    ]
    assert not without, f"funções sem PermissionsBoundary no infra/template.yaml: {without}"
