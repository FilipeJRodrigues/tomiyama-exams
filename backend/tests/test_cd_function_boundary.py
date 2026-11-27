"""Permissions boundary of the function roles (card #179).

The CloudFormation execution role of the pipeline (``infra/cd-pipeline.yaml``) creates
the function roles of the app and writes their policies. Without a limit, a commit on
main that gave a function broad permissions would let that function reach the CD stack
indirectly (the SeedFunction runs inside the deploy, through Custom::InitialData). The
CD stack now creates ``FunctionBoundaryPolicy``, the boundary of every function role:

- the execution role creates a role, writes its policies, attaches a managed policy,
  changes its trust policy or sets a boundary only when that policy is the role's
  boundary (``iam:PermissionsBoundary``), and never removes a boundary;
- the boundary allows only what the functions use today, on the app's resources,
  nothing in IAM or STS, and explicitly denies every resource of the CD stack;
- the app template takes its ARN in ``FunctionPermissionsBoundary`` (empty: no
  boundary, the manual deploy without the CD stack) and sets it on every role.

The policies of every function, with the SAM policy templates expanded (the app is
transformed offline, as in test_cd_pipeline_template.py), must fit the boundary,
action and resource: a missing grant only shows up in AWS, as AccessDenied when the
function runs. No test here calls AWS.
"""

import copy
import json
import re
from typing import Any

import pytest
import test_cd_pipeline_template as cd_tests

ACCOUNT, REGION, APP, CD_STACK = cd_tests.ACCOUNT, cd_tests.REGION, cd_tests.APP, cd_tests.CD_STACK
BOUNDARY = "FunctionBoundaryPolicy"
PARAMETER = "FunctionPermissionsBoundary"
CONDITION = "HasFunctionPermissionsBoundary"
FUNCTION_ROLE = f"arn:aws:iam::{ACCOUNT}:role/{APP}-SeedFunctionRole-AbC123dEf456"
BASIC_EXECUTION = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
NO_VALUE = object()  # Ref AWS::NoValue: the property is dropped

# What gives a function role permissions (or lets another principal use them): only
# with the boundary. iam:PermissionsBoundary is a condition key of each of them
# (Service Authorization Reference, IAM).
BOUNDED_ACTIONS = (
    "iam:CreateRole",
    "iam:PutRolePolicy",
    "iam:PutRolePermissionsBoundary",
    "iam:AttachRolePolicy",
    "iam:UpdateAssumeRolePolicy",
)
# What the execution role may do on a function role without the boundary condition:
# reads, and changes that grant nothing (a role of a deploy before #179 still has to
# lose a policy or be deleted). PassRole has no iam:PermissionsBoundary key.
UNBOUNDED_ACTIONS = {
    "iam:deleterole",
    "iam:getrole",
    "iam:updaterole",
    "iam:updateroledescription",
    "iam:tagrole",
    "iam:untagrole",
    "iam:listroletags",
    "iam:getrolepolicy",
    "iam:deleterolepolicy",
    "iam:listrolepolicies",
    "iam:listattachedrolepolicies",
    "iam:detachrolepolicy",
    "iam:passrole",
}
POLICY_CHANGES = (
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "iam:DeletePolicy",
    "iam:DeletePolicyVersion",
    "iam:TagPolicy",
    "iam:UntagPolicy",
)
IAM_ON_ROLES = (
    "iam:PutRolePolicy",
    "iam:AttachRolePolicy",
    "iam:UpdateAssumeRolePolicy",
    "iam:PutRolePermissionsBoundary",
    "iam:DeleteRolePermissionsBoundary",
    "iam:DeleteRolePolicy",
    "iam:DeleteRole",
    "sts:AssumeRole",
)
S3_WRITES = (
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:DeleteBucket",
    "s3:PutBucketPolicy",
    "s3:PutLifecycleConfiguration",
)


@pytest.fixture(scope="module")
def cd() -> dict[str, Any]:
    return cd_tests._load(cd_tests.CD_TEMPLATE)


@pytest.fixture(scope="module")
def app() -> dict[str, Any]:
    return cd_tests._load(cd_tests.APP_TEMPLATE)


# ------------------------------------------------------------------ helpers
def _boundary_arn(cd: dict[str, Any], stack_name: str = CD_STACK) -> str:
    return cd_tests.Resolver(cd, stack_name).ref(BOUNDARY)


