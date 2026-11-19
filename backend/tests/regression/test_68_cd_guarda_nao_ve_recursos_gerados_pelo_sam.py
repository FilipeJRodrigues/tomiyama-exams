"""A guarda do papel de execução da esteira não percebe o que o SAM gera a partir das funções.

Erro observado: o card #68 pede testes que falhem quando o `infra/template.yaml`
passar a usar um serviço que o `CloudFormationExecutionRole` de
`infra/cd-pipeline.yaml` não cobre. Em `tests/test_cd_pipeline_template.py`, os
tipos do app vêm de uma expansão fixa (`SAM_EXPANSION`): toda
`AWS::Serverless::Function` vira sempre os mesmos quatro tipos. Nenhum teste falha
quando uma função ganha:

- um evento `Schedule`: o SAM gera `AWS::Events::Rule` (falta `events:PutRule`);
- um evento `SQS`: gera `AWS::Lambda::EventSourceMapping` (falta
  `lambda:CreateEventSourceMapping`);
- `FunctionUrlConfig`: gera `AWS::Lambda::Url` (falta `lambda:CreateFunctionUrlConfig`);
- `AutoPublishAlias`: gera `AWS::Lambda::Version` e `AWS::Lambda::Alias` (falta
  `lambda:CreateAlias`);
- `Tracing: Active`, na função ou no `Globals`: o SAM anexa
  `arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess` ao papel da função, e o papel de
  execução só anexa `AWSLambdaBasicExecutionRole` (condição `iam:PolicyARN`).

Os tipos gerados foram conferidos com o aws-sam-translator. Em todos os casos, o deploy
pela esteira falharia com AccessDenied e a stack voltaria. O `sam deploy` manual também
falharia, porque usa o papel guardado na stack. Enquanto isso, a suíte continuaria verde.

Esperado: com qualquer uma dessas mudanças no template do app, ao menos um teste de
`tests/test_cd_pipeline_template.py` que recebe o template do app (`app`) falha.
Issue: #68
"""

import copy
import inspect
from pathlib import Path
from typing import Any

import pytest
import test_cd_pipeline_template as cd_tests
from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
FUNCTION = "ListBeltsFunction"


def _load(path: Path) -> dict[str, Any]:
    parsed, errors = decode(str(path))
    assert not errors, errors
    return parsed


def _add_event(name: str, event: dict[str, Any]):
    def mutate(app: dict[str, Any]) -> None:
        app["Resources"][FUNCTION]["Properties"].setdefault("Events", {})[name] = event

    return mutate


def _set_property(name: str, value: Any):
    def mutate(app: dict[str, Any]) -> None:
        app["Resources"][FUNCTION]["Properties"][name] = value

    return mutate


def _set_global(name: str, value: Any):
    def mutate(app: dict[str, Any]) -> None:
        app["Globals"]["Function"][name] = value

    return mutate


MUTATIONS = {
    "evento Schedule (AWS::Events::Rule)": _add_event(
        "Nightly", {"Type": "Schedule", "Properties": {"Schedule": "rate(1 day)"}}
    ),
    "evento SQS (AWS::Lambda::EventSourceMapping)": _add_event(
        "Queue",
        {"Type": "SQS", "Properties": {"Queue": "arn:aws:sqs:us-east-2:123456789012:fila"}},
    ),
    "FunctionUrlConfig (AWS::Lambda::Url)": _set_property(
        "FunctionUrlConfig", {"AuthType": "AWS_IAM"}
    ),
    "AutoPublishAlias (AWS::Lambda::Version e Alias)": _set_property("AutoPublishAlias", "live"),
    "Tracing na função (AWSXrayWriteOnlyAccess)": _set_property("Tracing", "Active"),
    "Tracing no Globals (AWSXrayWriteOnlyAccess)": _set_global("Tracing", "Active"),
}


def _app_guards() -> list[tuple[str, Any]]:
    """The tests of test_cd_pipeline_template.py that read the app template."""
    guards = []
    for name, function in inspect.getmembers(cd_tests, inspect.isfunction):
        if name.startswith("test_") and "app" in inspect.signature(function).parameters:
            guards.append((name, function))
    assert guards
    return guards


@pytest.mark.parametrize("change", sorted(MUTATIONS))
def test_cd_guards_fail_when_sam_adds_what_the_execution_role_does_not_cover(
    change: str,
) -> None:
    cd = _load(ROOT / "infra" / "cd-pipeline.yaml")
    app = copy.deepcopy(_load(ROOT / "infra" / "template.yaml"))
    MUTATIONS[change](app)
    caught = []
    for name, guard in _app_guards():
        arguments = {"cd": cd, "app": app}
        wanted = inspect.signature(guard).parameters
        try:
            guard(**{key: value for key, value in arguments.items() if key in wanted})
        except AssertionError:
            caught.append(name)

    assert caught, (
        f"Com {change} no infra/template.yaml, nenhum teste de "
        "tests/test_cd_pipeline_template.py falha, mas o papel de execução da esteira não "
        "cobre o que o SAM gera: o deploy falharia com AccessDenied."
    )
