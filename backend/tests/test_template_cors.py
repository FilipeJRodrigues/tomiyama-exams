"""CORS of the HTTP API in ``infra/template.yaml`` (front on Amplify Hosting).

``AllowedOrigin`` is a ``CommaDelimitedList``: dev lists localhost and the
Amplify domain, prod only the Amplify domain. CloudFormation checks
``AllowedPattern`` against each item, so it must refuse ``*`` (the API takes
the ``Authorization`` header), plain ``http://`` outside localhost and origins
with a trailing slash or a path. The list goes straight into ``AllowOrigins``:
``AWS::LanguageExtensions`` (which must run before SAM) resolves the ``Ref`` to
a literal list; any other intrinsic there makes SAM drop the allowed headers.
"""

import re
import shlex
import tomllib
from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "infra" / "template.yaml"
SAMCONFIG = ROOT / "infra" / "samconfig.example.toml"
AMPLIFY = "https://main.d1abc2def3.amplifyapp.com"


@pytest.fixture(scope="module")
def template() -> dict[str, Any]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    return parsed


@pytest.fixture(scope="module")
def parameter(template: dict[str, Any]) -> dict[str, Any]:
    return template["Parameters"]["AllowedOrigin"]


@pytest.fixture(scope="module")
def pattern(parameter: dict[str, Any]) -> re.Pattern[str]:
    # CloudFormation matches the whole value, as fullmatch does.
    return re.compile(parameter["AllowedPattern"])


def _cors(template: dict[str, Any]) -> dict[str, Any]:
    return template["Resources"]["HttpApi"]["Properties"]["CorsConfiguration"]


def test_template_cors_origin_parameter_is_a_list_with_localhost_default(
    parameter: dict[str, Any], pattern: re.Pattern[str]
) -> None:
    assert parameter["Type"] == "CommaDelimitedList"
    assert parameter["Default"] == "http://localhost:5173"
    for origin in parameter["Default"].split(","):
        assert pattern.fullmatch(origin), origin
    assert "vírgula" in parameter["Description"]
    assert "barra no fim" in parameter["Description"]
    assert "barra no fim" in parameter["ConstraintDescription"]


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:5173",
        "http://localhost",
        AMPLIFY,
        "https://exames.example.com",
        "https://exames.example.com:8443",
    ],
)
def test_template_cors_pattern_accepts_https_and_localhost(
    pattern: re.Pattern[str], origin: str
) -> None:
    assert pattern.fullmatch(origin)


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "https://*.amplifyapp.com",
        "http://*",
        f"{AMPLIFY}/",
        f"{AMPLIFY}/index.html",
        "http://main.d1abc2def3.amplifyapp.com",
        "http://127.0.0.1:5173",
        "http://localhost.example.com",
        "https://Main.d1abc2def3.amplifyapp.com",
        f" {AMPLIFY}",
        "",
        "null",
        "main.d1abc2def3.amplifyapp.com",
        "https://localhost",
        f"{AMPLIFY},http://localhost:5173",
    ],
)
def test_template_cors_pattern_refuses_wildcard_plain_http_and_trailing_slash(
    pattern: re.Pattern[str], origin: str
) -> None:
    assert not pattern.fullmatch(origin)


def test_template_cors_allow_origins_takes_the_list_as_is(template: dict[str, Any]) -> None:
    # Not wrapped in another list and not an Fn::Split: either would break the
    # x-amazon-apigateway-cors block that SAM writes.
    assert _cors(template)["AllowOrigins"] == {"Ref": "AllowedOrigin"}


def test_template_cors_language_extensions_runs_before_sam(template: dict[str, Any]) -> None:
    transforms = template["Transform"]

    assert transforms.index("AWS::LanguageExtensions") < transforms.index(
        "AWS::Serverless-2016-10-31"
    )


def test_template_cors_headers_and_methods_are_unchanged(template: dict[str, Any]) -> None:
    cors = _cors(template)

    assert set(cors) == {"AllowOrigins", "AllowHeaders", "AllowMethods", "MaxAge"}
    assert cors["AllowHeaders"] == ["authorization", "content-type"]
    assert cors["AllowMethods"] == ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    assert cors["MaxAge"] == 600


def _overrides(line: str) -> dict[str, str]:
    """Split ``parameter_overrides`` the way the SAM CLI does: pairs by space."""
    value = tomllib.loads(line)["parameter_overrides"]
    return dict(pair.split("=", 1) for pair in shlex.split(value))


def test_template_cors_samconfig_example_shows_two_origins(pattern: re.Pattern[str]) -> None:
    lines = SAMCONFIG.read_text(encoding="utf-8").splitlines()
    active = [line for line in lines if line.startswith("parameter_overrides")]
    commented = [line[2:] for line in lines if line.startswith("# parameter_overrides")]

    assert len(active) == 1
    assert "AllowedOrigin" not in _overrides(active[0])
    assert len(commented) == 1
    overrides = _overrides(commented[0].replace("<appid>", "d1abc2def3"))
    origins = overrides["AllowedOrigin"].split(",")
    assert origins == ["http://localhost:5173", AMPLIFY]
    assert all(pattern.fullmatch(origin) for origin in origins)
    assert overrides["Environment"] == "dev"
