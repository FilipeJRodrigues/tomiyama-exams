"""Guards for ``infra/cd-pipeline.yaml``, the CD stack of the backend (card #68).

The deploy runs inside AWS (CodePipeline V2 + CodeBuild + CodeConnections) because
the managed SCP of the project denies ``iam:*Provider*`` (no GitHub OIDC; see #177).
These tests read both templates with ``cfnlint.decode`` and never call AWS. ARNs are
resolved with fake values (account ``123456789012``, Region ``us-east-2``) and
compared with the IAM patterns of the policies. The app template is also transformed
offline, as CloudFormation does it (``AWS::LanguageExtensions`` from cfn-lint, then
the SAM transform from aws-sam-translator), so the guards see every resource and
managed policy SAM generates. The commit check of the build runs for real, with bash
and git against local repositories (no network).
"""

import fnmatch
import functools
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import boto3
import pytest
import yaml
from cfnlint.decode import decode
from cfnlint.template import Template
from cfnlint.template.transforms._language_extensions import language_extension
from samtranslator.metrics.metrics import Metrics
from samtranslator.parser.parser import Parser
from samtranslator.public.exceptions import InvalidDocumentException
from samtranslator.translator.translator import Translator

ROOT = Path(__file__).resolve().parents[2]
CD_TEMPLATE = ROOT / "infra" / "cd-pipeline.yaml"
APP_TEMPLATE = ROOT / "infra" / "template.yaml"

ACCOUNT = "123456789012"
REGION = "us-east-2"
CD_STACK = "tomiyama-cd-dev"
APP = "tomiyama-dev"

PIPELINE_ROLE = "PipelineRole"
BUILD_ROLE = "BuildRole"
EXECUTION_ROLE = "CloudFormationExecutionRole"
ROLE_SERVICES = {
    PIPELINE_ROLE: "codepipeline.amazonaws.com",
    BUILD_ROLE: "codebuild.amazonaws.com",
    EXECUTION_ROLE: "cloudformation.amazonaws.com",
}

# Actions whose IAM authorization has no resource type (Service Authorization
# Reference), the only ones allowed on Resource "*".
NO_RESOURCE_LEVEL = {
    "cloudformation:validatetemplate",
    "cognito-idp:createuserpool",
    "logs:describeloggroups",
    "logs:describeindexpolicies",
    "logs:describeresourcepolicies",
}

EMAIL = re.compile(r"[\w.+-]+@([\w-]+\.)+\w+")
ACCOUNT_ID = re.compile(r"(?<!\d)\d{12}(?!\d)")
SERVICE_WILDCARD = re.compile(r"^[a-z0-9-]+:\*$")


# ------------------------------------------------------------------ helpers
def _load(path: Path) -> dict[str, Any]:
    parsed, errors = decode(str(path))
    assert not errors, errors
    return parsed


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


class Resolver:
    """Resolves Ref, Fn::Sub and Fn::GetAtt of the CD template to fake values."""

    def __init__(self, template: dict[str, Any], stack_name: str = CD_STACK) -> None:
        self.resources = template["Resources"]
        self.values: dict[str, str] = {
            "AWS::AccountId": ACCOUNT,
            "AWS::Region": REGION,
            "AWS::Partition": "aws",
            "AWS::StackName": stack_name,
        }
        for name, parameter in template["Parameters"].items():
            self.values[name] = str(parameter.get("Default", f"<{name}>"))
        self.stack_name = stack_name

    def ref(self, name: str) -> str:
        if name in self.values:
            return self.values[name]
        resource = self.resources[name]
        kind, props = resource["Type"], resource.get("Properties", {})
        if kind == "AWS::S3::Bucket":
            return f"{self.stack_name}-{name.lower()}-abc123def456"
        if kind == "AWS::IAM::Role":
            return self.resolve(props["RoleName"])
        if kind == "AWS::CodeBuild::Project":
            return self.resolve(props["Name"])
        if kind == "AWS::Logs::LogGroup":
            return self.resolve(props["LogGroupName"])
        if kind == "AWS::CodePipeline::Pipeline":
            return self.resolve(props["Name"])
        if kind == "AWS::IAM::ManagedPolicy":  # Ref is the ARN
            partition, path = self.values["AWS::Partition"], self.resolve(props.get("Path", "/"))
            policy = self.resolve(props["ManagedPolicyName"])
            return f"arn:{partition}:iam::{ACCOUNT}:policy{path}{policy}"
        raise KeyError(f"Ref sem valor fictício para {name} ({kind})")

    def get_att(self, name: str, attribute: str) -> str:
        resource = self.resources[name]
        kind, props = resource["Type"], resource.get("Properties", {})
        if kind == "AWS::S3::Bucket" and attribute == "Arn":
            return f"arn:aws:s3:::{self.ref(name)}"
        if kind == "AWS::IAM::Role" and attribute == "Arn":
            path = self.resolve(props.get("Path", "/"))
            return f"arn:aws:iam::{ACCOUNT}:role{path}{self.ref(name)}"
        if kind == "AWS::CodeConnections::Connection" and attribute == "ConnectionArn":
            return f"arn:aws:codeconnections:{REGION}:{ACCOUNT}:connection/0a1b2c3d"
        if kind == "AWS::CodeBuild::Project" and attribute == "Arn":
            return f"arn:aws:codebuild:{REGION}:{ACCOUNT}:project/{self.ref(name)}"
        if kind == "AWS::Logs::LogGroup" and attribute == "Arn":
            return f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:{self.ref(name)}:*"
        raise KeyError(f"GetAtt sem valor fictício para {name}.{attribute} ({kind})")

    def sub(self, value: Any) -> str:
        text, variables = (value[0], value[1]) if isinstance(value, list) else (value, {})

        def replace(match: re.Match[str]) -> str:
            key = match.group(1)
            if key.startswith("!"):
                return "${" + key[1:] + "}"
            if key in variables:
                return str(self.resolve(variables[key]))
            if "." in key:
                resource, attribute = key.split(".", 1)
                return self.get_att(resource, attribute)
            return self.ref(key)

        return re.sub(r"\$\{([^}]+)\}", replace, text)

    def resolve(self, node: Any) -> Any:
        if isinstance(node, dict) and len(node) == 1:
            ((key, value),) = node.items()
            if key == "Ref":
                return self.ref(value)
            if key == "Fn::Sub":
                return self.sub(value)
            if key == "Fn::GetAtt":
                resource, attribute = value if isinstance(value, list) else value.split(".", 1)
                return self.get_att(resource, attribute)
        if isinstance(node, dict):
            return {key: self.resolve(value) for key, value in node.items()}
        if isinstance(node, list):
            return [self.resolve(value) for value in node]
        return node


def _policy_documents(template: dict[str, Any], role: str) -> list[dict[str, Any]]:
    """Inline policies of the role plus the managed policies attached to it."""
    resources = template["Resources"]
    documents = [p["PolicyDocument"] for p in resources[role]["Properties"].get("Policies", [])]
    for resource in resources.values():
        if resource["Type"] == "AWS::IAM::ManagedPolicy" and {"Ref": role} in resource[
            "Properties"
        ].get("Roles", []):
            documents.append(resource["Properties"]["PolicyDocument"])
    return documents


