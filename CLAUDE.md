# Tomiyama Exams

Sistema de exames de graduação de Judô. As especificações estão em [requirements/](requirements/):

- **Regras e modelo de dados:** `requisitos-exame-graduacao.md` (RN001–RN018).
- **Stack AWS:** `Arquitetura — Site Academia de Judô (AWS).md`. Quando os dois conflitam, vale a stack AWS. Pergunte antes de desviar de qualquer um deles.

Identificadores em inglês; mensagens ao usuário em pt-BR. Examinador = grupo Cognito `admin`; o sensei é um examinador escolhido nas configurações.

## Comandos (em `backend/`)

```bash
uv sync --python 3.12                        # dependências
uv run pytest -q                             # testes
uv run ruff check src tests scripts          # lint
uv run ruff format src tests scripts         # formatação
uv run cfn-lint ../infra/template.yaml       # template SAM
uv run python scripts/build_requirements_seed.py  # regenera os itens do Apêndice A
```

A esteira em `.github/workflows/ci.yml` roda lint, formatação, testes e cfn-lint em todo push e PR.

## Regras de trabalho

- **Todo erro apontado vira teste de regressão.** Antes de corrigir, escreva em `backend/tests/regression/` um teste que reproduza o erro e confirme que ele falha. Só então corrija. Use a branch `fix/*`; a esteira barra PRs `fix/*` sem teste nessa pasta. Formato em [backend/tests/regression/README.md](backend/tests/regression/README.md).
- Toda regra de negócio nova vem com teste nomeado pelo id (`test_rnXXX_*`).
- Camadas: `handlers/` (HTTP), `domain/` (regras puras, sem AWS), `repository/` (DynamoDB).
- Rode lint, formatação e testes antes de dar uma tarefa por concluída.