def _boundary_statements(cd: dict[str, Any], stack_name: str = CD_STACK) -> list[dict[str, Any]]:
    resolver = cd_tests.Resolver(cd, stack_name)
    document = cd["Resources"][BOUNDARY]["Properties"]["PolicyDocument"]
    return [resolver.resolve(statement) for statement in cd_tests._as_list(document["Statement"])]


def _covers(statement: dict[str, Any], action: str, resource: str) -> bool:
    if "Action" in statement:
        action_ok = cd_tests._matches(statement["Action"], action)
    else:
        action_ok = not cd_tests._matches(statement["NotAction"], action)
    if "Resource" in statement:
        resource_ok = cd_tests._matches(statement["Resource"], resource)
    else:
        resource_ok = not cd_tests._matches(statement["NotResource"], resource)
    return action_ok and resource_ok


def _denies(statements: list[dict[str, Any]], action: str, resource: str) -> bool:
    """An explicit Deny covers it (conditions ignored; the boundary has none)."""
    return any(s["Effect"] == "Deny" and _covers(s, action, resource) for s in statements)


def _granting(statements: list[dict[str, Any]], action: str, resource: str) -> list[dict[str, Any]]:
    return [s for s in statements if s["Effect"] == "Allow" and _covers(s, action, resource)]


def _boundary_condition(statement: dict[str, Any]) -> list[str]:
    """The ARNs an ArnEquals/StringEquals condition on iam:PermissionsBoundary demands."""
    values: list[str] = []
    for operator, keys in statement.get("Condition", {}).items():
        if operator in ("ArnEquals", "StringEquals"):
            for key, value in keys.items():
                if key.lower() == "iam:permissionsboundary":
                    values.extend(cd_tests._as_list(value))
    return values