def _statements(template: dict[str, Any], role: str) -> list[dict[str, Any]]:
    resolver = Resolver(template)
    return [
        resolver.resolve(statement)
        for document in _policy_documents(template, role)
        for statement in document["Statement"]
    ]


def _matches(patterns: Any, value: str) -> bool:
    return any(fnmatch.fnmatchcase(value.lower(), p.lower()) for p in _as_list(patterns))


def _allows(statements: list[dict[str, Any]], action: str, resource: str) -> bool:
    """Allowed by some Allow statement and by no Deny (conditions ignored)."""

    def covers(statement: dict[str, Any]) -> bool:
        if "Action" in statement:
            action_ok = _matches(statement["Action"], action)
        else:
            action_ok = not _matches(statement["NotAction"], action)
        return action_ok and _matches(statement["Resource"], resource)

    allowed = any(s["Effect"] == "Allow" and covers(s) for s in statements)
    denied = any(s["Effect"] == "Deny" and covers(s) for s in statements)
    return allowed and not denied


def _actions(statements: list[dict[str, Any]]) -> list[str]:
    return [a.lower() for s in statements if s["Effect"] == "Allow" for a in _as_list(s["Action"])]


def _flat_actions(template: dict[str, Any]) -> list[dict[str, Any]]:
    """Pipeline actions in execution order: (stage index, RunOrder)."""
    stages = template["Resources"]["Pipeline"]["Properties"]["Stages"]
    ordered = []
    for index, stage in enumerate(stages):
        for action in stage["Actions"]:
            ordered.append((index, int(action.get("RunOrder", 1)), stage["Name"], action))
    ordered.sort(key=lambda item: (item[0], item[1]))
    return [{"stage": name, "run_order": run, **action} for _, run, name, action in ordered]


@pytest.fixture(scope="module")
def cd() -> dict[str, Any]:
    return _load(CD_TEMPLATE)


@pytest.fixture(scope="module")
def app() -> dict[str, Any]:
    return _load(APP_TEMPLATE)


# ------------------------------------------------------------------ pipeline
def test_pipeline_is_v2_queued_and_has_no_trigger(cd: dict[str, Any]) -> None:
    pipeline = cd["Resources"]["Pipeline"]["Properties"]
    source = _flat_actions(cd)[0]

    assert pipeline["PipelineType"] == "V2"
    assert pipeline["ExecutionMode"] == "QUEUED"
    assert pipeline["RestartExecutionOnUpdate"] is False
    assert "Triggers" not in pipeline
    assert source["ActionTypeId"]["Provider"] == "CodeStarSourceConnection"
    assert str(source["Configuration"]["DetectChanges"]).lower() == "false"
    assert source["Configuration"]["OutputArtifactFormat"] == "CODEBUILD_CLONE_REF"


def test_pipeline_runs_source_build_change_set_approval_execute(cd: dict[str, Any]) -> None:
    steps = [
        (a["ActionTypeId"]["Provider"], a.get("Configuration", {}).get("ActionMode"))
        for a in _flat_actions(cd)
    ]

    assert steps == [
        ("CodeStarSourceConnection", None),
        ("CodeBuild", None),
        ("CloudFormation", "CHANGE_SET_REPLACE"),
        ("Manual", None),
        ("CloudFormation", "CHANGE_SET_EXECUTE"),
    ]


def test_change_set_approval_and_execution_share_one_locked_stage(cd: dict[str, Any]) -> None:
    """In QUEUED mode a stage is locked while an execution is in it. With the
    approval in a stage of its own, a second run could replace the change set
    (same name) while the first one waits, and the approval would execute a
    change set nobody reviewed."""
    replace, approval, execute = _flat_actions(cd)[2:]

    assert replace["stage"] == approval["stage"] == execute["stage"]
    assert [replace["run_order"], approval["run_order"], execute["run_order"]] == [1, 2, 3]


def test_change_set_actions_use_the_same_change_set_and_the_execution_role(
    cd: dict[str, Any],
) -> None:
    replace, approval, execute = _flat_actions(cd)[2:]
    create_config, execute_config = replace["Configuration"], execute["Configuration"]

    assert create_config["ChangeSetName"] == execute_config["ChangeSetName"]
    assert create_config["StackName"] == execute_config["StackName"] == {"Ref": "AppStackName"}
    assert create_config["RoleArn"] == {"Fn::GetAtt": [EXECUTION_ROLE, "Arn"]}
    assert set(create_config["Capabilities"].split(",")) == {
        "CAPABILITY_IAM",
        "CAPABILITY_AUTO_EXPAND",
    }
    assert cd["Parameters"]["AppStackName"]["Default"] == APP
    assert "codepipeline-changeset" in Resolver(cd).resolve(approval["Configuration"]["CustomData"])


def test_change_set_parameters_cover_the_app_template(
    cd: dict[str, Any], app: dict[str, Any]
) -> None:
    """Every parameter of the app goes in ParameterOverrides (CodePipeline does not
    reuse the stack's previous values), and nothing the app does not declare."""
    replace = _flat_actions(cd)[2]
    overrides = json.loads(Resolver(cd).resolve(replace["Configuration"]["ParameterOverrides"]))

    assert set(overrides) == set(app["Parameters"])
    assert len(json.dumps(overrides)) < 1024  # 1 KB limit of ParameterOverrides


# The five values at their longest (see the MaxLength comment of AllowedOrigin).
# BudgetLimitUsd is bounded by its AllowedPattern: 7 integer digits, a point and
# 2 decimals, 10 characters. The ARN of the function boundary (#179) grows with
# AppStackName (its AllowedPattern: up to 25 characters) and the partition
# (aws-us-gov is the longest).
LONGEST_BUDGET = "9999999.99"
LONGEST_PARTITION = "aws-us-gov"


def _longest(cd: dict[str, Any], parameter: str, unit: str) -> str:
    size = int(cd["Parameters"][parameter]["MaxLength"])
    return (unit * size)[:size]


