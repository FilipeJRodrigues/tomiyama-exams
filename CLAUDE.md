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

## Agentes

Os agentes ficam em [.claude/agents/](.claude/agents/):

- **`master`** é a sessão principal, configurada em `.claude/settings.json`. Ele escolhe o passo do roteiro, delega, revisa o diff, roda a verificação e cuida de branch, commit, PR e merge. Pede aprovação antes de cada passo de git.
- **`backend`** escreve o código em `backend/` e `infra/` e devolve um relatório. Não mexe no git.
- **`qa`** testa tudo que vai subir, no backend e no frontend, antes de cada commit. Para cada falha, escreve um teste de regressão que falha (`backend/tests/regression/` ou `frontend/tests/regression/`), e o `backend` corrige o código sem mexer no teste. O `qa` não corrige código de produção.

Para trabalhar sem o master, remova a chave `agent` do `.claude/settings.json`. No terminal, `claude --agent backend` abre uma sessão direto com o agente de backend.

## Regras de trabalho

- **Todo erro apontado vira teste de regressão.** Antes de corrigir, escreva em `backend/tests/regression/` um teste que reproduza o erro e confirme que ele falha. Só então corrija. Use a branch `fix/*`; a esteira barra PRs `fix/*` sem teste nessa pasta. Formato em [backend/tests/regression/README.md](backend/tests/regression/README.md).
- Toda regra de negócio nova vem com teste nomeado pelo id (`test_rnXXX_*`).
- Camadas: `handlers/` (HTTP), `domain/` (regras puras, sem AWS), `repository/` (DynamoDB).
- Rode lint, formatação e testes antes de dar uma tarefa por concluída.
