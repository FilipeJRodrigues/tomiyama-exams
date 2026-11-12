"""QA coverage for the CORS origins of ``infra/template.yaml`` (card #31).

Edge cases of ``AllowedPattern`` that ``test_template_cors.py`` leaves out, and
the dev and prod examples of ``backend/README.md`` checked against the pattern.
"""

import re
from pathlib import Path
from typing import Any

import pytest
from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "infra" / "template.yaml"
README = ROOT / "backend" / "README.md"


@pytest.fixture(scope="module")
def pattern() -> re.Pattern[str]:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    parameter: dict[str, Any] = parsed["Parameters"]["AllowedOrigin"]
    return re.compile(parameter["AllowedPattern"])


@pytest.mark.parametrize(
    "origin",
    [
        "https://xn--exmpl-gra.com.br",  # IDN: the browser sends the punycode form
        "https://exames.example.com.br",
        "https://dev-exames.example.com",
    ],
)
def test_template_cors_qa_pattern_accepts_punycode_and_hyphenated_hosts(
    pattern: re.Pattern[str], origin: str
) -> None:
    assert pattern.fullmatch(origin)


@pytest.mark.parametrize(
    "origin",
    [
        "HTTPS://main.d1abc2def3.amplifyapp.com",
        "https://example.com.",
        "https://-exames.example.com",
        "https://exames-.example.com",
        "https://exames..example.com",
        "https://exames_1.example.com",
        "https://user@exames.example.com",
        "https://exames.example.com?x=1",
        "https://exames.example.com#",
        "https://exames.example.com:",
        "https://exames.example.com\n",
        "http://localhost:5173 ",
        "http://localhost:5173:80",
        "http://[::1]:5173",
        "https://exámple.com",
    ],
)
def test_template_cors_qa_pattern_refuses_malformed_origins(
    pattern: re.Pattern[str], origin: str
) -> None:
    assert not pattern.fullmatch(origin)


def test_template_cors_qa_readme_examples_match_the_pattern(pattern: re.Pattern[str]) -> None:
    text = README.read_text(encoding="utf-8")
    examples = re.findall(r'`AllowedOrigin="?([^`"]+)"?`', text)

    assert len(examples) == 2, examples
    for example in examples:
        for origin in example.replace("<appid>", "d1abc2def3").split(","):
            assert pattern.fullmatch(origin), origin