def test_parameter_overrides_fit_codepipeline_with_the_longest_values(cd: dict[str, Any]) -> None:
    """CodePipeline takes at most 1,000 characters in an action configuration value
    (quotas) and 1 KB in the ParameterOverrides JSON (CloudFormation action
    reference). MaxLength on AdminEmail (254, the longest address SMTP carries) and
    on AllowedOrigin, the AllowedPattern of BudgetLimitUsd (10 characters) and the
    AllowedPattern of AppStackName (the ARN of the function boundary, #179) keep the
    resolved JSON under both, whatever the stack gets."""
    email_pattern = cd["Parameters"]["AdminEmail"]["AllowedPattern"]
    origin_pattern = cd["Parameters"]["AllowedOrigin"]["AllowedPattern"]
    budget_pattern = cd["Parameters"]["BudgetLimitUsd"]["AllowedPattern"]
    stack_pattern = cd["Parameters"]["AppStackName"]["AllowedPattern"]
    domain = "@example.com"
    email = _longest(cd, "AdminEmail", "a")[: -len(domain)] + domain
    origins = _longest(cd, "AllowedOrigin", "http://localhost:5173,")
    app_stack = "t" * 25
    resolver = Resolver(cd)
    resolver.values.update(
        {
            "AWS::Partition": LONGEST_PARTITION,
            "AppStackName": app_stack,
            "Environment": max(cd["Parameters"]["Environment"]["AllowedValues"], key=len),
            "AdminEmail": email,
            "AllowedOrigin": origins,
            "BudgetLimitUsd": LONGEST_BUDGET,
        }
    )
    text = resolver.resolve(_flat_actions(cd)[2]["Configuration"]["ParameterOverrides"])
    boundary = json.loads(text)["FunctionPermissionsBoundary"]

    assert int(cd["Parameters"]["AdminEmail"]["MaxLength"]) == 254
    assert len(email) == 254 and re.fullmatch(email_pattern, email)
    assert len(origins) == int(cd["Parameters"]["AllowedOrigin"]["MaxLength"])
    assert re.fullmatch(origin_pattern, origins)
    assert len(LONGEST_BUDGET) == 10 and re.fullmatch(budget_pattern, LONGEST_BUDGET)
    assert len(app_stack) == 25 and re.fullmatch(stack_pattern, app_stack)
    assert not re.fullmatch(stack_pattern, app_stack + "t")  # 25 is the longest
    assert boundary.startswith(f"arn:{LONGEST_PARTITION}:iam::") and app_stack in boundary
    assert json.loads(text)["AllowedOrigin"] == origins
    assert json.loads(text)["BudgetLimitUsd"] == LONGEST_BUDGET
    assert len(text) <= 1000, len(text)
    assert len(text.encode("utf-8")) <= 1024


def test_budget_limit_is_a_decimal_of_at_most_10_characters(cd: dict[str, Any]) -> None:
    """ParameterOverrides passes every value as text, so BudgetLimitUsd is a String
    whose AllowedPattern bounds its size (a Number takes neither AllowedPattern nor
    MaxLength): up to 7 integer digits and 2 decimals, no sign. The default stays
    valid."""
    parameter = cd["Parameters"]["BudgetLimitUsd"]
    pattern = parameter["AllowedPattern"]

    assert parameter["Type"] == "String"
    assert re.fullmatch(pattern, str(parameter["Default"]))
    for value in ("1", "10", "12.5", "1234567.99", "0", LONGEST_BUDGET):
        assert re.fullmatch(pattern, value), value
    for value in (
        "1e9",
        "-1",
        "1.234",
        "12345678",
        "12345678.5",
        "99999999.99",
        "1.",
        ".5",
        "1,5",
        "+1",
        " 1",
        "",
    ):
        assert not re.fullmatch(pattern, value), value


def test_allowed_origin_is_ascii_so_its_length_is_its_size(cd: dict[str, Any]) -> None:
    """Only AdminEmail may be non-ASCII in ParameterOverrides, and no real address
    passes 254 octets: an origin with accents would cost two bytes per character."""
    pattern = cd["Parameters"]["AllowedOrigin"]["AllowedPattern"]

    assert re.fullmatch(pattern, "http://localhost:5173,https://main.d1a2b3c4.amplifyapp.com")
    for value in ("https://ação.example.com", "HTTP://LOCALHOST", "http://a b", 'http://"x"'):
        assert not re.fullmatch(pattern, value), value


def test_build_output_is_the_template_the_change_set_reads(cd: dict[str, Any]) -> None:
    build, replace = _flat_actions(cd)[1:3]
    spec = yaml.safe_load(cd["Resources"]["BuildProject"]["Properties"]["Source"]["BuildSpec"])
    artifact, template_file = replace["Configuration"]["TemplatePath"].split("::")

    assert [a["Name"] for a in build["OutputArtifacts"]] == [artifact]
    assert spec["artifacts"]["files"] == [template_file]


# ------------------------------------------------------------------ buildspec
def test_buildspec_is_inline_and_only_builds_commits_of_main(cd: dict[str, Any]) -> None:
    project = cd["Resources"]["BuildProject"]["Properties"]
    spec = yaml.safe_load(project["Source"]["BuildSpec"])
    pre_build = "\n".join(spec["phases"]["pre_build"]["commands"])
    variables = {v["Name"]: v["Value"] for v in project["Environment"]["EnvironmentVariables"]}

    assert project["Source"]["Type"] == "CODEPIPELINE"
    assert spec["env"]["git-credential-helper"] in (True, "yes")
    assert variables["MAIN_BRANCH"] == {"Ref": "BranchName"}
    assert 'git fetch --quiet --no-tags origin "+refs/heads/$MAIN_BRANCH' in pre_build
    assert 'git merge-base --is-ancestor "$COMMIT" "origin/$MAIN_BRANCH"' in pre_build
    assert "não está no histórico do $MAIN_BRANCH" in pre_build
    assert 'git rev-list --first-parent "origin/$MAIN_BRANCH"' in pre_build
    assert "veio de dentro de uma branch mesclada" in pre_build
    assert "exit 1" in pre_build


def test_buildspec_checks_the_commit_before_installing_the_sam_cli(cd: dict[str, Any]) -> None:
    """CodeBuild runs install, pre_build and build in this order, and a failed
    pre_build skips build. The check stays in pre_build and the SAM CLI is installed
    only in build: a refused run spends no build minutes on pip."""
    spec = yaml.safe_load(cd["Resources"]["BuildProject"]["Properties"]["Source"]["BuildSpec"])
    phases = spec["phases"]
    early = "\n".join(
        command
        for phase in ("install", "pre_build")
        for command in phases[phase].get("commands", [])
    )
    build = phases["build"]["commands"]
    pip = [index for index, command in enumerate(build) if "pip install" in command]
    sam_build = [index for index, command in enumerate(build) if "sam build" in command]

    assert "git merge-base --is-ancestor" in early and "--first-parent" in early
    assert "pip install" not in early and "/tmp/sam-cli" not in early
    assert pip and sam_build and pip[0] < sam_build[0]


def test_buildspec_runs_pinned_sam_build_and_package(cd: dict[str, Any]) -> None:
    project = cd["Resources"]["BuildProject"]["Properties"]
    spec = yaml.safe_load(project["Source"]["BuildSpec"])
    build = "\n".join(spec["phases"]["build"]["commands"])

    assert str(spec["phases"]["install"]["runtime-versions"]["python"]) == "3.12"
    assert '"aws-sam-cli==$SAM_CLI_VERSION"' in build  # installed in build, after the check
    assert re.fullmatch(r"\d+\.\d+\.\d+", cd["Parameters"]["SamCliVersion"]["Default"])
    assert "sam build --template-file template.yaml" in build
    assert '--s3-bucket "$PACKAGES_BUCKET"' in build
    assert '--output-template-file "$CODEBUILD_SRC_DIR/packaged.yaml"' in build


def test_build_runs_on_the_smallest_machine_with_a_timeout(cd: dict[str, Any]) -> None:
    project = cd["Resources"]["BuildProject"]["Properties"]

    assert project["Environment"]["ComputeType"] == "BUILD_GENERAL1_SMALL"
    assert 5 <= project["TimeoutInMinutes"] <= 30
    assert project["LogsConfig"]["CloudWatchLogs"]["GroupName"] == {"Ref": "BuildLogGroup"}


