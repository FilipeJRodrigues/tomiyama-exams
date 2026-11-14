"""README ainda dizia que a ficha recusa "qualquer perfil que não seja o principal".

Erro observado: na tabela de erros da marcação ("Exame do aluno e marcação"),
a linha do 400 "Item não pertence ao perfil de requisitos do exame" dizia
"(hoje, qualquer perfil que não seja o principal; #144)". Desde a etapa 3b-1 a
ficha usa o perfil do evento: num evento de outro perfil, o item do principal é
o recusado e o item do perfil do evento é aceito. O frontend lê o contrato no
README, então a linha levava a tratar o perfil principal como o único marcável.

Esperado: a linha descreve o item de um perfil que não é o do evento, sem
dizer que só o principal é aceito.
Issue: #144
"""

from pathlib import Path

README = Path(__file__).resolve().parents[2] / "README.md"
MESSAGE = '400 "Item não pertence ao perfil de requisitos do exame"'


def _error_table_rows() -> list[str]:
    lines = README.read_text(encoding="utf-8").splitlines()
    return [line for line in lines if line.startswith("|") and MESSAGE in line]


def test_rn006_readme_row_of_the_profile_refusal_names_the_events_profile() -> None:
    rows = _error_table_rows()

    assert rows, "a tabela de erros da marcação documenta a mensagem"
    for row in rows:
        assert "qualquer perfil que não seja o principal" not in row
        assert "evento" in row
