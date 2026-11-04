# Arquitetura — Site Academia de Judô (AWS)

## Instruções para o agente

Este documento é a especificação do projeto. Siga as regras abaixo; em caso de dúvida ou conflito, pergunte antes de implementar.

**Objetivo:** site de uma academia de judô onde pais cadastram os filhos e a administração registra exames de faixa.

**Stack obrigatória (use):**

- Back-end: Python 3.12 em AWS Lambda, com boto3.
- Front-end: TypeScript + React + Vite, hospedado no AWS Amplify Hosting.
- API: Amazon API Gateway (HTTP API) com autorizador JWT do Cognito.
- Autenticação: Amazon Cognito, com os grupos `admin`, `responsavel` e `master`. *(decisão do responsável, 2026-11-02)* `master`: examinador com poder extra (fica também em `admin`); único que escolhe/troca o sensei; gere as assinaturas do certificado; não decide exames; o primeiro examinador já nasce master, outros só pelo console do Cognito.
- Banco: Amazon DynamoDB em modo on-demand.
- Infraestrutura como código: AWS SAM (`infra/template.yaml`).
- Testes: pytest + moto no back-end.

**Não use:**

- Node.js ou outra linguagem no back-end; não misture linguagens nas Lambdas.
- Servidores ou recursos com custo fixo: EC2, ECS, RDS/Aurora, NAT Gateway.
- Recursos criados manualmente no console: tudo passa pelo template SAM.
- Segredos, chaves ou IDs de conta no código ou no repositório.
- Bibliotecas ou APIs que você não tenha certeza de que existem.

**Padrões de código:**

- Type hints, docstrings no padrão Google, `logging` em vez de `print`, PEP 8.
- Funções pequenas, separadas em `handlers/`, `domain/` e `repository/`.
- Toda regra de negócio nova vem com teste em pytest.

**Regras de negócio que não podem ser quebradas:**

- O `responsavel_id` vem sempre do token JWT, nunca do corpo da requisição.
- Um responsável só lê e edita os próprios filhos.
- Só o grupo `admin` registra exames e altera a faixa.
- Exame aprovado e atualização da faixa são gravados na mesma transação.
- Nenhum dado de aluno aparece em página pública (LGPD).

## Contexto e requisitos

- Até 150 alunos.
- Acesso concentrado em 1 a 2 meses por ano (período de exames de faixa).
- Armazenar o cadastro dos alunos e atualizar os dados a cada exame.
- Objetivo secundário: ganhar familiaridade com serviços AWS.
- Prioridades: custo perto de zero quando ocioso, simplicidade e pouca manutenção.

**Decisão:** arquitetura 100% serverless, com cobrança por uso. Nada roda (nem cobra) nos meses parados.

## Visão geral

Fluxo: Navegador → Amplify Hosting (site estático) → Cognito (login) → API Gateway (HTTP API) → Lambda (Python) → DynamoDB.

| Camada | Serviço AWS | Papel |
| --- | --- | --- |
| Front-end | AWS Amplify Hosting | Hospeda o site estático com CDN e HTTPS, além de deploy automático a partir do Git |
| Autenticação | Amazon Cognito (User Pool) | Login de administradores e pais, com grupos de permissão admin, responsavel e master *(decisão do responsável, 2026-11-02)* |
| API | Amazon API Gateway (HTTP API) | Endpoints REST protegidos por JWT do Cognito |
| Lógica | AWS Lambda (Python 3.12) | Regras de negócio: cadastro, exames e promoção de faixa |
| Dados | Amazon DynamoDB (on-demand) | Alunos e histórico de exames |
| Observabilidade | Amazon CloudWatch | Logs, métricas e alarmes das Lambdas |
| Custos | AWS Budgets | Alerta de gasto acima de um limite baixo |
| Infraestrutura | AWS SAM (ou CDK) | Infraestrutura como código, versionada no repositório |

## Modelo de dados (DynamoDB)

Duas tabelas, ambas no modo de capacidade on-demand.

**Tabela `alunos`**

- PK: `aluno_id` (UUID)
- Atributos: `nome`, `data_nascimento`, `responsavel_nome`, `responsavel_contato`, `faixa_atual`, `data_ultima_graduacao`, `ativo`, `criado_em`, `atualizado_em`

**Tabela `exames`**

- PK: `aluno_id`
- SK: `data_exame#faixa_pretendida` (ex.: `2027-06-15#amarela`)
- Atributos: `faixa_pretendida`, `resultado` (aprovado/reprovado/pendente), `avaliador`, `observacoes`, `registrado_em`
- GSI opcional `por_data`: PK `data_exame` para listar todos os avaliados de um evento.

