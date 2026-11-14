"""README da etapa 3c citava capacidades que não mudam quando o passo 1 é pulado.

Erro observado: em "Ordem de deploy da etapa 3c", o parágrafo "Se alguém pular
o passo 1" (uma stack anterior aos perfis, como o dev hoje, atualizada direto
para a 3c) diz que o que muda em paralelo à tabela, e volta no rollback, é "por
exemplo, a capacidade de `Students` e `Answers`". Em todas as versões do
template anteriores aos perfis (desde que a tabela `Answers` existe), `Students`
e `StudentsByOwner` têm 2 WCU e `Answers` 3 WCU, os mesmos valores do
`DevCapacity` da 3c: nesse deploy nada muda nelas. O que muda em paralelo é a
RCU de `Belts` (3 → 2, desde a etapa 1). O operador que conferir os eventos da
stack não vai achar a mudança que o README anuncia.

Esperado: o parágrafo só cita, como capacidades alteradas em paralelo, as que de
fato diferem entre o template anterior aos perfis e o atual (ou não cita nenhuma).
Issue: #144
"""

import re
from pathlib import Path

from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "backend" / "README.md"
TEMPLATE = ROOT / "infra" / "template.yaml"
PARAGRAPH_START = "**Se alguém pular o passo 1**"
# DevCapacity de toda versão do template anterior aos perfis (de 54f142d, que
# criou Answers, a 60fb191, a última antes da etapa 1 do #144), sem o by_belt.
PRE_PROFILES_DEV_CAPACITY = {
    "Belts": {"Read": 3, "Write": 1},
    "Students": {"Read": 3, "Write": 2},
    "StudentsByOwner": {"Read": 2, "Write": 2},
    "Exams": {"Read": 2, "Write": 3},
    "ExamsByStudent": {"Read": 1, "Write": 1},
    "Requirements": {"Read": 3, "Write": 4},
    "Settings": {"Read": 1, "Write": 1},
    "Events": {"Read": 2, "Write": 3},
    "Answers": {"Read": 3, "Write": 3},
}


def _paragraph() -> str:
    lines = README.read_text(encoding="utf-8").splitlines()
    found = [line for line in lines if line.startswith(PARAGRAPH_START)]
    assert len(found) == 1, f"o README deveria ter um parágrafo {PARAGRAPH_START!r}"
    return found[0]


def test_readme_skipping_step_1_names_only_capacities_that_change() -> None:
    template, errors = decode(str(TEMPLATE))
    assert not errors, errors
    current = template["Mappings"]["DevCapacity"]
    changed = {
        name
        for name, units in PRE_PROFILES_DEV_CAPACITY.items()
        if name in current and current[name] != units
    }
    named = set(re.findall(r"`(\w+)`", _paragraph())) & set(current)

    assert changed == {"Belts"}  # o que de fato muda em paralelo à tabela
    assert named <= changed, (
        f"o parágrafo cita como alteradas capacidades que não mudam: {sorted(named - changed)}"
    )
