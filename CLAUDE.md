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
- **`frontend`** escreve o código em `frontend/` (TypeScript + React + Vite, Amplify Hosting) e devolve um relatório. Usa a API como está descrita em `backend/README.md`, não mexe no backend nem no git.
- **`qa`** testa o que vai subir no backend (`backend/` e `infra/`), e **`qa-frontend`** testa o que vai subir no frontend (`frontend/`), antes de cada commit. Quando a mudança toca os dois lados, rodam em paralelo. Para cada falha, escrevem um teste de regressão que falha (`backend/tests/regression/` ou `frontend/tests/regression/`), e o agente da área (`backend` ou `frontend`) corrige o código sem mexer no teste. Os QAs não corrigem código de produção.

Para trabalhar sem o master, remova a chave `agent` do `.claude/settings.json`. No terminal, `claude --agent backend` (ou `frontend`) abre uma sessão direto com o agente da área.

## Regras de trabalho

- **Todo erro apontado vira teste de regressão.** Antes de corrigir, escreva um teste que reproduza o erro e confirme que ele falha: em `backend/tests/regression/` (formato em [backend/tests/regression/README.md](backend/tests/regression/README.md)) ou em `frontend/tests/regression/` (`<issue ou data>-<assunto>.test.ts(x)`), conforme a área. Só então corrija. Use a branch `fix/*`; a esteira barra PRs `fix/*` sem teste numa dessas pastas.
- Toda regra de negócio nova vem com teste nomeado pelo id (`test_rnXXX_*`).
- Camadas: `handlers/` (HTTP), `domain/` (regras puras, sem AWS), `repository/` (DynamoDB).
- Rode lint, formatação e testes antes de dar uma tarefa por concluída.
