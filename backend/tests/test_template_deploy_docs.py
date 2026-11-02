"""Deploy instructions stay in sync with ``infra/template.yaml``.

The ``AWS::LanguageExtensions`` transform is a macro: CloudFormation refuses the
change set without ``CAPABILITY_AUTO_EXPAND``. The documented commands must ask
for it, and must not carry a real e-mail address.
"""

import re
from pathlib import Path

import pytest
from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "infra" / "template.yaml"
README = ROOT / "backend" / "README.md"
SAMCONFIG = ROOT / "infra" / "samconfig.example.toml"
EMAIL = re.compile(r"[\w.+-]+@([\w-]+\.)+\w+")


def _uses_language_extensions() -> bool:
    parsed, errors = decode(str(TEMPLATE))
    assert not errors, errors
    transform = parsed["Transform"]
    transforms = transform if isinstance(transform, list) else [transform]
    return "AWS::LanguageExtensions" in transforms


def test_samconfig_example_asks_for_auto_expand() -> None:
    assert _uses_language_extensions()
    text = SAMCONFIG.read_text(encoding="utf-8")
    capabilities = re.search(r'^capabilities\s*=\s*"([^"]*)"', text, re.MULTILINE)

    assert capabilities is not None
    assert set(capabilities.group(1).split()) >= {"CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"}


def test_readme_deploy_command_asks_for_auto_expand() -> None:
    assert _uses_language_extensions()
    text = README.read_text(encoding="utf-8")
    commands = re.findall(r"sam deploy(?:[^\n]*\\\n)*[^\n]*", text)
    explicit = [command for command in commands if "--capabilities" in command]

    assert explicit
    for command in explicit:
        assert "CAPABILITY_AUTO_EXPAND" in command, command


@pytest.mark.parametrize("path", [README, SAMCONFIG], ids=["README", "samconfig"])
def test_deploy_docs_only_use_example_emails(path: Path) -> None:
    for match in EMAIL.finditer(path.read_text(encoding="utf-8")):
        assert match.group(0).endswith("@example.com"), match.group(0)
