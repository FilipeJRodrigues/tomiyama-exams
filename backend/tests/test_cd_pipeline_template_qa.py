"""QA coverage for ``infra/cd-pipeline.yaml`` (card #68), beyond test_cd_pipeline_template.py.

- The "only commits of main" check of the build runs for real: the pre_build commands
  of the inline buildspec go through bash against local git repositories (no AWS, no
  network). A wrong check fails here even if its text still matches.
- ParameterOverrides stays valid JSON for every value the CD parameters accept.
- Every variable of the buildspec comes from the project or the pipeline action, and the
  packages prefix is the one both roles use.
- The properties of the app's resources that need extra permissions are covered by the
  execution role (CORS or lifecycle in the images bucket, Layers or VPC in a function...).
"""

import copy
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import test_cd_pipeline_template as cd_tests
import yaml

ACCOUNT, REGION, APP = cd_tests.ACCOUNT, cd_tests.REGION, cd_tests.APP


@pytest.fixture(scope="module")
def cd() -> dict[str, Any]:
    return cd_tests._load(cd_tests.CD_TEMPLATE)


@pytest.fixture(scope="module")
def app() -> dict[str, Any]:
    return cd_tests._load(cd_tests.APP_TEMPLATE)


def _buildspec(cd: dict[str, Any]) -> dict[str, Any]:
    return yaml.safe_load(cd["Resources"]["BuildProject"]["Properties"]["Source"]["BuildSpec"])


# ------------------------------------------------------------------ main-only check
def _bash() -> str | None:
    if sys.platform != "win32":
        return shutil.which("bash")
    git = shutil.which("git")  # Git for Windows ships bash next to git
    if not git:
        return None
    for parent in list(Path(git).resolve().parents)[:3]:
        for candidate in (parent / "bin" / "bash.exe", parent / "usr" / "bin" / "bash.exe"):
            if candidate.exists():
                return str(candidate)
    return None


BASH = _bash()
pytestmark_gate = pytest.mark.skipif(
    BASH is None or shutil.which("git") is None, reason="sem bash ou git no ambiente"
)