**Faixas:** lista fixa, mantida em um arquivo de configuração no código (ordem e tempo mínimo entre graduações). Não precisa de tabela.

**Regra de atualização:** ao registrar um exame aprovado, uma única transação (`TransactWriteItems`) grava o exame e atualiza `faixa_atual` e `data_ultima_graduacao` do aluno. Isso garante consistência: nunca fica um exame aprovado sem a faixa atualizada.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | /alunos | Lista alunos (filtro por ativo/faixa) |
| POST | /alunos | Cadastra aluno |
| GET | /alunos/{id} | Detalhe do aluno e histórico de exames |
| PUT | /alunos/{id} | Atualiza cadastro |
| POST | /alunos/{id}/exames | Registra exame (e promove a faixa se aprovado) |
| GET | /exames?data=AAAA-MM-DD | Lista exames de um evento |

Todas as rotas de escrita exigem usuário no grupo `admin` do Cognito.

## Acesso dos pais

Os pais criam conta no Cognito (grupo `responsavel`) e cadastram quantos filhos tiverem.

- Cada aluno ganha o atributo `responsavel_id` = o `sub` do usuário no Cognito.
- GSI `por_responsavel` na tabela `alunos` (PK `responsavel_id`) para listar os filhos de um responsável.
- A Lambda lê o `responsavel_id` do token JWT, nunca do corpo da requisição: um pai só vê e edita os próprios filhos.
- Registro de exames e mudança de faixa continuam exclusivos do grupo `admin`.
- Novas rotas: `GET /me/alunos` (filhos do responsável logado) e `POST /me/alunos` (cadastra filho).
- Ativar verificação de e-mail no cadastro do Cognito e coletar o consentimento do responsável (LGPD).

## Linguagens

| Camada | Linguagem / stack | Motivo |
| --- | --- | --- |
| Back-end | Python 3.12 (Lambda + boto3) | Linguagem que o time já domina; suporte nativo na Lambda; testes com pytest e moto |
| Front-end | TypeScript + React + Vite | Padrão de mercado; tipagem pega erros antes de rodar; facilita manutenção dos formulários e telas logadas |
| Infraestrutura | YAML (AWS SAM) | Declarativo e simples para poucos recursos |

Node.js seria uma alternativa válida no back-end (uma linguagem só no projeto inteiro, cold start um pouco menor), mas foi preterido por exigir aprender outra linguagem além da AWS.

## Segurança e LGPD

- Os dados são pessoais e provavelmente incluem menores: coletar só o necessário e guardar o contato do responsável.
- Nenhum dado de aluno em página pública; tudo atrás de login.
- IAM com menor privilégio: cada Lambda acessa só as tabelas de que precisa.
- Criptografia em repouso (padrão no DynamoDB) e HTTPS (padrão no Amplify/API Gateway).
- Point-in-time recovery ligado nas duas tabelas, para backup contínuo.
- Definir quem pode pedir exclusão de dados e como atender (rota ou processo manual).

## Custos

- Todos os serviços escolhidos cobram por uso, e no volume previsto o gasto tende a ficar dentro ou perto do nível gratuito.
- Confirmar os limites atuais do nível gratuito de cada serviço na página de preços da AWS antes de subir.
- Criar um alerta no AWS Budgets (ex.: US$ 5/mês) logo no primeiro dia.

## Estrutura do repositório (scaffold)

```
academia-judo/
├── frontend/            # site estático (HTML/JS ou React/Vite)
├── backend/
│   ├── src/
│   │   ├── handlers/    # uma função por rota
│   │   ├── domain/      # regras: faixas, promoção
│   │   └── repository/  # acesso ao DynamoDB
│   └── tests/           # pytest + moto
├── infra/
│   └── template.yaml    # AWS SAM
└── .github/workflows/   # CI: testes e deploy
```

## Divisão sugerida em agentes (Claude Code)

1. **Front-end:** páginas públicas, tela de login e painel de alunos/exames.
2. **Back-end e dados:** Lambdas, modelo DynamoDB e template SAM.
3. **Qualidade:** testes com pytest/moto, revisão de segurança e LGPD.

## Decisões e alternativas

- **DynamoDB × RDS/Aurora:** DynamoDB não tem custo fixo e não exige gerenciar servidor. Se no futuro surgirem muitos relatórios cruzados (ex.: ranking por turma e idade), vale reavaliar um banco relacional.
- **SAM × CDK:** SAM é mais simples para começar. CDK compensa se a infraestrutura crescer.

## Pontos em aberto

- Os pais poderão ver o histórico de exames dos filhos ou apenas o cadastro?
- Domínio próprio para o site.
- Haverá pagamento de taxa de exame pelo site?
<!-- teste da esteira por área (#67), não fazer merge -->
