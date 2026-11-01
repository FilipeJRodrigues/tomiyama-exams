# Testes de regressão

Todo erro encontrado, seja num relato, numa revisão ou no uso, ganha aqui um teste que o reproduz. Esse teste roda para sempre na esteira de CI.

## Como corrigir um erro

1. Crie uma branch `fix/<descrição-curta>`. A esteira exige que PRs dessas branches tragam um teste nesta pasta.
2. Escreva o teste **antes** da correção e confirme que ele falha.
3. Corrija o código e confirme que o teste passa.
4. Abra o PR referenciando a issue, se houver.

## Formato

- **Arquivo:** um por erro, `test_<issue ou data>_<assunto>.py`. Exemplos: `test_42_carencia_fim_do_mes.py` e `test_2026_11_02_grupos_jwt.py`.
- **Docstring do módulo:** o erro observado, o comportamento esperado e o link da issue, se houver.
- **Fixtures e helpers:** reutilize os do [`conftest.py`](../conftest.py), por exemplo `from conftest import api_event`.
- **Regra de negócio:** se o erro quebrava uma regra RNxxx, inclua o id no nome do teste, por exemplo `test_rn002_...`.

```python
"""Carência contava errado quando a faixa começou no dia 31.

Esperado: de 31/01 a 28/02 conta 1 mês completo.
Issue: #42
"""

from datetime import date

from domain.dates import full_months


def test_rn002_month_ending_on_shorter_month() -> None:
    assert full_months(date(2026, 1, 31), date(2026, 2, 28)) == 1
```

Nunca apague um teste de regressão para fazer a esteira passar. Se a regra mudou de propósito, atualize o teste e explique a mudança no PR.
