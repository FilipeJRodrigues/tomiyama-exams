# Backend — exames de graduação de Judô

Python 3.12 em AWS Lambda, DynamoDB on-demand, Cognito e API Gateway (HTTP API).
A infraestrutura fica em [`../infra/template.yaml`](../infra/template.yaml) (AWS SAM).

## Estrutura

```
src/
├── handlers/    # uma função Lambda por rota + utilitários HTTP
├── domain/      # regras de negócio puras (RN001–RN018), sem acesso à AWS
└── repository/  # acesso ao DynamoDB
tests/           # pytest + moto; testes de regra nomeados test_rnXXX_*
```

## Testes

```bash
cd backend
uv sync --python 3.12
uv run pytest
```

## Deploy

Precisa do [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).

```bash
sam build -t infra/template.yaml
sam deploy --guided   # pede AdminEmail, AllowedOrigin e BudgetLimitUsd
```

No primeiro deploy:

- o examinador inicial (`AdminEmail`) recebe uma senha temporária por e-mail;
- as faixas (§ 4 dos requisitos) e os 692 itens do Apêndice A são carregados pelo recurso `InitialData`. A carga é idempotente e não sobrescreve edições. Os itens só entram uma vez: um item apagado na tela não volta no próximo deploy.

## Itens de exame (Apêndice A)

`src/seed_data/requirements.json` é gerado a partir de `requirements/requisitos-exame-graduacao.md`:

```bash
uv run python scripts/build_requirements_seed.py
```

O script confere as contagens de cada faixa com o cabeçalho do documento. Um teste falha se o JSON commitado ficar diferente do documento.

## Autenticação

O front envia o **ID token** do Cognito no cabeçalho `Authorization`. Os perfis são:

- grupo `admin`: examinadores;
- grupo `responsavel`: quem se cadastra pelo site. O gatilho pós-confirmação coloca a conta nesse grupo.

O sensei é escolhido entre os examinadores, nas configurações da academia.

## Rotas implementadas

| Método | Rota | Quem |
| --- | --- | --- |
| GET | /belts | qualquer usuário logado |
| PUT | /belts/{id} | examinador |
| GET | /students | examinador: todos; responsável: os próprios |
| POST | /students | qualquer usuário logado (dono = usuário do token) |
| GET/PUT/DELETE | /students/{id} | dono ou examinador |
| GET | /requirements | examinador |
| POST | /requirements | examinador |
| PUT/DELETE | /requirements/{id} | examinador |

`GET /students` aceita os filtros `active=true|false`, `belt_id` e `reference_date=AAAA-MM-DD`. O último é a data da elegibilidade; sem ele, vale a data de hoje.

`GET /requirements` aceita os filtros `belt_id` e `kind=THEORY|PRACTICE`. Sem filtro, devolve todos os itens na ordem das faixas e da folha. No `POST`, sem `sort_order`, o item vai para o fim da faixa.