# ------------------------------------------------------------------ main check, run with git
def _bash() -> str | None:
    """bash, or on Windows the Git Bash next to git (never the WSL bash.exe)."""
    if sys.platform != "win32":
        return shutil.which("bash")
    git = shutil.which("git")
    if not git:
        return None
    for parent in list(Path(git).resolve().parents)[:3]:
        for candidate in (parent / "bin" / "bash.exe", parent / "usr" / "bin" / "bash.exe"):
            if candidate.exists():
                return str(candidate)
    return None


BASH = _bash()
needs_bash_and_git = pytest.mark.skipif(
    BASH is None or shutil.which("git") is None, reason="sem bash ou git no ambiente"
)


def _git(env: dict[str, str], *args: str, cwd: Path | None = None) -> str:
    done = subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=60
    )
    assert done.returncode == 0, (args, done.stderr)
    return done.stdout.strip()


def _commit(env: dict[str, str], repo: Path, name: str) -> str:
    (repo / f"{name}.txt").write_text(name, encoding="utf-8")
    _git(env, "add", ".", cwd=repo)
    _git(env, "commit", "-q", "-m", name, cwd=repo)
    return _git(env, "rev-parse", "HEAD", cwd=repo)


@pytest.fixture(scope="module")
def merged_main(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """A bare "GitHub" whose main is: a direct commit (a), then the merge commit of a
    PR (merge) whose branch has two commits (f1, f2). f1 and f2 are in the history
    of main, but not on its first-parent line (a <- merge)."""
    if BASH is None or shutil.which("git") is None:
        pytest.skip("sem bash ou git no ambiente")
    base = tmp_path_factory.mktemp("cd-first-parent")
    config = base / "gitconfig"
    config.write_text("", encoding="utf-8")
    env = {
        **os.environ,
        "GIT_CONFIG_GLOBAL": str(config),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "cd",
        "GIT_AUTHOR_EMAIL": "cd@example.com",
        "GIT_COMMITTER_NAME": "cd",
        "GIT_COMMITTER_EMAIL": "cd@example.com",
        "GIT_TERMINAL_PROMPT": "0",
    }
    bare, seed = base / "origin.git", base / "seed"
    _git(env, "init", "-q", "--bare", "-b", "main", str(bare))
    _git(env, "init", "-q", "-b", "main", str(seed))
    _git(env, "remote", "add", "origin", str(bare), cwd=seed)
    a = _commit(env, seed, "a")
    _git(env, "checkout", "-q", "-b", "feature", cwd=seed)
    f1 = _commit(env, seed, "f1")
    f2 = _commit(env, seed, "f2")
    _git(env, "checkout", "-q", "main", cwd=seed)
    _git(env, "merge", "-q", "--no-ff", "-m", "Merge pull request #1", "feature", cwd=seed)
    merge = _git(env, "rev-parse", "HEAD", cwd=seed)
    _git(env, "push", "-q", "origin", "main", cwd=seed)
    return {"base": base, "env": env, "bare": bare, "a": a, "f1": f1, "f2": f2, "merge": merge}


def _run_main_check(
    cd: dict[str, Any], origin: dict[str, Any], commit: str, source_commit: str
) -> subprocess.CompletedProcess[str]:
    """Clones the origin at the commit and runs the pre_build of the buildspec."""
    repo = origin["base"] / f"clone-{commit[:12]}-{len(source_commit)}"
    if not repo.exists():
        _git(origin["env"], "clone", "-q", str(origin["bare"]), str(repo))
    _git(origin["env"], "checkout", "-q", "--detach", commit, cwd=repo)
    spec = yaml.safe_load(cd["Resources"]["BuildProject"]["Properties"]["Source"]["BuildSpec"])
    env = {
        **origin["env"],
        "MAIN_BRANCH": cd["Parameters"]["BranchName"]["Default"],
        "SOURCE_COMMIT": source_commit,
    }
    return subprocess.run(
        [BASH, "-c", "\n".join(spec["phases"]["pre_build"]["commands"])],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )


@needs_bash_and_git
@pytest.mark.parametrize("name", ["a", "merge"], ids=["commit-direto-no-main", "merge-de-pr"])
def test_main_check_accepts_the_first_parent_line_of_main(
    cd: dict[str, Any], merged_main: dict[str, Any], name: str
) -> None:
    done = _run_main_check(cd, merged_main, merged_main[name], merged_main[name])

    assert done.returncode == 0, done.stdout + done.stderr
    assert "OK: o commit" in done.stdout and "linha principal" in done.stdout


@needs_bash_and_git
@pytest.mark.parametrize("name", ["f1", "f2"])
def test_main_check_refuses_a_commit_from_inside_a_merged_branch(
    cd: dict[str, Any], merged_main: dict[str, Any], name: str
) -> None:
    """In the history of main, but never reviewed on its own (a "wip" step of a PR)."""
    done = _run_main_check(cd, merged_main, merged_main[name], merged_main[name])

    assert done.returncode == 1, done.stdout + done.stderr
    assert "veio de dentro de uma branch mesclada" in done.stdout
    assert "commit de merge" in done.stdout and "--first-parent" in done.stdout
    assert "OK:" not in done.stdout


@needs_bash_and_git
@pytest.mark.parametrize("length", [7, 39], ids=["sha-curto", "sha-sem-um-caractere"])
def test_main_check_asks_for_the_full_sha(
    cd: dict[str, Any], merged_main: dict[str, Any], length: int
) -> None:
    """A short SHA can never equal the clone's commit: "run it again" would not help."""
    requested = merged_main["merge"][:length]
    done = _run_main_check(cd, merged_main, merged_main["merge"], requested)

    assert done.returncode == 1, done.stdout + done.stderr
    assert "não é o SHA completo" in done.stdout
    assert f"git rev-parse {requested}" in done.stdout
    assert "Rode a esteira de novo" not in done.stdout


# ------------------------------------------------------------------ buckets and logs
def _bucket_policy(cd: dict[str, Any], bucket: str) -> dict[str, Any]:
    for resource in cd["Resources"].values():
        if resource["Type"] == "AWS::S3::BucketPolicy" and resource["Properties"]["Bucket"] == {
            "Ref": bucket
        }:
            return resource["Properties"]["PolicyDocument"]
    raise AssertionError(f"{bucket} sem política de bucket")


@pytest.mark.parametrize("bucket", ["ArtifactsBucket", "PackagesBucket"])
def test_buckets_are_private_encrypted_and_tls_only(cd: dict[str, Any], bucket: str) -> None:
    props = cd["Resources"][bucket]["Properties"]
    statements = _bucket_policy(cd, bucket)["Statement"]
    rules = props["BucketEncryption"]["ServerSideEncryptionConfiguration"]
    deny_http = [
        s
        for s in statements
        if s["Effect"] == "Deny"
        and s["Condition"] == {"Bool": {"aws:SecureTransport": "false"}}
        and {"Fn::GetAtt": [bucket, "Arn"]} in s["Resource"]
    ]

    assert all(props["PublicAccessBlockConfiguration"].values())
    assert len(props["PublicAccessBlockConfiguration"]) == 4
    assert rules[0]["ServerSideEncryptionByDefault"]["SSEAlgorithm"] == "AES256"
    assert deny_http and len(deny_http[0]["Resource"]) == 2  # the bucket and its objects
    assert props["LifecycleConfiguration"]["Rules"]


def test_pipeline_artifacts_expire(cd: dict[str, Any]) -> None:
    rules = cd["Resources"]["ArtifactsBucket"]["Properties"]["LifecycleConfiguration"]["Rules"]

    assert any(r["Status"] == "Enabled" and 0 < r.get("ExpirationInDays", 0) <= 30 for r in rules)


def test_function_packages_never_expire(cd: dict[str, Any]) -> None:
    """A failed deploy rolls the functions back to the previous package: it must
    still exist, however long ago it was uploaded (UPDATE_ROLLBACK_FAILED otherwise)."""
    rules = cd["Resources"]["PackagesBucket"]["Properties"]["LifecycleConfiguration"]["Rules"]

    assert not any("ExpirationInDays" in r or "ExpirationDate" in r for r in rules)
    assert any("AbortIncompleteMultipartUpload" in r for r in rules)


def test_build_log_group_has_retention(cd: dict[str, Any]) -> None:
    log_groups = [r for r in cd["Resources"].values() if r["Type"] == "AWS::Logs::LogGroup"]

    assert log_groups
    assert all(0 < g["Properties"]["RetentionInDays"] <= 30 for g in log_groups)


# ------------------------------------------------------------------ roles
@pytest.mark.parametrize("role", sorted(ROLE_SERVICES))
def test_each_role_trusts_only_its_service(cd: dict[str, Any], role: str) -> None:
    trust = cd["Resources"][role]["Properties"]["AssumeRolePolicyDocument"]["Statement"]

    assert len(trust) == 1
    assert trust[0]["Effect"] == "Allow"
    assert trust[0]["Action"] == "sts:AssumeRole"
    assert trust[0]["Principal"] == {"Service": ROLE_SERVICES[role]}


def test_no_wildcard_actions(cd: dict[str, Any]) -> None:
    for role in ROLE_SERVICES:
        for statement in _statements(cd, role):
            for action in _as_list(statement.get("Action", [])) + _as_list(
                statement.get("NotAction", [])
            ):
                assert action != "*", (role, statement.get("Sid"))
                assert not SERVICE_WILDCARD.match(action), (role, statement.get("Sid"), action)
    # Resource policies too (the TLS-only bucket policies deny s3:*, never "*" or iam:*).
    for resource in cd["Resources"].values():
        if resource["Type"] == "AWS::S3::BucketPolicy":
            for statement in resource["Properties"]["PolicyDocument"]["Statement"]:
                assert statement["Effect"] == "Deny"
                assert statement["Action"] not in ("*", "iam:*")


def test_star_resources_only_where_iam_has_no_resource_type(cd: dict[str, Any]) -> None:
    for role in ROLE_SERVICES:
        for statement in _statements(cd, role):
            if statement["Effect"] == "Allow" and "*" in _as_list(statement["Resource"]):
                actions = {a.lower() for a in _as_list(statement["Action"])}
                assert actions <= NO_RESOURCE_LEVEL, (role, statement.get("Sid"), actions)


def test_execution_role_iam_actions_stay_in_the_app_prefix(cd: dict[str, Any]) -> None:
    app_roles = f"arn:aws:iam::{ACCOUNT}:role/{APP}-*"
    iam_statements = [
        s
        for s in _statements(cd, EXECUTION_ROLE)
        if s["Effect"] == "Allow" and any(a.startswith("iam:") for a in _as_list(s["Action"]))
    ]
    pass_role = [s for s in iam_statements if "iam:PassRole" in _as_list(s["Action"])]
    attach = [s for s in iam_statements if "iam:AttachRolePolicy" in _as_list(s["Action"])]

    assert iam_statements
    for statement in iam_statements:
        assert _as_list(statement["Resource"]) == [app_roles], statement.get("Sid")
    assert pass_role[0]["Condition"] == {
        "StringEquals": {"iam:PassedToService": "lambda.amazonaws.com"}
    }
    # Only AWSLambdaBasicExecutionRole, and only on a role with the function
    # boundary (#179; see tests/test_cd_function_boundary.py).
    assert len(attach) == 1
    assert attach[0]["Condition"] == {
        "ArnEquals": {
            "iam:PolicyARN": "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            "iam:PermissionsBoundary": Resolver(cd).ref("FunctionBoundaryPolicy"),
        }
    }


def test_pipeline_passes_only_the_execution_role_to_cloudformation(cd: dict[str, Any]) -> None:
    statements = _statements(cd, PIPELINE_ROLE)
    pass_role = [s for s in statements if "iam:PassRole" in _as_list(s["Action"])]
    execution_role = Resolver(cd).get_att(EXECUTION_ROLE, "Arn")

    assert len(pass_role) == 1
    assert pass_role[0]["Resource"] == execution_role
    assert pass_role[0]["Condition"] == {
        "StringEquals": {"iam:PassedToService": "cloudformation.amazonaws.com"}
    }


def test_pipeline_creates_change_sets_only_with_the_execution_role(cd: dict[str, Any]) -> None:
    """cloudformation:RoleArn (type ARN) is a condition key of CreateChangeSet: every
    statement that lets the pipeline create a change set in the app stack demands
    the execution role, so it never runs the stack with another role."""
    statements = _statements(cd, PIPELINE_ROLE)
    stack = f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{APP}/0a1b2c3d"
    execution_role = Resolver(cd).get_att(EXECUTION_ROLE, "Arn")
    create = [
        s
        for s in statements
        if s["Effect"] == "Allow"
        and _matches(s["Action"], "cloudformation:CreateChangeSet")
        and _matches(s["Resource"], stack)
    ]

    assert create
    for statement in create:
        assert statement.get("Condition") == {
            "ArnEquals": {"cloudformation:RoleArn": execution_role}
        }, statement.get("Sid")


def test_pipeline_only_handles_change_sets_of_the_app_stack(cd: dict[str, Any]) -> None:
    statements = _statements(cd, PIPELINE_ROLE)
    actions = _actions(statements)
    stack = f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{APP}/0a1b2c3d"
    other = f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{CD_STACK}/0a1b2c3d"
    transform = f"arn:aws:cloudformation:{REGION}:aws:transform/Serverless-2016-10-31"

    assert not {
        "cloudformation:createstack",
        "cloudformation:updatestack",
        "cloudformation:deletestack",
    } & set(actions)
    assert _allows(statements, "cloudformation:CreateChangeSet", stack)
    assert _allows(statements, "cloudformation:ExecuteChangeSet", stack)
    assert _allows(statements, "cloudformation:CreateChangeSet", transform)
    assert not _allows(statements, "cloudformation:CreateChangeSet", other)
    assert not _allows(statements, "cloudformation:ExecuteChangeSet", transform)


def test_build_role_has_no_cloudformation_or_iam(cd: dict[str, Any]) -> None:
    actions = _actions(_statements(cd, BUILD_ROLE))

    assert not [a for a in actions if a.startswith(("cloudformation:", "iam:", "sts:"))]


def test_connection_is_used_only_on_this_stack_connection(cd: dict[str, Any]) -> None:
    connection = Resolver(cd).get_att("GitHubConnection", "ConnectionArn")
    another = connection.replace("0a1b2c3d", "ffffffff")
    for role in (PIPELINE_ROLE, BUILD_ROLE):
        statements = _statements(cd, role)
        assert _allows(statements, "codeconnections:UseConnection", connection), role
        assert _allows(statements, "codestar-connections:UseConnection", connection), role
        assert not _allows(statements, "codeconnections:UseConnection", another), role


def test_cd_roles_stay_outside_the_execution_role_scope(cd: dict[str, Any]) -> None:
    """The direct reach only: no IAM pattern of the execution role matches a CD
    role (its own role included). The CD roles live under a one-segment path
    without hyphen, and AppStackName has no slash (its AllowedPattern), so
    "role/<path>/..." can never match "role/<AppStackName>-*", whatever the stack
    names. The indirect reach is checked elsewhere: the execution role creates the
    function roles ("role/<AppStackName>-*"), writes their inline policies and
    passes them to Lambda, so a function given broad permissions by a commit on main
    (the SeedFunction, invoked by Custom::InitialData in the same deploy, or any
    other later) could change the CD roles. The permissions boundary of #179 closes
    that path; tests/test_cd_function_boundary.py checks it (see "Limite de
    permissões dos papéis das funções" in backend/README.md)."""
    resolver = Resolver(cd)
    patterns = [
        resource
        for s in _statements(cd, EXECUTION_ROLE)
        if s["Effect"] == "Allow" and any(a.startswith("iam:") for a in _as_list(s["Action"]))
        for resource in _as_list(s["Resource"])
    ]
    for role in ROLE_SERVICES:
        props = cd["Resources"][role]["Properties"]
        name = resolver.resolve(props["RoleName"])
        arn = resolver.get_att(role, "Arn")
        path = resolver.resolve(props["Path"])
        assert not name.startswith(f"{APP}-"), name
        assert re.fullmatch(r"/[a-z0-9]+/", path), path
        assert not any(fnmatch.fnmatchcase(arn, p) for p in patterns), arn


def test_execution_role_cannot_manage_the_cd_buckets(cd: dict[str, Any]) -> None:
    """Even with a CD stack named "<AppStackName>-..." (its buckets would then fall
    in the app's S3 scope), the execution role only reads packages there. Direct
    reach only: indirectly, through a function role, the boundary of #179 denies
    the same (tests/test_cd_function_boundary.py)."""
    resolver = Resolver(cd, stack_name=f"{APP}-cd")
    statements = [
        resolver.resolve(statement)
        for document in _policy_documents(cd, EXECUTION_ROLE)
        for statement in document["Statement"]
    ]
    for bucket in ("ArtifactsBucket", "PackagesBucket"):
        arn = resolver.get_att(bucket, "Arn")
        for action in ("s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutLifecycleConfiguration"):
            assert not _allows(statements, action, arn), (bucket, action)
        assert not _allows(statements, "s3:PutObject", f"{arn}/{APP}/x"), bucket


# ------------------------------------------------------------------ coverage of the app
FUNCTION = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{APP}-ListBeltsFunction-AbC123dEf456"
FUNCTION_ROLE = f"arn:aws:iam::{ACCOUNT}:role/{APP}-ListBeltsFunctionRole-AbC123dEf456"
TABLE = f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/{APP}-BeltsTable-ABC123DEF456"
IMAGES = f"arn:aws:s3:::{APP}-imagesbucket-abc123def456"
USER_POOL = f"arn:aws:cognito-idp:{REGION}:{ACCOUNT}:userpool/{REGION}_AbC123dEf"
APIS = f"arn:aws:apigateway:{REGION}::/apis"
API = f"{APIS}/abc123defg"
LOG_GROUP = f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/{APP}"
BUDGET = f"arn:aws:budgets::{ACCOUNT}:budget/{APP}-mensal"
CODE = f"arn:aws:s3:::{CD_STACK}-packagesbucket-abc123def456/{APP}/0123456789abcdef"

# ------------------------------------------------------------------ what SAM generates
# The guards of the app read the template as CloudFormation deploys it: first
# AWS::LanguageExtensions (cfn-lint's implementation), then the SAM transform
# (aws-sam-translator, the library behind AWS::Serverless-2016-10-31), both offline.
# They see what SAM generates from each function (an event rule, a function URL,
# an alias and a version, an event source mapping...) and the managed policies it
# attaches to the function roles (Tracing, an SQS event, a policy name...).

# Local paths SAM only takes from S3: "sam package" uploads them and writes the S3
# URI in their place (Globals sections are named after the type).
LOCAL_ARTIFACTS = {
    "Function": "CodeUri",
    "LayerVersion": "ContentUri",
    "Api": "DefinitionUri",
    "HttpApi": "DefinitionUri",
    "StateMachine": "DefinitionUri",
}
PACKAGED = f"s3://{CD_STACK}-packagesbucket-abc123def456/{APP}/0123456789abcdef"
PSEUDO_PARAMETERS = {"AWS::Partition": "aws", "AWS::Region": REGION, "AWS::AccountId": ACCOUNT}


def _as_packaged(template: dict[str, Any]) -> None:
    places = [(kind, template.get("Globals", {}).get(kind, {})) for kind in LOCAL_ARTIFACTS]
    places += [
        (resource.get("Type", "").removeprefix("AWS::Serverless::"), resource.get("Properties", {}))
        for resource in template["Resources"].values()
    ]
    for kind, props in places:
        key = LOCAL_ARTIFACTS.get(kind)
        if key and isinstance(props.get(key), str) and not props[key].startswith("s3://"):
            props[key] = PACKAGED


@functools.lru_cache(maxsize=16)
def _transformed(text: str) -> str:
    template = json.loads(text)
    if "AWS::LanguageExtensions" in _as_list(template.get("Transform", [])):
        matches, template = language_extension(Template(str(APP_TEMPLATE), template, [REGION]))
        assert not matches, [str(match) for match in matches]
        template = json.loads(json.dumps(template))
    applications = [
        name
        for name, resource in template["Resources"].items()
        if resource.get("Type") == "AWS::Serverless::Application"
    ]
    assert not applications, (
        f"infra/template.yaml passou a usar AWS::Serverless::Application ({applications}): "
        "o SAM consultaria o Serverless Application Repository, e estes testes não chamam a "
        "AWS. Amplie a guarda (e o papel de execução da esteira) antes de usar o tipo."
    )
    _as_packaged(template)
    metrics = Metrics()
    translator = Translator(
        None, Parser(), boto_session=boto3.session.Session(region_name=REGION), metrics=metrics
    )
    try:
        output = translator.translate(template, parameter_values={})
    except InvalidDocumentException as error:
        causes = "; ".join(cause.message for cause in error.causes)
        raise AssertionError(f"O SAM não transforma o infra/template.yaml: {causes}") from error
    finally:
        metrics.publish()
    return json.dumps(output)


def _sam_resources(app: dict[str, Any]) -> dict[str, Any]:
    """The resources of the app as CloudFormation creates them (both transforms)."""
    return json.loads(_transformed(json.dumps(app)))["Resources"]


def _static(value: Any) -> str:
    """A plain string, or a Fn::Sub of pseudo parameters only; anything else as JSON
    (an ARN this test cannot resolve never counts as allowed)."""
    if isinstance(value, dict) and list(value) == ["Fn::Sub"] and isinstance(value["Fn::Sub"], str):
        text = re.sub(
            r"\$\{(AWS::\w+)\}",
            lambda match: PSEUDO_PARAMETERS.get(match.group(1), match.group(0)),
            value["Fn::Sub"],
        )
        if "${" not in text:
            return text
    return value if isinstance(value, str) else json.dumps(value, sort_keys=True)


# For each resource type of the app: the actions its CloudFormation handler needs
# to create, update and delete it, on a resource shaped like the dev stack's.
REQUIRED_ACTIONS: dict[str, list[tuple[str, str]]] = {
    "AWS::Lambda::Function": [
        ("lambda:CreateFunction", FUNCTION),
        ("lambda:GetFunction", FUNCTION),
        ("lambda:UpdateFunctionCode", FUNCTION),
        ("lambda:UpdateFunctionConfiguration", FUNCTION),
        ("lambda:TagResource", FUNCTION),
        ("lambda:DeleteFunction", FUNCTION),
        ("iam:PassRole", FUNCTION_ROLE),
        ("s3:GetObject", CODE),
    ],
    "AWS::Lambda::Permission": [
        ("lambda:AddPermission", FUNCTION),
        ("lambda:GetPolicy", FUNCTION),
        ("lambda:RemovePermission", FUNCTION),
    ],
    "AWS::Lambda::EventInvokeConfig": [
        ("lambda:PutFunctionEventInvokeConfig", f"{FUNCTION}:$LATEST"),
        ("lambda:GetFunctionEventInvokeConfig", f"{FUNCTION}:$LATEST"),
        ("lambda:UpdateFunctionEventInvokeConfig", f"{FUNCTION}:$LATEST"),
        ("lambda:DeleteFunctionEventInvokeConfig", f"{FUNCTION}:$LATEST"),
    ],
    "AWS::IAM::Role": [
        ("iam:CreateRole", FUNCTION_ROLE),
        ("iam:PutRolePermissionsBoundary", FUNCTION_ROLE),  # Globals PermissionsBoundary
        ("iam:GetRole", FUNCTION_ROLE),
        ("iam:TagRole", FUNCTION_ROLE),
        ("iam:PutRolePolicy", FUNCTION_ROLE),
        ("iam:GetRolePolicy", FUNCTION_ROLE),
        ("iam:AttachRolePolicy", FUNCTION_ROLE),
        ("iam:DetachRolePolicy", FUNCTION_ROLE),
        ("iam:DeleteRolePolicy", FUNCTION_ROLE),
        ("iam:ListRolePolicies", FUNCTION_ROLE),
        ("iam:ListAttachedRolePolicies", FUNCTION_ROLE),
        ("iam:DeleteRole", FUNCTION_ROLE),
    ],
    "AWS::DynamoDB::Table": [
        ("dynamodb:CreateTable", TABLE),
        ("dynamodb:DescribeTable", TABLE),
        ("dynamodb:UpdateTable", TABLE),
        ("dynamodb:UpdateContinuousBackups", TABLE),
        ("dynamodb:DescribeContinuousBackups", TABLE),
        ("dynamodb:TagResource", TABLE),
        ("dynamodb:ListTagsOfResource", TABLE),
        ("dynamodb:DeleteTable", TABLE),
    ],
    "AWS::S3::Bucket": [
        ("s3:CreateBucket", IMAGES),
        ("s3:PutBucketPublicAccessBlock", IMAGES),
        ("s3:PutEncryptionConfiguration", IMAGES),
        ("s3:PutBucketOwnershipControls", IMAGES),
        ("s3:PutBucketTagging", IMAGES),
        ("s3:GetBucketPublicAccessBlock", IMAGES),
        ("s3:ListBucket", IMAGES),
        ("s3:DeleteBucket", IMAGES),
    ],
    "AWS::S3::BucketPolicy": [
        ("s3:PutBucketPolicy", IMAGES),
        ("s3:GetBucketPolicy", IMAGES),
        ("s3:DeleteBucketPolicy", IMAGES),
    ],
    "AWS::Cognito::UserPool": [
        ("cognito-idp:CreateUserPool", "*"),
        ("cognito-idp:DescribeUserPool", USER_POOL),
        ("cognito-idp:UpdateUserPool", USER_POOL),
        ("cognito-idp:DeleteUserPool", USER_POOL),
    ],
    "AWS::Cognito::UserPoolClient": [
        ("cognito-idp:CreateUserPoolClient", USER_POOL),
        ("cognito-idp:DescribeUserPoolClient", USER_POOL),
        ("cognito-idp:UpdateUserPoolClient", USER_POOL),
        ("cognito-idp:DeleteUserPoolClient", USER_POOL),
    ],
    "AWS::Cognito::UserPoolGroup": [
        ("cognito-idp:CreateGroup", USER_POOL),
        ("cognito-idp:GetGroup", USER_POOL),
        ("cognito-idp:UpdateGroup", USER_POOL),
        ("cognito-idp:DeleteGroup", USER_POOL),
    ],
    "AWS::Cognito::UserPoolUser": [
        ("cognito-idp:AdminCreateUser", USER_POOL),
        ("cognito-idp:AdminGetUser", USER_POOL),
        ("cognito-idp:AdminDeleteUser", USER_POOL),
    ],
    "AWS::Cognito::UserPoolUserToGroupAttachment": [
        ("cognito-idp:AdminAddUserToGroup", USER_POOL),
        ("cognito-idp:AdminListGroupsForUser", USER_POOL),
        ("cognito-idp:AdminRemoveUserFromGroup", USER_POOL),
    ],
    "AWS::ApiGatewayV2::Api": [
        ("apigateway:POST", APIS),
        ("apigateway:GET", API),
        ("apigateway:PUT", API),
        ("apigateway:PATCH", API),
        ("apigateway:DELETE", API),
    ],
    "AWS::ApiGatewayV2::Stage": [
        ("apigateway:POST", f"{API}/stages"),
        ("apigateway:GET", f"{API}/stages/$default"),
        ("apigateway:PATCH", f"{API}/stages/$default"),
        ("apigateway:DELETE", f"{API}/stages/$default"),
    ],
    "AWS::Logs::LogGroup": [
        ("logs:CreateLogGroup", LOG_GROUP),
        ("logs:PutRetentionPolicy", LOG_GROUP),
        ("logs:TagResource", LOG_GROUP),
        ("logs:DescribeLogGroups", "*"),
        ("logs:DeleteLogGroup", LOG_GROUP),
    ],
    "AWS::Budgets::Budget": [
        ("budgets:ModifyBudget", BUDGET),
        ("budgets:ViewBudget", BUDGET),
    ],
}


def _app_resource_types(app: dict[str, Any]) -> set[str]:
    return {resource["Type"] for resource in _sam_resources(app).values()}


def test_execution_role_covers_every_resource_type_of_the_app(
    cd: dict[str, Any], app: dict[str, Any]
) -> None:
    """Every type in the transformed template, the ones SAM generates included."""
    statements = _statements(cd, EXECUTION_ROLE)
    kinds = _app_resource_types(app)
    assert {"AWS::Lambda::Function", "AWS::IAM::Role"} <= kinds  # the transform ran
    for kind in sorted(kinds):
        if kind.startswith("Custom::"):
            continue  # see test_execution_role_invokes_only_the_custom_resource_functions
        assert kind in REQUIRED_ACTIONS, (
            f"infra/template.yaml passou a usar {kind}, que o papel de execução da esteira "
            "não cobre: amplie as políticas do CloudFormationExecutionRole em "
            "infra/cd-pipeline.yaml (só nos recursos da stack do app) e acrescente o tipo "
            "a REQUIRED_ACTIONS neste teste."
        )
        missing = [
            (action, resource)
            for action, resource in REQUIRED_ACTIONS[kind]
            if not _allows(statements, action, resource)
        ]
        assert not missing, (
            f"O papel de execução da esteira não cobre {kind}: falta {missing}. Amplie as "
            "políticas do CloudFormationExecutionRole em infra/cd-pipeline.yaml."
        )


def test_execution_role_invokes_only_the_custom_resource_functions(
    cd: dict[str, Any], app: dict[str, Any]
) -> None:
    """With a service role, CloudFormation invokes the custom resource's
    ServiceToken with that role's credentials."""
    statements = _statements(cd, EXECUTION_ROLE)
    tokens = {
        resource["Properties"]["ServiceToken"]["Fn::GetAtt"][0]
        for resource in app["Resources"].values()
        if resource["Type"].startswith("Custom::")
    }

    assert tokens
    for function in tokens:
        arn = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{APP}-{function}-AbC123dEf456"
        assert _allows(statements, "lambda:InvokeFunction", arn), (
            f"O custom resource do app usa {function}: libere lambda:InvokeFunction nela no "
            "CloudFormationExecutionRole (infra/cd-pipeline.yaml)."
        )
    assert not _allows(statements, "lambda:InvokeFunction", FUNCTION)


def test_app_functions_attach_no_other_managed_policy(app: dict[str, Any]) -> None:
    """The execution role may attach only AWSLambdaBasicExecutionRole (what SAM adds)."""
    for name, resource in app["Resources"].items():
        if resource["Type"] != "AWS::Serverless::Function":
            continue
        props = resource["Properties"]
        managed = [p for p in props.get("Policies", []) if isinstance(p, str)]
        assert not managed and "ManagedPolicyArns" not in props, (
            f"{name} usa política gerenciada {managed or props.get('ManagedPolicyArns')}: "
            "inclua o ARN na condição iam:PolicyARN do CloudFormationExecutionRole "
            "(infra/cd-pipeline.yaml)."
        )


def _attachable_policies(cd: dict[str, Any]) -> set[str]:
    """The managed policies the execution role may attach (its iam:PolicyARN condition)."""
    allowed: set[str] = set()
    for statement in _statements(cd, EXECUTION_ROLE):
        if statement["Effect"] == "Allow" and "iam:AttachRolePolicy" in _as_list(
            statement["Action"]
        ):
            condition = statement.get("Condition", {}).get("ArnEquals", {})
            allowed.update(_as_list(condition.get("iam:PolicyARN", [])))
    return allowed


def test_execution_role_attaches_every_managed_policy_sam_generates(
    cd: dict[str, Any], app: dict[str, Any]
) -> None:
    """SAM attaches managed policies on its own: AWSLambdaBasicExecutionRole always,
    AWSXrayWriteOnlyAccess with Tracing (in the function or in Globals),
    AWSLambdaSQSQueueExecutionRole with an SQS event, any policy named in Policies.
    The execution role attaches only the ARNs of its iam:PolicyARN condition: any
    other one fails the deploy with AccessDenied."""
    allowed = _attachable_policies(cd)
    roles = {
        name: resource["Properties"]
        for name, resource in _sam_resources(app).items()
        if resource["Type"] == "AWS::IAM::Role"
    }
    missing = sorted(
        {
            (name, _static(arn))
            for name, props in roles.items()
            for arn in props.get("ManagedPolicyArns", [])
            if _static(arn) not in allowed
        }
    )

    assert roles and allowed
    assert not missing, (
        f"O SAM anexa aos papéis das funções políticas gerenciadas que o papel de execução da "
        f"esteira não pode anexar: {missing}. Inclua o ARN na condição iam:PolicyARN do "
        "CloudFormationExecutionRole (infra/cd-pipeline.yaml), ou tire do infra/template.yaml "
        "o que a gera (Tracing, evento SQS, nome de política em Policies)."
    )


def test_execution_role_cannot_read_student_data(cd: dict[str, Any]) -> None:
    """LGPD: the execution role manages tables and buckets, never their content."""
    statements = _statements(cd, EXECUTION_ROLE)
    for action in ("dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem"):
        assert not _allows(statements, action, TABLE), action
    for action in ("s3:GetObject", "s3:PutObject", "s3:DeleteObject"):
        assert not _allows(statements, action, f"{IMAGES}/logos/logo.png"), action


def test_execution_role_reads_packages_of_pipeline_and_manual_deploys(cd: dict[str, Any]) -> None:
    statements = _statements(cd, EXECUTION_ROLE)
    manual = f"arn:aws:s3:::aws-sam-cli-managed-default-samclisourcebucket-abc123/{APP}/0123abcd"

    assert _allows(statements, "s3:GetObject", CODE)
    assert _allows(statements, "s3:GetObject", manual)
    assert not _allows(statements, "s3:GetObject", manual.replace(f"/{APP}/", "/other-app/"))


def test_policies_fit_the_iam_size_quotas(cd: dict[str, Any]) -> None:
    """IAM counts characters without whitespace: 6,144 per managed policy and
    10,240 for all the inline policies of a role."""
    resolver = Resolver(cd)

    def size(document: Any) -> int:
        return len(re.sub(r"\s", "", json.dumps(resolver.resolve(document))))

    for resource in cd["Resources"].values():
        if resource["Type"] == "AWS::IAM::ManagedPolicy":
            assert size(resource["Properties"]["PolicyDocument"]) < 6144
        if resource["Type"] == "AWS::IAM::Role":
            inline = resource["Properties"].get("Policies", [])
            assert sum(size(p["PolicyDocument"]) for p in inline) < 10240


# ------------------------------------------------------------------ secrets
def test_admin_email_is_masked_and_has_no_default(cd: dict[str, Any]) -> None:
    admin_email = cd["Parameters"]["AdminEmail"]

    assert admin_email["NoEcho"] is True
    assert "Default" not in admin_email


def test_template_has_no_account_id_nor_real_email() -> None:
    text = CD_TEMPLATE.read_text(encoding="utf-8")

    assert not ACCOUNT_ID.search(text)
    for match in EMAIL.finditer(text):
        assert match.group(0).endswith("@example.com"), match.group(0)