def _git_env(base: Path) -> dict[str, str]:
    config = base / "gitconfig"
    config.write_text("", encoding="utf-8")
    return {
        **os.environ,
        "GIT_CONFIG_GLOBAL": str(config),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "qa",
        "GIT_AUTHOR_EMAIL": "qa@example.com",
        "GIT_COMMITTER_NAME": "qa",
        "GIT_COMMITTER_EMAIL": "qa@example.com",
        "GIT_TERMINAL_PROMPT": "0",
    }


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
def origin(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """A bare "GitHub" with main (A -> B), a branch (A -> F), a pull request ref
    (B -> P, like a fork's commit) and a tag on F."""
    if BASH is None or shutil.which("git") is None:
        pytest.skip("sem bash ou git no ambiente")
    base = tmp_path_factory.mktemp("cd-gate")
    env = _git_env(base)
    bare = base / "origin.git"
    seed = base / "seed"
    _git(env, "init", "-q", "--bare", "-b", "main", str(bare))
    _git(env, "init", "-q", "-b", "main", str(seed))
    _git(env, "remote", "add", "origin", str(bare), cwd=seed)
    a = _commit(env, seed, "a")
    b = _commit(env, seed, "b")
    _git(env, "push", "-q", "origin", "main", cwd=seed)
    _git(env, "checkout", "-q", "-b", "feature", a, cwd=seed)
    f = _commit(env, seed, "f")
    _git(env, "push", "-q", "origin", "feature", cwd=seed)
    _git(env, "tag", "t-feature", f, cwd=seed)
    _git(env, "push", "-q", "origin", "t-feature", cwd=seed)
    _git(env, "checkout", "-q", "--detach", b, cwd=seed)
    p = _commit(env, seed, "p")
    _git(env, "push", "-q", "origin", "HEAD:refs/pull/1/head", cwd=seed)
    return {"base": base, "env": env, "bare": bare, "a": a, "b": b, "f": f, "p": p}


def _clone(origin: dict[str, Any], name: str, *, shallow: bool = False) -> Path:
    target = origin["base"] / name
    if shallow:
        source = origin["bare"].as_uri()
        _git(origin["env"], "clone", "-q", "--depth", "1", source, str(target))
    else:
        _git(origin["env"], "clone", "-q", str(origin["bare"]), str(target))
    return target


def _checkout(origin: dict[str, Any], repo: Path, revision: str) -> None:
    _git(origin["env"], "checkout", "-q", "--detach", revision, cwd=repo)


def _pre_build(
    cd: dict[str, Any], origin: dict[str, Any], repo: Path, source_commit: str
) -> subprocess.CompletedProcess[str]:
    script = "\n".join(_buildspec(cd)["phases"]["pre_build"]["commands"])
    env = {
        **origin["env"],
        "MAIN_BRANCH": cd["Parameters"]["BranchName"]["Default"],
        "SOURCE_COMMIT": source_commit,
    }
    return subprocess.run(
        [BASH, "-c", script],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )


@pytestmark_gate
@pytest.mark.parametrize("commit", ["a", "b"])
def test_gate_accepts_the_tip_and_older_commits_of_main(
    cd: dict[str, Any], origin: dict[str, Any], commit: str
) -> None:
    repo = _clone(origin, f"main-{commit}")
    _checkout(origin, repo, origin[commit])
    done = _pre_build(cd, origin, repo, origin[commit])

    assert done.returncode == 0, done.stdout + done.stderr
    assert "OK: o commit" in done.stdout


@pytestmark_gate
def test_gate_refuses_a_commit_of_another_branch(
    cd: dict[str, Any], origin: dict[str, Any]
) -> None:
    repo = _clone(origin, "feature")
    _checkout(origin, repo, origin["f"])
    done = _pre_build(cd, origin, repo, origin["f"])

    assert done.returncode == 1
    assert "ERRO: o commit" in done.stdout and "por PR" in done.stdout


@pytestmark_gate
def test_gate_refuses_a_pull_request_or_fork_commit(
    cd: dict[str, Any], origin: dict[str, Any]
) -> None:
    """COMMIT_ID accepts any commit GitHub serves, a fork's PR included."""
    repo = _clone(origin, "pull")
    _git(origin["env"], "fetch", "-q", "origin", "refs/pull/1/head", cwd=repo)
    _checkout(origin, repo, "FETCH_HEAD")
    done = _pre_build(cd, origin, repo, origin["p"])

    assert done.returncode == 1
    assert "ERRO: o commit" in done.stdout


@pytestmark_gate
@pytest.mark.parametrize(
    ("checkout", "requested"),
    [("b", "a"), ("b", "short-b"), ("f", "t-feature")],
    ids=["outro-commit", "sha-curto", "tag"],
)
def test_gate_refuses_when_the_clone_is_not_exactly_the_requested_commit(
    cd: dict[str, Any], origin: dict[str, Any], checkout: str, requested: str
) -> None:
    repo = _clone(origin, f"mismatch-{requested}")
    _checkout(origin, repo, origin[checkout])
    value = {"a": origin["a"], "short-b": origin["b"][:7], "t-feature": "t-feature"}[requested]
    done = _pre_build(cd, origin, repo, value)

    assert done.returncode == 1
    assert "ERRO: o clone" in done.stdout


@pytestmark_gate
def test_gate_unshallows_a_shallow_clone_before_checking(
    cd: dict[str, Any], origin: dict[str, Any]
) -> None:
    repo = _clone(origin, "shallow", shallow=True)
    done = _pre_build(cd, origin, repo, origin["b"])

    assert done.returncode == 0, done.stdout + done.stderr
    assert _git(origin["env"], "rev-parse", "--is-shallow-repository", cwd=repo) == "false"


@pytestmark_gate
@pytest.mark.parametrize("shallow", [False, True], ids=["clone-completo", "clone-raso"])
def test_gate_fails_closed_when_main_cannot_be_fetched(
    cd: dict[str, Any], origin: dict[str, Any], shallow: bool
) -> None:
    repo = _clone(origin, f"offline-{shallow}", shallow=shallow)
    missing = (origin["base"] / "nao-existe.git").as_uri()
    _git(origin["env"], "remote", "set-url", "origin", missing, cwd=repo)
    done = _pre_build(cd, origin, repo, origin["b"])

    assert done.returncode != 0
    assert "OK: o commit" not in done.stdout
    if not shallow:
        assert "AVAILABLE" in done.stdout  # the pt-BR message about the connection


# ------------------------------------------------------------------ ParameterOverrides
ADMIN_EMAILS = ["examinador@example.com", "o'neil+dojo@example.com.br", "joão.sá@example.com"]
ORIGINS = ["http://localhost:5173", "http://localhost:5173,https://main.d1a2b3c4.amplifyapp.com"]


def test_parameter_overrides_is_valid_json_for_the_accepted_values(cd: dict[str, Any]) -> None:
    email_pattern = cd["Parameters"]["AdminEmail"]["AllowedPattern"]
    origin_pattern = cd["Parameters"]["AllowedOrigin"]["AllowedPattern"]
    action = cd_tests._flat_actions(cd)[2]
    for email, origins, environment in itertools.product(ADMIN_EMAILS, ORIGINS, ["dev", "prod"]):
        assert re.fullmatch(email_pattern, email), email
        assert re.fullmatch(origin_pattern, origins), origins
        resolver = cd_tests.Resolver(cd)
        resolver.values.update(
            {"AdminEmail": email, "AllowedOrigin": origins, "Environment": environment}
        )
        overrides = json.loads(resolver.resolve(action["Configuration"]["ParameterOverrides"]))

        assert overrides["AdminEmail"] == email
        assert overrides["AllowedOrigin"] == origins
        assert overrides["Environment"] == environment
        assert len(json.dumps(overrides, ensure_ascii=False).encode("utf-8")) < 1024


@pytest.mark.parametrize(
    ("parameter", "value"),
    [
        ("AdminEmail", 'a"b@example.com'),
        ("AdminEmail", "a\\b@example.com"),
        ("AdminEmail", "a b@example.com"),
        ("AdminEmail", "sem-arroba"),
        ("AllowedOrigin", "http://localhost:5173, https://main.d1.amplifyapp.com"),
        ("AllowedOrigin", 'http://"x"'),
    ],
)
def test_parameters_refuse_what_would_break_the_json(
    cd: dict[str, Any], parameter: str, value: str
) -> None:
    assert not re.fullmatch(cd["Parameters"][parameter]["AllowedPattern"], value)


# ------------------------------------------------------------------ buildspec variables
CODEBUILD_VARIABLES = {"CODEBUILD_SRC_DIR"}


def test_buildspec_variables_come_from_the_project_or_the_pipeline(cd: dict[str, Any]) -> None:
    """With no "set -u", a renamed variable would silently become empty (an empty
    PACKAGES_PREFIX uploads the code where the execution role cannot read it)."""
    spec = _buildspec(cd)
    commands = "\n".join(
        command for phase in spec["phases"].values() for command in phase.get("commands", [])
    )
    used = set(re.findall(r"\$\{?([A-Z_][A-Z0-9_]*)", commands))
    project = {
        v["Name"]
        for v in cd["Resources"]["BuildProject"]["Properties"]["Environment"][
            "EnvironmentVariables"
        ]
    }
    build_action = cd_tests._flat_actions(cd)[1]
    pipeline = {
        v["name"] for v in json.loads(build_action["Configuration"]["EnvironmentVariables"])
    }
    local = {"COMMIT"}  # assigned inside pre_build

    assert used - project - pipeline - CODEBUILD_VARIABLES - local == set()


def test_packages_prefix_is_where_the_build_writes_and_the_execution_role_reads(
    cd: dict[str, Any],
) -> None:
    project = cd["Resources"]["BuildProject"]["Properties"]
    variables = {v["Name"]: v["Value"] for v in project["Environment"]["EnvironmentVariables"]}
    resolver = cd_tests.Resolver(cd)
    key = f"{resolver.get_att('PackagesBucket', 'Arn')}/{resolver.ref('AppStackName')}/0a1b2c"

    assert variables["PACKAGES_BUCKET"] == {"Ref": "PackagesBucket"}
    assert variables["PACKAGES_PREFIX"] == {"Ref": "AppStackName"}
    assert cd_tests._allows(cd_tests._statements(cd, cd_tests.BUILD_ROLE), "s3:PutObject", key)
    assert cd_tests._allows(cd_tests._statements(cd, cd_tests.EXECUTION_ROLE), "s3:GetObject", key)


# ------------------------------------------------------------------ properties of the app
LAYER = f"arn:aws:lambda:{REGION}:{ACCOUNT}:layer:camada:1"
KMS_KEY = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/0a1b2c3d-0000-0000-0000-000000000000"

# Properties whose handler needs actions beyond the create/update/delete of the type
# (CloudFormation resource schemas; HTTP API access logs: API Gateway logging guide).
PROPERTY_ACTIONS: dict[tuple[str, str], list[tuple[str, str]]] = {
    ("AWS::S3::Bucket", "CorsConfiguration"): [("s3:PutBucketCORS", cd_tests.IMAGES)],
    ("AWS::S3::Bucket", "LifecycleConfiguration"): [
        ("s3:PutLifecycleConfiguration", cd_tests.IMAGES)
    ],
    ("AWS::S3::Bucket", "NotificationConfiguration"): [
        ("s3:PutBucketNotification", cd_tests.IMAGES)
    ],
    ("AWS::S3::Bucket", "VersioningConfiguration"): [("s3:PutBucketVersioning", cd_tests.IMAGES)],
    ("AWS::S3::Bucket", "LoggingConfiguration"): [("s3:PutBucketLogging", cd_tests.IMAGES)],
    ("AWS::S3::Bucket", "WebsiteConfiguration"): [("s3:PutBucketWebsite", cd_tests.IMAGES)],
    ("AWS::S3::Bucket", "ObjectLockConfiguration"): [
        ("s3:PutBucketObjectLockConfiguration", cd_tests.IMAGES)
    ],
    ("AWS::S3::Bucket", "IntelligentTieringConfigurations"): [
        ("s3:PutIntelligentTieringConfiguration", cd_tests.IMAGES)
    ],
    ("AWS::DynamoDB::Table", "TimeToLiveSpecification"): [
        ("dynamodb:UpdateTimeToLive", cd_tests.TABLE)
    ],
    ("AWS::DynamoDB::Table", "ContributorInsightsSpecification"): [
        ("dynamodb:UpdateContributorInsights", cd_tests.TABLE)
    ],
    ("AWS::DynamoDB::Table", "KinesisStreamSpecification"): [
        ("dynamodb:EnableKinesisStreamingDestination", cd_tests.TABLE)
    ],
    ("AWS::DynamoDB::Table", "ResourcePolicy"): [("dynamodb:PutResourcePolicy", cd_tests.TABLE)],
    ("AWS::DynamoDB::Table", "ImportSourceSpecification"): [
        ("dynamodb:ImportTable", cd_tests.TABLE)
    ],
    ("AWS::Serverless::Function", "Layers"): [("lambda:GetLayerVersion", LAYER)],
    ("AWS::Serverless::Function", "VpcConfig"): [
        ("ec2:DescribeVpcs", "*"),
        ("ec2:DescribeSubnets", "*"),
        ("ec2:DescribeSecurityGroups", "*"),
    ],
    ("AWS::Serverless::Function", "KmsKeyArn"): [("kms:CreateGrant", KMS_KEY)],
    ("AWS::Serverless::Function", "CodeSigningConfigArn"): [
        ("lambda:PutFunctionCodeSigningConfig", cd_tests.FUNCTION)
    ],
    ("AWS::Serverless::Function", "FileSystemConfigs"): [
        ("elasticfilesystem:DescribeMountTargets", "*")
    ],
    ("AWS::Serverless::HttpApi", "AccessLogSettings"): [("logs:CreateLogDelivery", "*")],
    ("AWS::Logs::LogGroup", "DataProtectionPolicy"): [
        ("logs:PutDataProtectionPolicy", cd_tests.LOG_GROUP)
    ],
    ("AWS::Logs::LogGroup", "KmsKeyId"): [("logs:AssociateKmsKey", cd_tests.LOG_GROUP)],
    ("AWS::Logs::LogGroup", "ResourcePolicyDocument"): [("logs:PutResourcePolicy", "*")],
}


def _uncovered_properties(cd: dict[str, Any], app: dict[str, Any]) -> list[tuple[str, str, str]]:
    statements = cd_tests._statements(cd, cd_tests.EXECUTION_ROLE)
    globals_ = app.get("Globals", {})
    missing = []
    for name, resource in app["Resources"].items():
        kind = resource["Type"]
        section = {"AWS::Serverless::Function": "Function", "AWS::Serverless::HttpApi": "HttpApi"}
        used = {**globals_.get(section.get(kind, ""), {}), **resource.get("Properties", {})}
        for prop in used:
            for action, arn in PROPERTY_ACTIONS.get((kind, prop), []):
                if not cd_tests._allows(statements, action, arn):
                    missing.append((name, prop, action))
    return missing


def test_execution_role_covers_the_properties_the_app_uses(
    cd: dict[str, Any], app: dict[str, Any]
) -> None:
    missing = _uncovered_properties(cd, app)

    assert not missing, (
        f"O infra/template.yaml usa propriedades que o papel de execução da esteira não cobre: "
        f"{missing}. Amplie o CloudFormationExecutionRole em infra/cd-pipeline.yaml (só nos "
        "recursos da stack do app) antes do deploy."
    )


@pytest.mark.parametrize(
    ("resource", "prop", "value", "action"),
    [
        ("ImagesBucket", "CorsConfiguration", {"CorsRules": []}, "s3:PutBucketCORS"),
        ("ImagesBucket", "LifecycleConfiguration", {"Rules": []}, "s3:PutLifecycleConfiguration"),
        ("ListBeltsFunction", "Layers", [LAYER], "lambda:GetLayerVersion"),
        ("HttpApi", "AccessLogSettings", {"DestinationArn": "x"}, "logs:CreateLogDelivery"),
    ],
)
def test_property_guard_catches_a_new_property(
    cd: dict[str, Any], app: dict[str, Any], resource: str, prop: str, value: Any, action: str
) -> None:
    """The guard above is not vacuous: each of these changes would fail the deploy."""
    changed = copy.deepcopy(app)
    changed["Resources"][resource]["Properties"][prop] = value

    assert (resource, prop, action) in _uncovered_properties(cd, changed)
