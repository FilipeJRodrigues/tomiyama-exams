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

## Quadro do projeto

O roteiro fica no GitHub Projects ["Tomiyama Exams"](https://github.com/users/FilipeJRodrigues/projects/1). Cada tarefa é um card (issue) que passa por Backlog → A fazer → Em andamento → Em QA → Pronto. Para mover e comentar, use `bash .claude/scripts/card.sh <issue> "<status>" ["comentário"]`. O PR fecha o card com `Closes #N`.

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

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- For any AWS task or question — building, configuring, migrating, debugging, or operating a service, writing SDK code, authoring CDK/CloudFormation, or answering how a service works — first call `aws___search_documentation` with topic `agent_skills` and load the matching skill with `aws___retrieve_skill`. Do this even when you believe you know the answer: skills carry current service behavior that your training may not. Prefer the skill's guidance over general knowledge. Skip it only for work that does not involve AWS.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

**help_level do usuário: HIGH**

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion

<!-- END AWS Agent Toolkit rules -->
<!-- teste da esteira por área (#67), não fazer merge -->