def _cd_resources(cd: dict[str, Any], stack_name: str = CD_STACK) -> dict[str, list[str]]:
    """ARNs of the resources of the CD stack, by kind (fake account and Region)."""
    resolver = cd_tests.Resolver(cd, stack_name)
    resources = cd["Resources"]
    pipeline = f"arn:aws:codepipeline:{REGION}:{ACCOUNT}:{resolver.ref('Pipeline')}"
    connection = resolver.get_att("GitHubConnection", "ConnectionArn")
    log_group = f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:{resolver.ref('BuildLogGroup')}"
    buckets = [
        resolver.get_att(name, "Arn")
        for name, resource in resources.items()
        if resource["Type"] == "AWS::S3::Bucket"
    ]
    return {
        "roles": [
            resolver.get_att(name, "Arn")
            for name, resource in resources.items()
            if resource["Type"] == "AWS::IAM::Role"
        ],
        "policies": [
            resolver.ref(name)
            for name, resource in resources.items()
            if resource["Type"] == "AWS::IAM::ManagedPolicy"
        ],
        "buckets": buckets,
        "objects": [f"{bucket}/{APP}/0123456789abcdef" for bucket in buckets],
        "build": [resolver.get_att("BuildProject", "Arn")],
        "logs": [log_group, f"{log_group}:log-stream:build/0a1b2c3d"],
        "pipeline": [pipeline, f"{pipeline}/Deploy/ApproveChangeSet"],
        "connection": [
            connection,
            connection.replace(":codeconnections:", ":codestar-connections:"),
        ],
        "stack": [f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{stack_name}/0a1b2c3d"],
    }


# Representative actions on each kind of resource of the CD stack.
CD_ACTIONS = {
    "roles": IAM_ON_ROLES,
    "policies": POLICY_CHANGES,
    "buckets": ("s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration"),
    "objects": ("s3:GetObject", "s3:PutObject", "s3:DeleteObject"),
    "build": ("codebuild:UpdateProject", "codebuild:StartBuild", "codebuild:DeleteProject"),
    "logs": ("logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:PutLogEvents"),
    "pipeline": (
        "codepipeline:UpdatePipeline",
        "codepipeline:PutApprovalResult",
        "codepipeline:StartPipelineExecution",
    ),
    "connection": ("codeconnections:UseConnection", "codestar-connections:UseConnection"),
    "stack": ("cloudformation:UpdateStack", "cloudformation:DeleteStack"),
}


class AppResolver(cd_tests.Resolver):
    """Resolves the transformed app template with fake physical names, shaped like
    the ones CloudFormation generates for the dev stack, and the given parameters."""

    def __init__(self, template: dict[str, Any], parameters: dict[str, str]) -> None:
        self.resources = template["Resources"]
        self.conditions = template.get("Conditions", {})
        self.stack_name = APP
        self.values = {
            "AWS::AccountId": ACCOUNT,
            "AWS::Region": REGION,
            "AWS::Partition": "aws",
            "AWS::StackName": APP,
        }
        for name, parameter in template.get("Parameters", {}).items():
            self.values[name] = str(parameter.get("Default", f"<{name}>"))
        self.values.update(parameters)

    def ref(self, name: str) -> Any:
        if name == "AWS::NoValue":
            return NO_VALUE
        if name in self.values:
            return self.values[name]
        resource = self.resources[name]
        kind, props = resource["Type"], resource.get("Properties", {})
        if kind == "AWS::S3::Bucket":
            return f"{APP}-{name.lower()}-abc123def456"
        if kind in ("AWS::DynamoDB::Table", "AWS::Lambda::Function", "AWS::IAM::Role"):
            return f"{APP}-{name}-AbC123dEf456"
        if kind == "AWS::Cognito::UserPool":
            return f"{REGION}_AbC123dEf"
        if kind == "AWS::Logs::LogGroup":
            return self.resolve(props["LogGroupName"])
        raise KeyError(f"Ref sem valor fictício para {name} ({kind})")

    def get_att(self, name: str, attribute: str) -> str:
        kind = self.resources[name]["Type"]
        arns = {
            "AWS::DynamoDB::Table": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/{{}}",
            "AWS::S3::Bucket": "arn:aws:s3:::{}",
            "AWS::Lambda::Function": f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{{}}",
            "AWS::Cognito::UserPool": f"arn:aws:cognito-idp:{REGION}:{ACCOUNT}:userpool/{{}}",
            "AWS::IAM::Role": f"arn:aws:iam::{ACCOUNT}:role/{{}}",
            "AWS::Logs::LogGroup": f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:{{}}:*",
        }
        if attribute == "Arn" and kind in arns:
            return arns[kind].format(self.ref(name))
        raise KeyError(f"GetAtt sem valor fictício para {name}.{attribute} ({kind})")

    def condition(self, node: Any) -> bool:
        if isinstance(node, dict) and len(node) == 1:
            ((key, value),) = node.items()
            if key == "Condition":
                return self.condition(self.conditions[value])
            if key == "Fn::Equals":
                left, right = (self.resolve(item) for item in value)
                return str(left) == str(right)
            if key == "Fn::Not":
                return not self.condition(value[0])
            if key == "Fn::And":
                return all(self.condition(item) for item in value)
            if key == "Fn::Or":
                return any(self.condition(item) for item in value)
        raise KeyError(f"condição sem avaliação: {node}")

    def resolve(self, node: Any) -> Any:
        if isinstance(node, dict) and list(node) == ["Fn::If"]:
            name, when_true, when_false = node["Fn::If"]
            return self.resolve(when_true if self.condition(self.conditions[name]) else when_false)
        return super().resolve(node)


def _transformed(app: dict[str, Any]) -> dict[str, Any]:
    """The app as CloudFormation deploys it (both transforms, offline)."""
    return json.loads(cd_tests._transformed(json.dumps(app)))


def _identity_statements(transformed: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """(owner, statement) of every identity policy the app writes: the inline policies
    of its roles and any AWS::IAM::Policy or AWS::IAM::RolePolicy resource."""
    found = []
    for name, resource in transformed["Resources"].items():
        props = resource.get("Properties", {})
        documents = []
        if resource["Type"] == "AWS::IAM::Role":
            documents = [policy["PolicyDocument"] for policy in props.get("Policies", [])]
        elif resource["Type"] in ("AWS::IAM::Policy", "AWS::IAM::RolePolicy"):
            documents = [props["PolicyDocument"]]
        for document in documents:
            found.extend((name, s) for s in cd_tests._as_list(document["Statement"]))
    return found


def _log_group_uses(transformed: dict[str, Any], resolver: AppResolver) -> dict[str, list]:
    """For each function role, the (action, resource) pairs AWSLambdaBasicExecutionRole
    is there for: the log group each of its functions writes to (LoggingConfig, or
    Lambda's default /aws/lambda/<function>)."""
    uses: dict[str, list[tuple[str, str]]] = {}
    for name, resource in transformed["Resources"].items():
        if resource["Type"] != "AWS::Lambda::Function":
            continue
        props = resource["Properties"]
        assert isinstance(props["Role"], dict) and "Fn::GetAtt" in props["Role"], (
            f"{name} usa um papel que não é da stack ({props['Role']}): este teste só confere "
            "o limite nos papéis que o app cria."
        )
        role = props["Role"]["Fn::GetAtt"][0]
        group = props.get("LoggingConfig", {}).get("LogGroup")
        group = resolver.resolve(group) if group else f"/aws/lambda/{resolver.ref(name)}"
        arn = f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:{group}"
        stream = f"{arn}:log-stream:2026/11/26/[$LATEST]0123456789abcdef"
        uses.setdefault(role, []).extend(
            [
                ("logs:CreateLogGroup", arn),
                ("logs:CreateLogStream", stream),
                ("logs:PutLogEvents", stream),
            ]
        )
    return uses


def _outside_the_boundary(cd: dict[str, Any], app: dict[str, Any]) -> list[str]:
    """Every grant of a function role that the boundary would cut: (owner, action,
    resource) of each inline statement, and the uses of each managed policy."""
    boundary = _boundary_statements(cd)
    transformed = _transformed(app)
    resolver = AppResolver(transformed, {PARAMETER: _boundary_arn(cd)})
    missing = []
    for owner, statement in _identity_statements(transformed):
        if statement.get("Effect") == "Deny":
            continue  # a Deny only takes away
        if "Action" not in statement or "Resource" not in statement:
            missing.append(f"{owner}: NotAction/NotResource não dá para conferir no limite")
            continue
        actions = cd_tests._as_list(statement["Action"])
        resources = cd_tests._as_list(resolver.resolve(statement["Resource"]))
        for action in actions:
            for resource in resources:
                if not isinstance(resource, str) or not cd_tests._allows(
                    boundary, action, resource
                ):
                    missing.append(f"{owner}: {action} em {resource}")
    uses = _log_group_uses(transformed, resolver)
    for name, resource in transformed["Resources"].items():
        if resource["Type"] != "AWS::IAM::Role":
            continue
        for arn in resource["Properties"].get("ManagedPolicyArns", []):
            arn = cd_tests._static(arn)
            if arn != BASIC_EXECUTION:
                missing.append(f"{name}: política gerenciada {arn}, que este teste não conhece")
                continue
            for action, target in uses.get(name, []):
                if not cd_tests._allows(boundary, action, target):
                    missing.append(f"{name}: {action} em {target} ({arn})")
    return missing


# ------------------------------------------------------------------ the boundary policy
def test_179_boundary_is_a_managed_policy_of_the_cd_stack_attached_to_no_one(
    cd: dict[str, Any],
) -> None:
    """A boundary grants nothing; attached to a role it would become a permission.
    No Description, and the name and path stay: changing any of them replaces the
    policy (new ARN) while the function roles still use the old one."""
    resource = cd["Resources"][BOUNDARY]
    props = resource["Properties"]

    assert resource["Type"] == "AWS::IAM::ManagedPolicy"
    assert not {"Roles", "Users", "Groups", "Description"} & set(props)
    assert props["Path"] == "/cd/"
    assert props["ManagedPolicyName"] == {"Fn::Sub": "cd-${AppStackName}-function-boundary"}
    assert _boundary_arn(cd) == f"arn:aws:iam::{ACCOUNT}:policy/cd/cd-{APP}-function-boundary"


def test_179_boundary_allows_nothing_in_iam_or_sts(cd: dict[str, Any]) -> None:
    statements = _boundary_statements(cd)
    allows = [s for s in statements if s["Effect"] == "Allow"]
    actions = [a.lower() for s in allows for a in cd_tests._as_list(s["Action"])]

    assert allows and all("Action" in s and "Resource" in s for s in allows)
    assert not [a for a in actions if a.startswith(("iam:", "sts:"))], actions
    assert not [a for a in actions if "*" in a], actions  # explicit actions only
    for statement in allows:
        assert "*" not in cd_tests._as_list(statement["Resource"]), statement.get("Sid")
    for action in ("iam:PutRolePolicy", "iam:PassRole", "iam:CreateUser", "sts:AssumeRole"):
        assert _denies(statements, action, "*"), action


def test_179_boundary_grants_only_on_the_app_resources(cd: dict[str, Any]) -> None:
    """Allows by the stack name prefix of the app (pool ids are random: the pools of
    the account and Region), never on another stack's resources."""
    statements = _boundary_statements(cd)
    other = "outra-app"
    for statement in statements:
        if statement["Effect"] != "Allow":
            continue
        for resource in cd_tests._as_list(statement["Resource"]):
            assert (
                f"/{APP}-" in resource
                or f":::{APP}-" in resource
                or f":function:{APP}-" in resource
                or f":log-group:/aws/lambda/{APP}" in resource
                or resource == f"arn:aws:cognito-idp:{REGION}:{ACCOUNT}:userpool/*"
            ), (statement.get("Sid"), resource)
    table = f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/{other}-BeltsTable-X"
    assert not cd_tests._allows(statements, "dynamodb:GetItem", table)
    assert not cd_tests._allows(statements, "s3:GetObject", f"arn:aws:s3:::{other}-b/logos/a")
    assert not cd_tests._allows(
        statements, "lambda:InvokeFunction", f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{other}-F"
    )
    # Objects only, never the bucket itself.
    assert not cd_tests._allows(statements, "s3:DeleteBucket", cd_tests.IMAGES)
    assert not cd_tests._allows(statements, "s3:PutBucketPolicy", cd_tests.IMAGES)


@pytest.mark.parametrize(
    "stack_name", [CD_STACK, f"{APP}-cd"], ids=["nome-sugerido", "nome-do-app"]
)
def test_179_boundary_denies_every_resource_of_the_cd_stack(
    cd: dict[str, Any], stack_name: str
) -> None:
    """Explicit Deny, not only the absence of an Allow: it also wins over a
    resource-based policy granting a function's role session, and over a CD stack
    named "<AppStackName>-..." (its buckets would fall in the app's S3 grant). Each
    resource has a Deny of every action ("*") of its own, not only the IAM/STS one:
    an action of a service the test does not list is denied too."""
    statements = _boundary_statements(cd, stack_name)
    resources = _cd_resources(cd, stack_name)

    assert _boundary_arn(cd, stack_name) in resources["policies"]
    assert len(resources["roles"]) == 3 and len(resources["buckets"]) == 2
    for kind, arns in resources.items():
        for arn in arns:
            assert _denies(statements, "qualquer-servico:QualquerAcao", arn), (kind, arn)
            for action in CD_ACTIONS[kind]:
                assert _denies(statements, action, arn), (kind, action, arn)
                assert not cd_tests._allows(statements, action, arn), (kind, action, arn)


def test_179_function_roles_created_by_a_deploy_cannot_reach_the_cd(cd: dict[str, Any]) -> None:
    """The escalation of the QA of #68 (test_68_cd_escalada_pelo_papel_de_funcao.py):
    a commit gives the SeedFunction iam:* and s3:* on "*". Its effective permissions
    are the intersection with the boundary, so it changes no role, policy or bucket of
    the CD stack."""
    boundary = _boundary_statements(cd)
    granted = [{"Effect": "Allow", "Action": ["iam:*", "s3:*", "*"], "Resource": "*"}]
    resources = _cd_resources(cd)

    def effective(action: str, resource: str) -> bool:
        return cd_tests._allows(granted, action, resource) and cd_tests._allows(
            boundary, action, resource
        )

    for role in resources["roles"]:
        for action in IAM_ON_ROLES:
            assert not effective(action, role), (action, role)
    for policy in resources["policies"]:
        for action in POLICY_CHANGES:
            assert not effective(action, policy), (action, policy)
    for bucket in resources["buckets"]:
        for action in S3_WRITES:
            assert not effective(action, bucket), (action, bucket)
            assert not effective(action, f"{bucket}/{APP}/x"), (action, bucket)
    assert not effective("iam:PutRolePolicy", FUNCTION_ROLE)  # nor its own role


# ------------------------------------------------------------------ the execution role
@pytest.mark.parametrize("action", BOUNDED_ACTIONS)
def test_179_execution_role_writes_function_roles_only_with_the_boundary(
    cd: dict[str, Any], action: str
) -> None:
    statements = cd_tests._statements(cd, cd_tests.EXECUTION_ROLE)
    granting = _granting(statements, action, FUNCTION_ROLE)

    assert granting, f"o papel de execução precisa de {action} nos papéis das funções"
    for statement in granting:
        assert _boundary_condition(statement) == [_boundary_arn(cd)], (
            f"{action} ({statement.get('Sid')}) sem a condição iam:PermissionsBoundary igual "
            "ao ARN do FunctionBoundaryPolicy: um deploy daria a um papel de função qualquer "
            "permissão (#179)."
        )


def test_179_execution_role_iam_without_boundary_grants_nothing(cd: dict[str, Any]) -> None:
    """Every other IAM action of the execution role is a read or a change that grants
    nothing. An IAM action added without the condition fails here until someone
    weighs it (and adds it to BOUNDED_ACTIONS or to UNBOUNDED_ACTIONS)."""
    loose = sorted(
        {
            action.lower()
            for statement in cd_tests._statements(cd, cd_tests.EXECUTION_ROLE)
            if statement["Effect"] == "Allow" and not _boundary_condition(statement)
            for action in cd_tests._as_list(statement["Action"])
            if action.lower().startswith("iam:")
        }
    )

    assert set(loose) <= UNBOUNDED_ACTIONS, sorted(set(loose) - UNBOUNDED_ACTIONS)


def test_179_execution_role_never_removes_a_boundary(cd: dict[str, Any]) -> None:
    statements = cd_tests._statements(cd, cd_tests.EXECUTION_ROLE)
    for statement in statements:
        if statement["Effect"] == "Allow":
            assert not cd_tests._matches(
                statement["Action"], "iam:DeleteRolePermissionsBoundary"
            ), statement.get("Sid")


def test_179_execution_role_cannot_change_the_boundary_policy(cd: dict[str, Any]) -> None:
    """No IAM permission on the boundary (nor a policy change on any managed policy).
    The statements on "*" are the actions IAM has no resource type for, none of IAM."""
    statements = cd_tests._statements(cd, cd_tests.EXECUTION_ROLE)
    policies = _cd_resources(cd)["policies"] + [f"arn:aws:iam::{ACCOUNT}:policy/{APP}-x"]

    for statement in statements:
        actions = [a.lower() for a in cd_tests._as_list(statement.get("Action", []))]
        if statement["Effect"] == "Allow" and any(
            a == "*" or a.startswith("iam:") for a in actions
        ):
            assert not cd_tests._matches(statement["Resource"], _boundary_arn(cd)), statement.get(
                "Sid"
            )
    for policy in policies:
        for action in POLICY_CHANGES:
            assert not cd_tests._allows(statements, action, policy), (action, policy)


# ------------------------------------------------------------------ the pipeline
def test_179_pipeline_passes_the_boundary_to_the_app(cd: dict[str, Any]) -> None:
    action = cd_tests._flat_actions(cd)[2]
    overrides = json.loads(
        cd_tests.Resolver(cd).resolve(action["Configuration"]["ParameterOverrides"])
    )

    assert overrides.get(PARAMETER) == _boundary_arn(cd)
    assert cd["Outputs"]["FunctionPermissionsBoundaryArn"]["Value"] == {"Ref": BOUNDARY}


# ------------------------------------------------------------------ the app template
def test_179_app_takes_the_boundary_as_an_optional_parameter(app: dict[str, Any]) -> None:
    """Empty by default: a manual deploy without the CD stack works as before."""
    parameter = app["Parameters"][PARAMETER]
    pattern = parameter["AllowedPattern"]

    assert parameter["Type"] == "String" and parameter["Default"] == ""
    for value in ("", f"arn:aws:iam::{ACCOUNT}:policy/cd/cd-{APP}-function-boundary"):
        assert re.fullmatch(pattern, value), value
    for value in ("x", f"arn:aws:iam::{ACCOUNT}:role/cd/x", "arn:aws:iam::aws:policy/ x"):
        assert not re.fullmatch(pattern, value), value
    assert app["Conditions"][CONDITION] == {"Fn::Not": [{"Fn::Equals": [{"Ref": PARAMETER}, ""]}]}
    assert app["Globals"]["Function"].get("PermissionsBoundary") == {
        "Fn::If": [CONDITION, {"Ref": PARAMETER}, {"Ref": "AWS::NoValue"}]
    }


@pytest.mark.parametrize("value", ["arn", ""], ids=["com-o-limite", "sem-o-limite"])
def test_179_every_role_of_the_app_gets_the_boundary_from_the_parameter(
    cd: dict[str, Any], app: dict[str, Any], value: str
) -> None:
    """Every AWS::IAM::Role of the transformed template, the ones SAM generates for
    the functions and any explicit one, takes the boundary when the parameter is set,
    and none when it is empty. The execution role refuses CreateRole without it."""
    transformed = _transformed(app)
    arn = _boundary_arn(cd) if value == "arn" else ""
    resolver = AppResolver(transformed, {PARAMETER: arn})
    roles = {
        name: resource["Properties"]
        for name, resource in transformed["Resources"].items()
        if resource["Type"] == "AWS::IAM::Role"
    }
    functions = [
        r for r in transformed["Resources"].values() if r["Type"] == "AWS::Lambda::Function"
    ]
    principals = [
        name
        for name, resource in transformed["Resources"].items()
        if resource["Type"] in ("AWS::IAM::User", "AWS::IAM::Group")
    ]

    assert "SeedFunctionRole" in roles and len(roles) >= len(functions) > 0
    assert not principals, principals
    for name, props in roles.items():
        boundary = resolver.resolve(props.get("PermissionsBoundary", {"Ref": "AWS::NoValue"}))
        expected = arn if arn else NO_VALUE
        assert boundary == expected, (
            f"{name} fica sem o limite de permissões (#179): use PermissionsBoundary com o "
            f"!If {CONDITION} do Globals.Function do infra/template.yaml."
        )


def test_179_every_function_policy_fits_the_boundary(
    cd: dict[str, Any], app: dict[str, Any]
) -> None:
    """Each action on each resource of each function role (inline statements with the
    SAM policy templates expanded, and the log group AWSLambdaBasicExecutionRole is
    there for) is allowed by the boundary. Otherwise the deploy passes and the
    function fails with AccessDenied when it runs."""
    missing = _outside_the_boundary(cd, app)

    assert not missing, (
        "O limite de permissões dos papéis das funções (FunctionBoundaryPolicy, em "
        "infra/cd-pipeline.yaml) não cobre o que estas funções usam; a função falharia com "
        "AccessDenied. Amplie o limite (só nos recursos do app) e atualize a stack de CD "
        f"antes do deploy do app: {missing}"
    )


@pytest.mark.parametrize(
    ("statement", "expected"),
    [
        (
            {"Effect": "Allow", "Action": "iam:PutRolePolicy", "Resource": "*"},
            "iam:PutRolePolicy em *",
        ),
        (
            {"Effect": "Allow", "Action": "s3:DeleteBucket", "Resource": f"arn:aws:s3:::{APP}-*"},
            f"s3:DeleteBucket em arn:aws:s3:::{APP}-*",
        ),
        (
            {
                "Effect": "Allow",
                "Action": "dynamodb:DeleteTable",
                "Resource": {"Fn::GetAtt": ["BeltsTable", "Arn"]},
            },
            "dynamodb:DeleteTable em",
        ),
        (
            {"Effect": "Allow", "Action": "sqs:SendMessage", "Resource": "*"},
            "sqs:SendMessage em *",
        ),
    ],
    ids=["iam", "bucket", "tabela", "servico-novo"],
)
def test_179_boundary_check_catches_a_grant_outside_it(
    cd: dict[str, Any], app: dict[str, Any], statement: dict[str, Any], expected: str
) -> None:
    """The check above is not vacuous: a statement added to the SeedFunction's
    Policies that the boundary cuts shows up in it."""
    changed = copy.deepcopy(app)
    changed["Resources"]["SeedFunction"]["Properties"]["Policies"].append(
        {"Statement": [statement]}
    )

    missing = _outside_the_boundary(cd, changed)

    assert any(item.startswith("SeedFunctionRole: ") and expected in item for item in missing), (
        missing
    )


def test_179_boundary_check_catches_another_log_group(
    cd: dict[str, Any], app: dict[str, Any]
) -> None:
    """Without the shared log group, Lambda writes to /aws/lambda/<function>, which
    the boundary does not cover: the check must see it."""
    changed = copy.deepcopy(app)
    del changed["Globals"]["Function"]["LoggingConfig"]

    missing = _outside_the_boundary(cd, changed)

    assert any("logs:PutLogEvents" in item and "/aws/lambda/" in item for item in missing)
