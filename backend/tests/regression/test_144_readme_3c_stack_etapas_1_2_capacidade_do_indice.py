"""README da etapa 3c dizia que, numa stack das etapas 1 e 2, a tabela "só apaga o by_belt".

Erro observado: em "Ordem de deploy da etapa 3c", o parágrafo "Stack das etapas 1
e 2 do #144" afirma que o deploy da 3c "é aceito, porque só apaga o `by_belt`".
Numa stack das etapas 1 e 2, o `by_profile_belt` tem 1 RCU (`DevCapacity`
daquelas etapas: `RequirementsByProfileBelt` Read 1, Write 4); a etapa 3a o
passou para 5 RCU, e a 3c mantém 5. A mesma atualização da tabela, então, apaga
o `by_belt` **e** muda a RCU do `by_profile_belt` (1 → 5): o motivo dado é
desmentido pelo template, e é o tipo de combinação que o próprio README, em
"Primeiro deploy do dev com a etapa 3a", trata como uma que o CloudFormation
pode recusar (o DynamoDB aplica uma mudança de índice por vez).

Esperado: o parágrafo não diz que a atualização "só apaga o `by_belt`" e cita o
`by_profile_belt`, cuja capacidade muda no mesmo deploy.
Issue: #144
"""

from pathlib import Path

from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
TEMPLATE = ROOT / "infra" / "template.yaml"
PARAGRAPH_START = "**Stack das etapas 1 e 2 do #144**"
# DevCapacity do by_profile_belt nas etapas 1 e 2 do #144 (commits f5abda3 e 79a6e44).
STEPS_1_2_PROFILE_INDEX = {"Read": 1, "Write": 4}


def _paragraph() -> str:
    lines = README.read_text(encoding="utf-8").splitlines()
    found = [line for line in lines if line.startswith(PARAGRAPH_START)]
    assert len(found) == 1, f"o README deveria ter um parágrafo {PARAGRAPH_START!r}"
    return found[0]


def test_readme_steps_1_2_stack_update_also_changes_the_profile_index() -> None:
    template, errors = decode(str(TEMPLATE))
    assert not errors, errors
    profile_index = template["Mappings"]["DevCapacity"]["RequirementsByProfileBelt"]
    paragraph = _paragraph()

    # A premissa: a 3c muda a capacidade do by_profile_belt de uma stack das etapas 1 e 2.
    assert profile_index != STEPS_1_2_PROFILE_INDEX
    assert "só apaga o `by_belt`" not in paragraph
    assert "by_profile_belt" in paragraph
