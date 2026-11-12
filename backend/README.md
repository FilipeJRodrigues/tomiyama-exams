# Backend — exames de graduação de Judô

Python 3.12 em AWS Lambda, DynamoDB (provisionado no dev, on-demand no prod), S3 (imagens, privado), Cognito e API Gateway (HTTP API).
A infraestrutura fica em [`../infra/template.yaml`](../infra/template.yaml) (AWS SAM).

## Estrutura

```
src/
├── handlers/    # uma função Lambda por rota + utilitários HTTP
├── domain/      # regras de negócio puras (RN001–RN018), sem acesso à AWS
└── repository/  # acesso ao DynamoDB, ao S3 (imagens) e (leitura) ao Cognito
tests/           # pytest + moto; testes de regra nomeados test_rnXXX_*
```

## Testes

```bash
cd backend
uv sync --python 3.12
uv run pytest
```

Os testes de aceitação ficam em `tests/acceptance/` e rodam junto com os demais no `uv run pytest`; os de regressão ficam em `tests/regression/`. Os de aceitação passam só pelas rotas HTTP, com a carga inicial real (faixas do § 4 e itens do Apêndice A), usuários do Cognito simulado e relógio fixo:

- `test_flow_section9.py`: o fluxo completo do § 9 dos requisitos até a aprovação e a lista do dia sem leituras por aluno do § 8;
- por regra de negócio (`test_rnXXX_*`), o caso que cumpre e o caso que viola cada uma: `test_acceptance_rn001_rn004.py` (elegibilidade), `test_acceptance_rn005_rn010.py` (exame, com a RN008a) e `test_acceptance_rn012_rn018.py` (cadastros e configurações). A RN011 (certificado em PDF) ainda não tem teste de aceitação (card #98);
- `acceptance_support.py`: os auxiliares comuns (relógio, carga inicial, usuários e atalhos das rotas). Não é um `conftest.py` porque a pasta não tem `__init__.py`, e um segundo `conftest` esconderia o de `tests/`. Pelo mesmo motivo, nenhum arquivo de teste daqui pode repetir o nome de um arquivo de `tests/` ou de `tests/regression/`.

## Deploy

Precisa do [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). Os comandos rodam dentro de `infra/`.

### Parâmetros do template

| Parâmetro | Padrão | Uso |
| --- | --- | --- |
| `AdminEmail` | (obrigatório) | Primeiro examinador; recebe a senha temporária e os alertas do Budgets. |
| `AllowedOrigin` | `http://localhost:5173` | Lista de origens liberadas no CORS, separadas por vírgula; veja "CORS e Amplify" abaixo. |
| `BudgetLimitUsd` | `1` | Limite mensal (US$) do alerta do AWS Budgets: e-mail ao passar de 80% do real e de 100% da previsão. |
| `Environment` | `dev` | `dev` ou `prod`; veja a tabela abaixo. |

| | `dev` | `prod` |
| --- | --- | --- |
| DynamoDB | `PROVISIONED`, 25 RCU e 24 WCU somando as 7 tabelas e os 3 GSIs (free tier permanente: até 25/25), sem auto scaling | `PAY_PER_REQUEST` |
| PITR | desligado | ligado |
| Retenção dos logs das funções | 7 dias | 30 dias |
| Tabelas e bucket de imagens ao apagar a stack | apagados (o bucket precisa estar vazio) | mantidos |
| Pool do Cognito (contas, grupos e vínculos) ao apagar a stack | apagado | mantido, com proteção contra exclusão |

**Atenção no dev:** apagar a stack dev (ou o rollback de um primeiro deploy que falhou) apaga as tabelas e os dados de teste. Se sobrar tabela de um deploy antigo (de antes desta regra, por exemplo), apague-a antes de reimplantar: ela continua provisionada e ocupa parte dos 25 RCU/WCU do free tier. No prod as tabelas ficam (`DeletionPolicy` e `UpdateReplacePolicy` `Retain`). O template usa a transform `AWS::LanguageExtensions` para escolher a política pelo ambiente, por isso o deploy pede `CAPABILITY_AUTO_EXPAND`.

As capacidades de cada tabela e GSI ficam no mapping `DevCapacity` do template; `tests/test_template.py` falha se a soma passar de 25. Cada marcação de item (RN006) é uma transação que custa 2 WCU em `Exams`, em `Events` e em `Answers` (e mais 2 em `Requirements`, além da escrita no GSI `by_belt`, na primeira marcação do item); com 3 WCU em cada uma, o dev aguenta em média 1,5 marcação por segundo somando todos os examinadores, com folga para picos curtos (burst do DynamoDB). O free tier vale para a conta inteira na região: outra stack provisionada na mesma conta e região soma no mesmo limite.

**Bucket de imagens no dev.** O CloudFormation só apaga bucket vazio. Se houver logos ou assinaturas carregados, esvazie o bucket antes de apagar a stack dev (`aws s3 rm s3://<bucket> --recursive`; o nome está no recurso `ImagesBucket` da stack); senão a exclusão fica em `DELETE_FAILED` só nesse recurso e pode ser repetida depois de esvaziar. No prod o bucket fica (`Retain`), como as tabelas.

**Pool do Cognito no prod.** Os alunos guardam o `sub` do responsável em `owner_id` (RN013): um pool novo traz contas com outros `sub` e quebra o vínculo de cada responsável com os próprios alunos. Por isso, no prod, o `UserPool` e o que guarda dados dentro dele (os grupos `admin`, `master` e `responsavel`, o examinador inicial e os vínculos dele com `admin` e `master`) têm `DeletionPolicy` e `UpdateReplacePolicy` `Retain`. O `UserPoolClient` não guarda dados e segue a stack nos dois ambientes; um client novo só muda o `UserPoolClientId` da configuração do front e pede novo login. No dev nada muda: tudo é apagado com a stack.

- **Proteção contra exclusão.** No prod o pool tem `DeletionProtection: ACTIVE`: nem o Console nem a CLI apagam o pool enquanto ela estiver ligada.
- **`Retain` não impede substituição.** Mudar uma propriedade que o Cognito não altera num pool existente faz o update falhar, sem criar outro pool. A troca de pool acontece se o id lógico (`UserPool`) ou o tipo do recurso mudar, ou se a AWS passar a tratar alguma propriedade como fixa: o CloudFormation cria outro pool e passa a stack (e o front, pelos `Outputs`) para ele; o antigo fica retido, mas sem uso. Antes de executar um deploy no prod, gere o change set sem executá-lo (`sam deploy --no-execute-changeset`, ou `confirm_changeset = true` no `samconfig.toml`) e confira se o `UserPool` aparece com `Replacement` `True` (ou `Conditional`); se aparecer, não execute. Uma proteção a mais, não implementada, é uma stack policy no prod que negue `Update:Replace` no recurso `UserPool` (`aws cloudformation set-stack-policy`).
- **Se o primeiro deploy prod falhar,** o rollback também respeita o `Retain`: sobram o pool (com `DeletionProtection` ligada), os grupos e o examinador inicial, que já recebeu a senha temporária. Antes de tentar de novo, desligue a proteção (`aws cognito-idp update-user-pool --user-pool-id <id> --deletion-protection INACTIVE`) e apague o pool órfão. As tabelas e o bucket retidos pedem o mesmo cuidado: apague-os antes do novo deploy.
- **Não troque o `AdminEmail` no prod depois do primeiro deploy.** O `Username` e os `UserAttributes` do `FirstAdminUser`, e o `Username` dos vínculos, só são definidos na criação: trocar o `AdminEmail` substitui esses três recursos, e com `Retain` o examinador antigo continua no pool e nos grupos. No prod, examinadores e masters se gerenciam pelo Console ou pela CLI.
- **Se a stack prod for apagada,** o pool fica órfão: o gatilho PostConfirmation aponta para uma função que deixou de existir, e novos cadastros falham na confirmação. Para voltar, importe na stack nova (resource import) o pool, os grupos, o examinador inicial e os vínculos, em vez de criá-los de novo.

Todas as funções escrevem no log group `/aws/lambda/<stack>`, um stream por função.

### CORS e Amplify

`AllowedOrigin` é uma lista (`CommaDelimitedList`): as origens vão separadas por vírgula, sem espaço, e cada uma é `esquema://host[:porta]`, **sem barra no fim** e sem caminho (o navegador compara a origem exata). O template recusa `*`, `http://` fora de `http://localhost` e letras maiúsculas (`AllowedPattern`, conferido em cada item): a API aceita o cabeçalho `Authorization`, e `*` deixaria qualquer site chamá-la com um token.

- **dev:** o front local e o do Amplify, `AllowedOrigin="http://localhost:5173,https://main.<appid>.amplifyapp.com"`;
- **prod:** só o domínio do Amplify, `AllowedOrigin=https://main.<appid>.amplifyapp.com`.

O `<appid>` aparece no console do Amplify depois de criar o app. Na linha de comando, acrescente o par ao `--parameter-overrides`; no `samconfig.toml`, veja a linha comentada em `infra/samconfig.example.toml` (as aspas internas vão escapadas, `\"`). Sem o parâmetro, vale só `http://localhost:5173`; numa stack que já existe, o `sam deploy` reaproveita o valor anterior.

### Deploy do dev

```bash
cd infra
sam build
sam deploy --stack-name tomiyama-dev --region us-east-2 --profile tomiyama \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --resolve-s3 \
  --parameter-overrides Environment=dev AdminEmail=voce@example.com
```

Ou, com o arquivo de configuração: copie `infra/samconfig.example.toml` para `infra/samconfig.toml` (ignorado pelo git), troque o `AdminEmail` e rode `sam build --config-env dev` e `sam deploy --config-env dev`. Não versione e-mail real.

No primeiro deploy:

- o examinador inicial (`AdminEmail`) recebe uma senha temporária por e-mail;
- as faixas (§ 4 dos requisitos) e os 692 itens do Apêndice A são carregados pelo recurso `InitialData`. A carga é idempotente e não sobrescreve edições. Os itens só entram uma vez: um item apagado na tela não volta no próximo deploy.

**Carga inicial no dev.** Com 4 WCU em `Requirements` e no GSI `by_belt`, os 692 itens levam cerca de 3 minutos (cada gravação ocupa 1 WCU na tabela e 1 no GSI). Gravações barradas por falta de capacidade são repetidas com backoff exponencial. A `SeedFunction` tem timeout de 900 s; a carga para 60 s antes disso e responde `FAILED` ao CloudFormation com o motivo, para a stack não ficar travada. Se a função cair sem responder, o CloudFormation desiste depois de 960 s (`ServiceTimeout`).

## Itens de exame (Apêndice A)

`src/seed_data/requirements.json` é gerado a partir de `requirements/requisitos-exame-graduacao.md`:

```bash
uv run python scripts/build_requirements_seed.py
```

O script confere as contagens de cada faixa com o cabeçalho do documento. Um teste falha se o JSON commitado ficar diferente do documento.

## Autenticação

O front envia o **ID token** do Cognito no cabeçalho `Authorization`. Os perfis são:

- grupo `admin`: examinadores;
- grupo `master`: administrador master, um examinador (fica em `admin` **e** `master`) que, além do resto, escolhe e troca o sensei. Quem está só em `master`, sem `admin`, não é tratado como master nem como examinador. O template põe o primeiro examinador (`AdminEmail`) nos dois grupos; outros masters só pelo Console ou pela CLI (`aws cognito-idp admin-add-user-to-group --group-name master`). Nenhuma rota da API altera grupos;
- grupo `responsavel`: quem se cadastra pelo site. O gatilho pós-confirmação coloca a conta nesse grupo.

O sensei é escolhido pelo master entre os examinadores, nas configurações da academia. O master não decide exames: a decisão (RN008) continua só do sensei. No código, `current_user(event)` devolve `is_examiner` e `is_master` (da claim `cognito:groups`); `require_examiner` e `require_master` barram com 403.

**E-mail sem distinção de maiúsculas.** O nome de usuário é o e-mail, e o pool tem `UsernameConfiguration.CaseSensitive: false`: `Mae.Silva@example.com` e `mae.silva@example.com` são a mesma conta. O front também normaliza o e-mail para minúsculas antes de cadastrar e entrar. Essa opção só é definida na criação do pool, e o CloudFormation não recria o pool sozinho ao mudá-la: mudá-la exige apagar e recriar o pool (no dev, apagar e recriar a stack). Isso gera novos `UserPoolId` e `UserPoolClientId` (atualize a configuração do front), apaga as contas (o examinador inicial recebe uma nova senha temporária) e, como os alunos guardam o `sub` do dono (`owner_id`), quebra o vínculo dos responsáveis com os próprios alunos. A decisão já está tomada para o dev e o prod (`CaseSensitive: false`, decidido em 2026-11-02); não mude essa opção no template.

## Rotas implementadas

| Método | Rota | Quem |
| --- | --- | --- |
| GET | /belts | qualquer usuário logado |
| PUT | /belts/{id} | examinador |
| GET | /students | examinador: todos; responsável: os próprios |
| POST | /students | qualquer usuário logado (dono = usuário do token) |
| GET/PUT/DELETE | /students/{id} | dono ou examinador |
| GET | /students/{id}/exams | examinador (histórico, RN018) |
| GET | /students/{id}/exam-notices | responsável dono do aluno (avisos de exame, RN019) |
| GET | /requirements | examinador |
| POST | /requirements | examinador |
| PUT/DELETE | /requirements/{id} | examinador |
| GET | /events | examinador |
| POST | /events | examinador |
| GET/PUT/DELETE | /events/{id} | examinador |
| GET | /events/{id}/exams | examinador |
| POST | /events/{id}/exams | examinador |
| GET | /events/{id}/exams/{student_id} | examinador |
| PUT/DELETE | /events/{id}/exams/{student_id}/answers/{requirement_id} | examinador |
| POST | /events/{id}/exams/{student_id}/decision | examinador (só o sensei decide) |
| GET/PUT | /settings | examinador |
| GET/PUT/DELETE | /settings/logos/{slot} | examinador |
| GET/POST | /settings/signatures | master e sensei |
| PUT | /settings/signatures/order | master e sensei |
| PUT/DELETE | /settings/signatures/{id} | master e sensei |
| GET/PUT/DELETE | /settings/signatures/{id}/image | master e sensei |
| GET | /examiners | examinador |

### Erros comuns

Valem para todas as rotas que recebem corpo (`POST` e `PUT`), com ou sem `isBase64Encoded`, e saem no mesmo formato `{"message": ...}` das outras respostas:

| Situação | Resposta |
| --- | --- |
| corpo ausente, que não é UTF-8 nem base64 válido (como uma imagem crua), JSON malformado ou aninhado demais, inteiro com mais de 4300 dígitos, `NaN`/`Infinity`/`-Infinity`, número que estoura para infinito (como `1e999`) ou JSON que não é um objeto | 400 "Corpo da requisição inválido: envie um objeto JSON" |
| corpo acima de 3 MiB (3.145.728 bytes em UTF-8; com `isBase64Encoded`, o texto base64 é conferido antes de decodificar) | 413 "Corpo da requisição grande demais" |

O teto de 3 MiB cabe o maior corpo legítimo, o envio de um logo de 2 MB (cerca de 2,8 MB de JSON, por causa do base64), e fica abaixo do limite de 6 MB da Lambda. O tamanho é conferido antes da leitura do JSON, e nada é gravado.

**Id inválido no caminho.** Em todas as rotas com id no caminho (`/students/{id}`, `/students/{id}/exams`, `/events/{id}`, `/events/{id}/exams`, `/events/{id}/exams/{student_id}` e suas subrotas `.../answers/{requirement_id}` e `.../decision`, `/requirements/{id}` e `/belts/{id}`), um id vazio ou com mais de 1024 bytes em UTF-8 responde 404 com a mensagem do recurso, a mesma de um id que não existe: "Aluno não encontrado", "Evento não encontrado", "Exame não encontrado" (para `{student_id}`), "Requisito não encontrado" ou "Faixa não encontrada". O id é conferido depois da permissão e antes de qualquer leitura, então nada chega ao DynamoDB e a ordem das respostas é a de um id inexistente: nas rotas só de examinador, o responsável recebe 403 antes; em `/students/{id}`, o responsável recebe o 404 (RN013). O limite de 1024 bytes é o da chave de ordenação do DynamoDB (a de partição aceita 2048) e vale para todos os ids; nenhum id gerado pela API chega perto dele. Antes do #92, esses ids respondiam 500. As rotas de logos e assinaturas têm a própria validação (veja cada seção).

**Limite de capacidade do DynamoDB.** Em qualquer rota, com ou sem corpo, o limite de capacidade do DynamoDB (`ProvisionedThroughputExceededException`, `ThrottlingException` ou `RequestLimitExceeded`) que persiste depois das novas tentativas do botocore responde 503 "Sistema ocupado no momento. Tente de novo em instantes." (só essa mensagem), e nada é gravado no DynamoDB; a mesma requisição pode ser reenviada. Vale para as leituras por chave (`GetItem`), as listas e consultas (`Scan` e `Query`, em todas as páginas), os `BatchGetItem`, as releituras depois de uma gravação recusada e as gravações: cadastro, edição e exclusão de faixa, evento, requisito e aluno, as configurações e as transações. As gravações de um item não têm novas tentativas próprias, porque o botocore já as repetiu; as transações da presença, da marcação e da decisão repetem algumas vezes, com espera crescente, o cancelamento por limite dentro da transação (veja cada seção). Nos `BatchGetItem` (os nomes dos alunos de `GET /events/{id}/exams` e os eventos do histórico, RN018), as chaves que o DynamoDB devolve em `UnprocessedKeys` por falta de capacidade são pedidas de novo até 3 vezes, com espera crescente (de 0,05 a 0,4 s, no máximo 0,7 s somadas), e, se ainda sobrarem, a resposta é 503. Duas exceções ao "nada é gravado": a marcação e a desmarcação (`PUT`/`DELETE .../answers/{requirement_id}`) gravam e só depois leem as marcações e os itens da faixa para o `summary`, então um limite nessa leitura responde 503 com a marcação já gravada (reenviar a mesma requisição dá o mesmo resultado); e, nas imagens (logos e assinaturas), o arquivo pode já estar no S3 quando a gravação no DynamoDB falha (veja a ordem das gravações em "Imagens da academia (RN012)" e em "Assinaturas do certificado (RN012)"). Além do tratamento em cada chamada, a camada HTTP (`api_handler`) tem uma rede de segurança: um desses três códigos que escape de uma chamada sem o tratamento também responde 503 com a mesma mensagem, em vez de 500, e fica no log em nível ERROR, com a operação, o código e o stack trace, que mostram a chamada que escapou para ser corrigida. A rede não olha o cancelamento de transação (`TransactionCanceledException`), tratado em cada transação, nem os outros erros, que continuam 500. Antes do #43, as leituras por chave de evento, requisito e faixa, o cadastro de aluno e as gravações de faixa, evento e requisito respondiam 500, e os nomes dos alunos eram pedidos de novo na hora, sem espera e sem limite, até o timeout da Lambda.

**Campos inteiros (RN015).** Todo inteiro lido do corpo tem um teto, e o valor fora dele é recusado com 400 e nada é gravado:

| Campo | Faixa aceita | Mensagem fora da faixa |
| --- | --- | --- |
| `PUT /belts/{id}`: `sort_order` | 0 a 99 | "Ordem: deve estar entre 0 e 99" |
| `PUT /belts/{id}`: `min_age_years` | 0 a 99 | "Idade mínima: deve estar entre 0 e 99" |
| `PUT /belts/{id}`: `min_months_previous` | 0 a 240 | "Carência: deve estar entre 0 e 240" |
| `PUT /belts/{id}`: `kyu` (opcional) | 1 a 11 | "Kyū: deve estar entre 1 e 11" |
| `POST`/`PUT /requirements`: `sort_order` | 0 a 9999 | "Ordem: deve estar entre 0 e 9999" |
| `POST`/`PUT /students`: `stripes` | 0 a 4 | "Graus: deve estar entre 0 e 4" |

Além disso, nenhum campo inteiro aceita mais de 38 dígitos, o máximo que o DynamoDB grava ("<campo>: deve ter no máximo 38 dígitos"). Valor que não é inteiro (texto, decimal, booleano) → 400 "<campo>: deve ser um número inteiro".

No `POST /requirements` sem `sort_order`, a ordem padrão (a maior da faixa + 1) também precisa caber em 0 a 9999. Se a faixa já tem um item na ordem 9999, a resposta é 400 "Ordem: a faixa já tem um item na ordem 9999; informe a ordem do novo item" e nada é gravado; com `sort_order` informado, o item é aceito normalmente.

`GET /students` aceita os filtros `active=true|false`, `belt_id` e `reference_date=AAAA-MM-DD`. O último é a data da elegibilidade; sem ele, vale a data de hoje.

`PUT /students/{id}` recebe todos os campos do `POST`. Enquanto o aluno tiver um exame em andamento (RN005), a troca de faixa (`current_belt_id`), da data da faixa (`current_belt_since`) ou dos graus (`stripes`) é recusada com 409 "Não é possível alterar a graduação com exame em andamento. Decida o exame primeiro." e nada é gravado, para examinadores e responsáveis. Nome, nascimento, registro e ativo continuam editáveis, e reenviar a mesma graduação (como o formulário faz) é aceito. Quando a graduação enviada é a mesma da leitura, a gravação não toca nos campos da graduação: só os outros campos são gravados, então uma aprovação do sensei entre a leitura e a gravação não é desfeita (RN009). A resposta (200) traz o aluno como ficou gravado (`ReturnValues=ALL_NEW`), já com a graduação da aprovação nesse caso. Quando a graduação enviada é diferente da lida, a gravação usa uma trava otimista: o `UpdateItem` só grava se `current_belt_id`, `current_belt_since` e `stripes` ainda forem os da leitura. Se mudaram no meio do caminho (outra edição ou uma aprovação do sensei, RN009), a resposta é 409 "Os dados do aluno mudaram. Tente de novo." e nada é gravado; o aluno apagado, a trava do RN013 e o exame em andamento continuam respondendo 404, 403 e 409 como abaixo. Limite de capacidade do DynamoDB que persistiu, na leitura do aluno, do marcador, das faixas (`Scan` em `Belts`), na consulta de exames do aluno (índice `by_student`) ou na gravação → 503 "Sistema ocupado no momento. Tente de novo em instantes." e nada é gravado. Vale também para `GET /students/{id}` (leitura do aluno e das faixas) e para `DELETE /students/{id}` (leitura do aluno, consulta de exames e o `DeleteItem` condicionado, com o aluno mantido). Depois da decisão do sensei a graduação volta a ser editável. A condição está na própria gravação (`UpdateItem` condicionado a `exam_in_progress_id` ausente, só quando a graduação muda), então uma presença confirmada no meio da edição também barra a troca. **Precedência para o responsável:** a trava do RN013 (403 "Somente examinadores alteram a graduação após o primeiro exame") vem antes, porque continua valendo depois da decisão; como todo aluno com exame em andamento já tem exame, o responsável que tenta trocar a graduação recebe sempre o 403. Aluno apagado no meio do caminho → 404.

`GET /requirements` aceita os filtros `belt_id` e `kind=THEORY|PRACTICE`. Sem filtro, devolve todos os itens na ordem das faixas e da folha. No `POST`, sem `sort_order`, o item vai para o fim da faixa (maior ordem + 1); se isso passar de 9999, a resposta é 400 e é preciso informar a ordem (veja "Campos inteiros (RN015)"). O `PUT` recebe os mesmos campos do `POST`; se o item já tiver resposta em algum exame, a troca de `belt_id` ou de `kind` é recusada com 409 "Não é possível trocar a faixa ou o tipo de um requisito com respostas registradas" e nada é gravado. Descrição, resposta esperada, categoria e ordem continuam editáveis, e reenviar a mesma faixa e o mesmo tipo (como o formulário faz) é aceito. O `DELETE` é recusado com 409 "Requisito possui respostas registradas" se algum exame tiver resposta para o item (veja "Contador de respostas" abaixo).

`GET /events` devolve os eventos do mais recente para o mais antigo (`exam_date`; empate pelo mais novo cadastro). No `POST`, `status` é opcional (padrão `OPEN`). O `PUT` altera `name` e `status`; um evento `CLOSED` pode ser reaberto. A `exam_date` não muda depois da criação: reenviar a mesma data é aceito, outra data é recusada. O `DELETE` é recusado (409) se o evento tiver exames.

**Leitura consistente nas leituras por chave.** As leituras por chave (`GetItem`) que decidem a resposta de uma rota usam `ConsistentRead=True`. Com leitura eventualmente consistente, por até cerca de 1 segundo depois de uma gravação, o DynamoDB podia devolver a versão anterior do item, ou nenhum item logo depois do `POST`, e a rota respondia um 404, 403, 409 ou 400 que já não correspondia ao que estava gravado.

| Leitura | O que ela decide | Erro com a leitura eventual |
| --- | --- | --- |
| evento (`Events`) | 404 de `GET`/`PUT`/`DELETE /events/{id}`; nas rotas de exame (presença, lista, ficha, marcação e decisão), o 404 e a situação do evento (RN016) | presença, `PUT` ou `DELETE` logo depois de criar o evento → 404 "Evento não encontrado"; marcação logo depois de reabrir → "Evento encerrado" (#64) |
| requisito (`Requirements`) | 404 do `PUT`/`DELETE /requirements/{id}` e da marcação; 404 ou 409 quando a gravação condicional do `PUT` falha (RN017) | "Requisito não encontrado" logo depois do `POST /requirements` (#64) |
| exame (`Exams`) | 404 da ficha, da marcação (`PUT`/`DELETE`) e da decisão; 409 da presença repetida; a situação do exame na ficha (RN005–RN010) | ficha, marcação ou decisão logo depois da presença → 404 "Exame não encontrado"; ficha logo depois da decisão ainda "Em andamento" (#78) |
| aluno (`Students`) | 404 de `GET`/`PUT`/`DELETE /students/{id}`, do histórico (`GET /students/{id}/exams`) e da presença; a graduação que a edição usa na trava otimista e que a decisão compara com a da presença (RN009, RN013) | 404 logo depois do `POST /students`; segunda edição logo depois de corrigir a graduação recusada sem motivo; decisão logo depois da correção → 409 "A graduação do aluno mudou desde a presença" (#78) |
| marcador `exam_in_progress_id` do aluno (`Students`) | a trava da graduação com exame em andamento no `PUT /students/{id}` (RN005) | corrigir a graduação logo depois da decisão → 409 "Não é possível alterar a graduação com exame em andamento" (#78) |
| configurações (`Settings`, registro `academy`) | quem é o sensei na decisão (RN008); o `GET /settings` | quem o master acabou de escolher como sensei → 403 "Somente o sensei pode decidir o exame"; `GET` logo depois do `PUT` com os campos antigos (#78) |
| marcador da carga inicial (`Settings`, `seed:requirements:v1`) | se a carga dos requisitos já foi feita (RN017) | uma carga logo depois de outra recriava os itens excluídos no intervalo (#78) |

**Releituras depois de gravação recusada.** Quando uma gravação condicional ou uma transação é recusada, o repositório relê o item para escolher o erro: a edição do aluno (`PUT /students/{id}`), a presença, a decisão e a marcação (exame, evento e requisito). Essas releituras também são consistentes, porque a gravação concorrente que fez a condição falhar acabou de acontecer. Com a leitura eventual, a resposta descrevia o estado de antes dela: 403 "Somente o sensei pode decidir o exame" em vez de 409 "Defina o sensei nas configurações da academia" quando o master acabava de remover o sensei, 404 "Exame não encontrado" em vez de 409 "Exame já decidido" num clique duplo na decisão, ou 400 "Item não pertence à faixa do exame" em vez de 404 "Requisito não encontrado" quando o item acabava de ser excluído (#78). Limite de capacidade do DynamoDB que persistiu numa dessas releituras → 503 "Sistema ocupado no momento. Tente de novo em instantes." e nada é gravado, porque a gravação já tinha sido recusada (na marcação, antes do #78, saía 500).

**Custo no dev.** Todos esses itens têm bem menos de 4 KB (o exame, cerca de 0,5 KB, até 1,5 KB com observação longa), então cada leitura consistente custa 1 RCU, em vez de 0,5. Num dia de exame (três examinadores, 0,3 a 0,6 marcação por segundo):

| Tabela (RCU no dev) | Leituras por chave | Uso estimado no pico |
| --- | --- | --- |
| `Events` (2) e `Requirements` (3) | uma de cada por marcação | até 0,6 RCU/s em cada |
| `Exams` (2) | uma por marcação, ficha, presença e decisão | 0,4 a 0,7 RCU/s (antes, 0,2 a 0,35); a tabela sustenta perto de 2 marcações por segundo, acima do limite que `Answers` já impõe (veja "Conta de capacidade no dev") |
| `Students` (3) | nenhuma na marcação; uma por ficha, presença e decisão; duas por `PUT /students/{id}` | abaixo de 0,3 RCU/s |
| `Settings` (1) | uma por decisão e por `GET /settings` (a tela do exame o chama ao abrir) | 0,1 a 0,2 RCU/s, com uma decisão a cada 30 a 60 s |

Leituras que passam da capacidade num mesmo segundo (por exemplo, duas ou três em `Settings`) usam o burst do DynamoDB (até 300 segundos de capacidade não usada); se ele acabar, o botocore repete e, se persistir, a resposta é 503. A capacidade não mudou, e o ensaio de carga no dev (#33) confere esses números. O prod é `PAY_PER_REQUEST`. As listas (`GET /events`, `GET /requirements`, `GET /students`, `GET /events/{id}/exams`), os nomes dos alunos (`BatchGetItem`), o índice `by_belt` e as leituras do histórico do aluno além do próprio aluno (índice `by_student`, eventos e faixas) continuam com leitura eventual (veja "Limitação: o `total` vem de um GSI" e "Histórico de exames do aluno (RN018)").

`POST /events/{id}/exams` confirma a presença (RN005) com o corpo `{"student_id": "..."}` e devolve 201 com o exame criado: faixa-alvo (`target_belt_id`) e tipo (`kind`: `STRIPE` ou `BELT`) calculados na **data do evento**, `status` `IN_PROGRESS` e quem confirmou (`created_by`). Recusa com 400 se o evento estiver encerrado ("Evento encerrado"), se o aluno estiver inativo ("Aluno inativo não pode fazer exame") ou inelegível (os motivos da elegibilidade, separados por `; `); 404 para evento ou aluno inexistente; 409 se a presença já foi confirmada ("Presença já confirmada neste evento") ou se o aluno já tem um exame `IN_PROGRESS` em outro evento ("O aluno já tem um exame em andamento em outro evento."; nada é gravado). A gravação é uma única transação (`TransactWriteItems`): o exame só entra se ainda não existir e se, no mesmo instante, o evento existir e estiver aberto e o aluno existir e estiver ativo. Por isso confirmações simultâneas do mesmo aluno resultam em um 201 e um 409, e um evento apagado ou encerrado no meio do caminho nunca recebe exame. Conflitos de transação são repetidos algumas vezes; se persistirem, a resposta é 409 "Outra confirmação está em andamento. Tente de novo.". A transação também exige que a faixa atual, a data da faixa e os graus do aluno ainda sejam os lidos ao calcular a faixa-alvo; se mudaram no meio do caminho, a resposta é 409 "Os dados do aluno mudaram. Tente de novo." e nada é gravado.

O exame também guarda a **graduação de origem**, a do aluno no momento da presença: `source_belt_id`, `source_belt_since` e `source_stripes`. A decisão (RN008) usa esses campos para saber se a graduação mudou desde a presença. Exames confirmados antes desta versão não têm os campos (vêm `null`); veja a decisão abaixo.

**Contador de exames.** A mesma transação soma 1 ao atributo `exam_count` do evento e do aluno (itens sem o atributo contam como zero). O `DELETE /events/{id}` e o `DELETE /students/{id}` são gravações condicionais a `exam_count` zero ou ausente, então uma presença confirmada no meio da exclusão ainda resulta em 409 ("Evento possui exames registrados" / "Aluno possui exames registrados") e nada é apagado. No `DELETE /events/{id}`, limite de capacidade que persistiu na consulta de exames do evento → 503 "Sistema ocupado no momento. Tente de novo em instantes." e o evento é mantido. Pelo mesmo contador, quando um responsável altera faixa, data da faixa ou graus, a gravação só acontece se o aluno ainda não tiver exame (403 "Somente examinadores alteram a graduação após o primeiro exame"). As edições de evento e aluno usam `UpdateItem` só nos campos do modelo e nunca perdem o contador.

**Um exame em andamento por aluno** (RN005, decisão do responsável de 2026-11-02). A mesma transação da presença grava no aluno o atributo `exam_in_progress_id` (o `id` do exame criado), com a condição de que ele ainda não exista. Se o aluno já tem um exame em andamento em outro evento, a resposta é 409 "O aluno já tem um exame em andamento em outro evento." e nada é gravado; no mesmo evento continua valendo 409 "Presença já confirmada neste evento", que tem precedência. Como a condição está na transação, duas presenças simultâneas do mesmo aluno em eventos diferentes resultam em um 201 e um 409. A decisão do sensei (aprovação ou reprovação) remove o atributo na própria transação, e o aluno fica livre para outra presença. A remoção é condicionada a o atributo ser o do exame decidido (ou não existir). O atributo é interno: não aparece nas respostas de `/students`, e as edições do aluno (`PUT /students/{id}`) não o apagam, porque mexem só nos campos do modelo. **Dados antigos:** exames em andamento confirmados antes desta regra (só existem no dev) não têm o atributo e não bloqueiam outra presença; se o aluno tiver um desses e um exame novo com o atributo, decidir o antigo responde 409 "O aluno já tem um exame em andamento em outro evento." até o novo ser decidido. Se o novo for **aprovado**, a graduação do aluno muda e deixa de ser a da presença do exame antigo (sem marcador); daí em diante decidir o exame antigo responde 409 "A graduação do aluno mudou desde a presença. Confira antes de decidir." para sempre (o exame antigo fica `IN_PROGRESS` e não tem saída pela API). Enquanto o atributo existir, a graduação do aluno não pode ser alterada pelo `PUT /students/{id}` (409, veja acima), então o exame não fica preso por uma graduação diferente da de origem.

`GET /events/{id}/exams` lista os exames do evento em ordem alfabética do aluno, cada um com `student_name`. Os nomes vêm de um `BatchGetItem` em `Students` (só `id` e `full_name`, até 100 por chamada, leitura eventual); as chaves não processadas por falta de capacidade têm novas tentativas limitadas e, se sobrarem, a resposta é 503 (veja "Limite de capacidade do DynamoDB" em "Erros comuns").

### Configurações da academia (§ 3.7) e examinadores

`GET /settings` devolve o registro único de configurações. Antes do primeiro `PUT`, todos os campos vêm `null`.

```json
{
  "academy_name": "Associação Tomiyama de Judô",
  "sensei_user_id": "<sub>",
  "certificate_city": "Araraquara",
  "created_at": "…", "updated_at": "…",
  "sensei": {"id": "<sub>", "email": "sensei@example.com", "name": "Tomiyama", "active": true}
}
```

- `sensei` é `null` sem sensei. `active` é `false` se a conta do sensei foi desabilitada ou saiu do grupo `admin` depois da escolha; no segundo caso (ou se a conta foi apagada), `email` e `name` vêm `null`. A tela deve pedir outro sensei.
- As imagens (logos e assinaturas do certificado) nunca aparecem neste JSON, nem os metadados delas (RN012): logos e assinaturas têm rotas próprias (veja "Imagens da academia (RN012)" e "Assinaturas do certificado (RN012)" abaixo). Os nomes, graduações e imagens que vão no certificado são as **assinaturas do certificado** (até 3, geridas só pelo master e pelo sensei), e não campos destas configurações.

`PUT /settings` recebe `academy_name`, `sensei_user_id` e `certificate_city` e **substitui** os três: um campo opcional ausente, `null` ou só com espaços passa a `null`, e os textos são gravados sem espaços nas pontas. Outras chaves são ignoradas. A resposta (200) é igual à do `GET`. A gravação é um `UpdateItem` só nesses campos (e em `updated_at`; `created_at` só na primeira vez), então atributos gravados por outras rotas, como as imagens, nunca se perdem.

| Situação | Resposta |
| --- | --- |
| `academy_name` ausente ou vazio | 400 "Campo obrigatório: Nome da academia" |
| texto longo demais | 400 "Nome da academia: máximo de 255 caracteres", "Cidade do certificado: máximo de 80 caracteres" ou "Sensei: máximo de 128 caracteres" |
| campo que não é texto | 400 "<campo>: valor inválido" |
| o master envia um `sensei_user_id` inexistente, fora do grupo `admin` ou desabilitado (mesmo que seja o gravado) | 400 "O sensei precisa ser um examinador ativo" (nada é gravado) |
| quem não é master envia um `sensei_user_id` diferente do gravado (escolher o primeiro, trocar ou remover), válido ou não | 403 "Somente o administrador master escolhe o sensei" (nada é gravado) |
| Cognito ou DynamoDB sem capacidade, mesmo após as novas tentativas | 503 "Sistema ocupado no momento. Tente de novo em instantes." |

`sensei_user_id` `null` (ou vazio) remove o sensei. O valor é o `sub` do usuário, o mesmo `id` de `GET /examiners`.

**Só o master escolhe o sensei.** Os demais examinadores podem salvar o formulário, desde que reenviem o sensei gravado (ou `null`, se não há sensei): o formulário manda todos os campos. A comparação é atômica, uma `ConditionExpression` no próprio `UpdateItem` (`sensei_user_id = :same_sensei`, ou `attribute_not_exists(sensei_user_id)` para `null`); se o master trocou o sensei entre a leitura da tela e a gravação, a resposta é o mesmo 403 e nada é gravado. A gravação do master não tem essa condição. A validação de examinador ativo vale só para o master, que é quem escolhe: para os demais, o sensei reenviado não é conferido no Cognito, já que a condição garante que é o gravado. Assim, se o sensei gravado foi desabilitado ou saiu do grupo `admin`, os outros examinadores continuam salvando nome e cidade (a resposta mostra `active: false`), e o master, para salvar, precisa trocar ou remover o sensei.

`GET /examiners` lista os examinadores ativos para o seletor de sensei (§ 6.6): membros do grupo `admin` com a conta habilitada, em ordem de nome (sem acentos nem maiúsculas; sem nome, pelo e-mail). Os masters aparecem como qualquer examinador. Examinador que ainda não fez o primeiro login (status `FORCE_CHANGE_PASSWORD`, como o examinador inicial do template) tem a conta habilitada e aparece como ativo, podendo ser escolhido como sensei.

```json
[{"id": "<sub>", "email": "alvaro@example.com", "name": "Álvaro"},
 {"id": "<sub>", "email": "carla@example.com", "name": null}]
```

As três rotas leem o Cognito com `ListUsersInGroup` (paginado, 60 por página), e só essa ação é liberada, no ARN do pool. O `GET` e o `PUT /settings` só consultam o Cognito quando há sensei. O ID do pool chega pela variável `USER_POOL_ID`, definida em cada uma dessas funções e não em `Globals`: o pool referencia a `PostConfirmationFunction`, e uma referência de volta seria uma dependência circular.

### Imagens da academia (RN012)

Os logos ficam num bucket S3 **privado** (`ImagesBucket`), nunca no DynamoDB nem em URL pública. As rotas são dos examinadores (grupo `admin`), com `{slot}` = `primary` (logo principal) ou `secondary` (logo secundário):

| Método | Rota | Resposta |
| --- | --- | --- |
| PUT | /settings/logos/{slot} | 200 com os metadados; envia ou troca o logo |
| DELETE | /settings/logos/{slot} | 204; remove (sem logo também é 204) |
| GET | /settings/logos/{slot} | 200 com a URL pré-assinada; 404 sem logo |

**Envio.** O corpo é JSON com o arquivo em base64 padrão, sem quebras de linha e sem o prefixo `data:image/png;base64,` que o `FileReader.readAsDataURL` põe (o front tira o prefixo):

```json
{"content_type": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAA…"}
```

- `content_type`: `image/png` ou `image/jpeg`, exatamente assim.
- A Lambda decodifica e confere a **assinatura binária** do arquivo: PNG começa com `89 50 4E 47 0D 0A 1A 0A` e JPEG com `FF D8 FF`. O tipo real vem dos bytes; se não bater com o `content_type`, o envio é recusado. GIF, PDF, SVG e o resto são recusados.
- Tamanho: até 2 MB (2 × 1024 × 1024 = 2.097.152 bytes) **depois de decodificar**; exatamente 2 MB é aceito. Um `data` maior que o base64 de 2 MB (2.796.204 caracteres) é recusado antes de decodificar.
- Só depois da validação o arquivo é gravado no S3, na chave fixa do slot (`logos/primary` ou `logos/secondary`). Trocar o logo é sobrescrever a mesma chave (sem versionamento).
- Cabeçalhos do objeto: `Content-Type` é o tipo **detectado pelos bytes** (`image/png` ou `image/jpeg`), nunca o cabeçalho `Content-Type` da requisição nem outro texto do cliente; `Content-Disposition` é sempre `inline; filename="logo.png"` (ou `logo.jpg`), um nome fixo escolhido pelo código, sem nada do nome do arquivo enviado. Assim o navegador mostra a imagem e não a trata como página, script ou download de outro tipo.
- Por que pela API e não por upload direto com URL pré-assinada de `PUT`: assim o arquivo é validado (tipo real e tamanho) antes de entrar no bucket, e nada inválido chega a ser gravado. O corpo de até ~2,8 MB cabe nos limites do HTTP API (10 MB) e da Lambda (6 MB); um corpo acima de 6 MB é barrado pela AWS antes da função. O timeout (10 s) e a memória (256 MB) padrão bastam para decodificar e gravar 2 MB.

A resposta do `PUT` (200) traz os metadados, os mesmos gravados nas configurações:

```json
{"slot": "primary", "content_type": "image/png", "size": 48213,
 "updated_at": "2026-11-02T12:00:00+00:00", "updated_by": "<sub>"}
```

**Leitura.** O `GET` devolve uma URL pré-assinada de `GET` do S3, válida por 5 minutos (300 s), e nunca o arquivo nem uma URL pública:

```json
{"slot": "primary", "url": "https://<bucket>.s3.<região>.amazonaws.com/logos/primary?X-Amz-Algorithm=AWS4-HMAC-SHA256&…&X-Amz-Expires=300&…",
 "expires_in": 300, "content_type": "image/png", "size": 48213,
 "updated_at": "…", "updated_by": "<sub>"}
```

A URL fixa os cabeçalhos da resposta com os mesmos valores do envio (`response-content-type` = o `content_type` dos metadados e `response-content-disposition` = `inline; filename="logo.png"` ou `logo.jpg`). Esses parâmetros entram na assinatura, então trocá-los invalida a URL, e a resposta não depende dos metadados gravados no objeto. Metadados com `content_type` diferente de PNG e JPEG contam como "sem logo" (404).

**Sem `X-Content-Type-Options: nosniff`.** O S3 não deixa definir esse cabeçalho na resposta de um objeto: no `PutObject` só valem `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Content-Type`, `Expires` e metadados `x-amz-meta-*`, e na URL pré-assinada só as seis sobreposições `response-*` correspondentes (conferido no modelo do S3 do botocore). Um `x-amz-meta-*` não teria efeito no navegador, por isso não é usado. O `nosniff` só seria possível servindo os logos por CloudFront com *response headers policy*, que a stack não usa. A proteção que fica é o tipo validado pelos bytes, o `Content-Type` e o `Content-Disposition: inline` fixos na URL, e o uso da URL só em `<img src>` (que nunca executa o arquivo).

A URL serve para `<img src>`, que não precisa de CORS; para mostrar o logo de novo depois de 5 minutos, a tela chama o `GET` outra vez. Como `GET /settings` não traz os logos, a aba Academia chama `GET /settings/logos/primary` e `/secondary` e trata 404 como espaço vazio. A assinatura é SigV4 contra o endpoint da região (o endpoint global pode redirecionar um bucket novo e quebrar a assinatura) e é feita localmente na Lambda, sem chamada ao S3; a URL vale enquanto o papel da função puder ler `logos/*` e as credenciais da função não expirarem.

**Metadados.** O registro de configurações (`Settings`, `id = "academy"`) guarda só `logo_primary` e `logo_secondary`, cada um um mapa com `content_type`, `size`, `updated_at` e `updated_by` (o `sub` de quem enviou), sem o binário. É o que o `GET` usa para saber se há logo. Cada envio ou remoção é um `UpdateItem` só nesse atributo (1 WCU: o item fica bem abaixo de 1 KB), e o `PUT /settings` não mexe neles. Enviar um logo antes do primeiro `PUT /settings` cria o registro só com o logo; a remoção nunca cria o registro.

**Ordem das gravações.** S3 e DynamoDB não entram numa mesma transação, então a ordem garante que a API nunca mostre um logo que não existe:

- envio: grava no S3 **primeiro** e os metadados **depois**. Se a gravação dos metadados falhar (503), o arquivo novo já está no S3, mas sem metadados novos: se não havia logo, ele fica invisível (o `GET` responde 404); se havia, o `GET` continua com os metadados antigos e a URL entrega o arquivo novo. Reenviar resolve;
- remoção: apaga os metadados **primeiro** e o objeto **depois**. Se o S3 falhar (503), o logo já some da API e o objeto fica órfão; repetir o `DELETE` apaga o objeto, porque a remoção sempre apaga a chave do slot, com ou sem metadados.

Corrida que sobra: um `PUT` e um `DELETE` do **mesmo** slot ao mesmo tempo podem terminar com metadados sem objeto (a URL responde 404 do S3 e a imagem não aparece). Reenviar ou remover o logo corrige. O `GET` não confere o objeto no S3 de propósito: conferir exigiria `s3:ListBucket` (sem ela o S3 responde 403 para chave inexistente), e a corrida pede dois examinadores agindo no mesmo logo no mesmo instante.

| Situação | Resposta |
| --- | --- |
| sem login / responsável | 401 "Faça login para continuar" / 403 "Esta área é dos examinadores" |
| `slot` diferente de `primary` e `secondary` | 404 "Logo não encontrado" |
| `GET` de slot sem logo | 404 "Logo não encontrado" |
| `content_type` ausente ou diferente de `image/png`/`image/jpeg`; `data` ausente, vazio, que não é texto ou base64 inválido; bytes que não são PNG nem JPEG, ou de tipo diferente do declarado; mais de 2 MB | 400 "Envie PNG ou JPEG de até 2 MB" (nada é gravado; o logo atual fica) |
| corpo que não é um objeto JSON | 400 "Corpo da requisição inválido: envie um objeto JSON" |
| DynamoDB ou S3 (`SlowDown`) sem capacidade, mesmo após as novas tentativas | 503 "Sistema ocupado no momento. Tente de novo em instantes." |
| S3 lento ou fora do ar (timeout de conexão ou de leitura, conexão recusada ou derrubada) | 503 "Sistema ocupado no momento. Tente de novo em instantes." (no envio, nada é gravado; na remoção, como no `SlowDown` acima) |

**Timeouts do cliente S3.** O padrão do boto3 (60 s para conectar e 60 s para ler) passa do `Timeout` de 10 s das funções, e a Lambda seria encerrada no meio, com 500 genérico do API Gateway. Por isso o cliente (`repository/images.py`) usa `connect_timeout` de 1 s, `read_timeout` de 2 s (por operação de socket, não para o corpo inteiro) e no máximo 2 tentativas no modo `standard`. O pior caso é 2 × (1 + 2) s mais até 1 s de espera entre as tentativas, ou seja, 7 s, o que deixa folga para a gravação no DynamoDB. Um teste confere essa conta contra o `Timeout` do template. Esgotadas as tentativas, timeout ou falha de conexão viram 503. A assinatura da URL do `GET` é local e não faz chamada de rede.

O `slot` inválido é 404, e não 400, porque o caminho aponta para um recurso que não existe, como um `id` desconhecido nas outras rotas. A autorização vem antes: um responsável recebe 403 mesmo com `slot` inválido.

**Bucket** (`infra/template.yaml`): bloqueio de acesso público completo (as 4 opções), criptografia SSE-S3 (AES256), `BucketOwnerEnforced` (sem ACLs), sem versionamento, política que nega qualquer acesso sem TLS (`aws:SecureTransport` `false`) e nome gerado pelo CloudFormation, passado às funções pela variável `IMAGES_BUCKET` (só nas funções de logo e nas de assinatura que usam o S3). `DeletionPolicy` e `UpdateReplacePolicy` seguem as tabelas: `Retain` no prod e `Delete` no dev (veja "Bucket de imagens no dev" acima). Permissões mínimas: `PutLogoFunction` só `s3:PutObject`, `DeleteLogoFunction` só `s3:DeleteObject` e `GetLogoFunction` só `s3:GetObject`, todas restritas a `logos/*`, mais `dynamodb:UpdateItem` (envio e remoção) ou `dynamodb:GetItem` (leitura) na tabela `Settings`, só no item `academy` (condição `dynamodb:LeadingKeys`), então nenhuma função de logo lê as assinaturas. Além delas, só as funções de assinatura acessam o bucket, e só em `signatures/*` (veja abaixo).

### Assinaturas do certificado (RN012)

O certificado (§ 7) leva de 1 a 3 assinaturas lado a lado, na ordem configurada. Cada uma tem **nome**, **graduação** (texto livre, como "Fundador, 6º Dan (in memoriam)"), **imagem** (PNG ou JPEG de até 2 MB, validada pelos bytes como os logos) e **posição** (1 a 3, o lugar na lista). A pessoa pode não ter login. Uma assinatura é **completa** com nome, graduação e imagem; o certificado (RN011) vai exigir ao menos uma completa, e a lista já diz se há (`has_complete`, e `complete` em cada item).

**Quem.** Criação, edição, remoção, ordem **e leitura** só pelo **master** (grupos `master` e `admin`) e pelo **sensei** (o `sensei_user_id` das configurações, lido a cada requisição, sem cache). Responsável, outro examinador e, sem sensei configurado, qualquer examinador que não seja o master recebem 403 "Somente o master e o sensei gerem as assinaturas". A permissão é conferida antes do corpo e do `id`. Toda gravação do sensei confere de novo, na mesma transação, que ele ainda é o sensei: um sensei trocado entre a conferência e a gravação recebe 403 e nada é gravado.

| Método | Rota | Resposta |
| --- | --- | --- |
| GET | /settings/signatures | 200 com a lista na ordem do certificado |
| POST | /settings/signatures | 201 com a assinatura criada, na última posição; 409 se já houver 3 |
| PUT | /settings/signatures/order | 200 com a lista na nova ordem |
| PUT | /settings/signatures/{id} | 200; troca nome e graduação (imagem e posição ficam) |
| DELETE | /settings/signatures/{id} | 204; remove a assinatura **e a imagem**; as seguintes sobem uma posição (`id` já removido também é 204) |
| PUT | /settings/signatures/{id}/image | 200 com a assinatura; envia ou troca a imagem |
| DELETE | /settings/signatures/{id}/image | 204; remove a imagem (sem imagem também é 204) |
| GET | /settings/signatures/{id}/image | 200 com a URL pré-assinada; 404 sem imagem |

`POST` e `PUT /settings/signatures/{id}` recebem `{"name": "...", "graduation": "..."}` e substituem os dois: `name` é obrigatório (até 120 caracteres) e `graduation` é opcional (até 120; ausente, `null` ou só espaços vira `null`, e a assinatura fica incompleta). Os textos são gravados sem espaços nas pontas; outras chaves são ignoradas. A imagem vai depois, pela rota `/image`, com o mesmo corpo dos logos (`{"content_type": "image/png", "data": "<base64>"}`) e as mesmas regras e erros ("Envie PNG ou JPEG de até 2 MB").

`GET /settings/signatures`:

```json
{"signatures": [
  {"id": "<uuid>", "position": 1, "name": "Jigoro Kano",
   "graduation": "Fundador, 6º Dan (in memoriam)",
   "image": {"content_type": "image/png", "size": 48213, "updated_at": "…", "updated_by": "<sub>"},
   "complete": true, "updated_at": "…", "updated_by": "<sub>"}
 ],
 "max_signatures": 3, "has_complete": true}
```

`image` é `null` sem imagem; a lista nunca traz o arquivo nem URL. O `POST`, o `PUT /{id}` e o `PUT /{id}/image` devolvem um item nesse mesmo formato. Para mostrar a imagem, a tela chama `GET /settings/signatures/{id}/image`, que devolve `id`, `position`, os metadados, `url` e `expires_in` (300): a URL é pré-assinada por 5 minutos, com `response-content-type` e `response-content-disposition` = `inline; filename="assinatura.png"` (ou `.jpg`) fixos, como nos logos.

**Ordem.** `PUT /settings/signatures/order` recebe `{"ids": ["<uuid>", ...]}` com **todos** os ids, cada um uma vez, da posição 1 em diante. Valor que não é lista de textos, com repetidos ou com mais de 3 → 400 "Ordem inválida: envie ids com a lista de assinaturas". Ids que não são exatamente os gravados (falta um, sobra um, ou a lista mudou desde que a tela leu) → 409 "A lista de assinaturas mudou. Recarregue e tente de novo." e nada muda.

**Armazenamento.** A lista é **um item** da tabela `Settings`, `id = "certificate_signatures"`, separado do registro `academy`: `signatures` (lista de mapas com `id`, `name`, `graduation`, `image`, `updated_at` e `updated_by`; a posição é o lugar na lista; `image` guarda também `key`, a chave do objeto no S3, que a API nunca devolve), `version` (número), `updated_at` e `updated_by`. Por ser outro item, o `GET /settings`, o `PUT /settings` e as rotas de logo nem carregam as assinaturas, e o IAM delas é limitado ao item `academy`. As imagens ficam no `ImagesBucket` em `signatures/{id}/{uuid}`: **uma chave nova a cada envio**, gerada pela API, e a chave da imagem atual é a registrada em `image.key`. A chave nunca vem do cliente. O `id` é um UUID gerado pela API; um `id` que não é UUID canônico é 404 "Assinatura não encontrada", então nada do caminho vira chave. Metadados com `key` ausente ou que não seja `signatures/{id}/{uuid}` da própria assinatura contam como "sem imagem".

**Concorrência (limite de 3 e ordem).** Toda mudança lê o item (leitura forte), aplica a regra pura de `domain/signatures.py` (limite, existência, ordem) e grava com `TransactWriteItems`: o `Put` da lista só passa se `version` ainda for a lida (ou se o item ainda não existir) e, para o sensei, um `ConditionCheck` no item `academy` confere `sensei_user_id`. Se outra requisição gravou no meio, a gravação falha, a lista é relida e a regra roda de novo sobre ela, até 5 vezes. Assim, duas criações ao mesmo tempo com 2 assinaturas gravadas dão um 201 e um 409 "O certificado aceita no máximo 3 assinaturas"; com espaço, as duas entram (nenhuma se perde); e uma ordem enviada enquanto alguém criava ou removia dá 409. Se outras gravações vencerem as 5 vezes → 409 "As assinaturas estão sendo alteradas por outra pessoa. Tente de novo.".

**Ordem das gravações da imagem** (S3 e DynamoDB não entram numa mesma transação). Como cada envio tem a sua chave, nenhuma requisição sobrescreve o objeto que outra registrou:

1. envio: confere que a assinatura existe (404 antes de tocar no S3) e grava o objeto numa **chave nova** `signatures/{id}/{uuid}`;
2. grava os metadados, com a `key`, na transação com a trava de `version` e, para o sensei, o `ConditionCheck` (o mesmo das outras gravações);
3. se der certo, apaga a chave **anterior** registrada (a que os metadados deixaram de apontar). Se a chamada falhar, o erro é classificado (veja "Falha definitiva ou ambígua"): numa falha **definitiva** apaga **só a chave nova**, sem reler a lista; numa falha **ambígua** não apaga nada, nem depois de reler, e registra a chave nova no log como órfão possível. Nos dois casos devolve o erro original, com o status de sempre.

Remoção da imagem ou da assinatura: apaga os metadados (ou a assinatura) na transação **primeiro** e depois a chave que estava registrada. Se a chamada da remoção falhar de forma **definitiva**, nada é apagado: os metadados continuam apontando para a chave. Se falhar de forma **ambígua**, a chave lida antes dela só é apagada se a releitura mostrar que os metadados já não apontam para ela (a transação foi gravada e a resposta se perdeu); se a releitura falhar, nada é apagado. `GET /{id}/image` assina a URL da chave registrada.

**Falha definitiva ou ambígua.** Uma transação pode ser gravada e a chamada terminar em erro mesmo assim, e uma transação ainda em andamento no servidor pode ser gravada **depois** de qualquer releitura. Por isso `repository.signatures.is_definitive_write_failure` (função pura, testada classe por classe) separa os erros:

- **definitivos** (a transação com certeza não foi gravada): os erros de regra que o repositório levanta (403 sensei trocado, 404, 409 da trava depois das 5 tentativas, 503 por throttling, 400), `ProvisionedThroughputExceededException`, `ThrottlingException`, `RequestLimitExceeded`, `ValidationException` e `TransactionCanceledException` cujos motivos são todos recusas conhecidas (`None`, `ConditionalCheckFailed`, `TransactionConflict`, `ThrottlingError`, `ProvisionedThroughputExceeded`, `ValidationError`);
- **ambíguos** (pode ter sido gravada, agora ou depois): `InternalServerError`, `ServiceUnavailable` e qualquer outro código do DynamoDB, `TransactionCanceledException` sem motivos ou com motivo desconhecido, `ConnectionClosedError`, `ReadTimeoutError`, `EndpointConnectionError` (também depois das novas tentativas do botocore) e qualquer outra exceção.

No envio, a chave nova só é apagada em falha definitiva; em falha ambígua ela fica, e vai para o log como órfão possível. Nas remoções, a chave antiga nunca é apagada em falha definitiva; em falha ambígua, só depois de uma releitura forte mostrar que nenhum metadado aponta para ela (uma remoção em andamento não faz metadados voltarem a apontar para a chave). Se a releitura falhar, nada é apagado e a chave vai para o log.

**`ClientRequestToken`.** Todo `TransactWriteItems` das assinaturas leva um token, um UUID novo por tentativa de gravação (uma por `version` lida). As novas tentativas automáticas do botocore reenviam a mesma requisição, com o mesmo token: se a primeira foi gravada e a resposta se perdeu, o DynamoDB responde sucesso sem gravar de novo (o token vale 10 minutos e exige os mesmos parâmetros; outros parâmetros com o mesmo token dão `IdempotentParameterMismatchException`). Uma nova tentativa depois de a trava de `version` recusar a gravação monta outra transação, então leva um token novo.

Dois envios ao mesmo tempo terminam coerentes: o que grava os metadados por último vence (a trava de `version` faz o outro reler a lista) e apaga o objeto do perdedor, que já estava registrado; o tipo nos metadados é sempre o do objeto apontado. Um envio e uma remoção ao mesmo tempo também: a remoção só apaga a chave que leu nos metadados, nunca a do envio em andamento.

**O que pode sobrar.** As limpezas depois de uma transação gravada (a chave anterior no envio, a chave registrada nas remoções) não mudam a resposta: se o S3 falhar, a resposta continua 200 ou 204, a falha vai para o log com a chave, e o objeto fica **órfão, sem metadados** (invisível para a API; ocupa espaço até ser apagado à mão). O mesmo vale se a limpeza da chave nova falhar depois de uma recusa definitiva, se a releitura depois de uma remoção com falha ambígua também falhar, ou se a Lambda parar entre o S3 e a transação. Num envio com falha **ambígua** sobram a chave nova, se a transação não foi gravada, ou a anterior, se foi (gravada na hora ou mais tarde); a chave nova vai para o log. O contrário, **metadados apontando para um objeto que não existe, nunca acontece**: o objeto é gravado antes dos metadados e só é apagado quando é certo que nenhum metadado aponta nem vai apontar para ele. Repetir o `DELETE` não apaga órfãos (a chave já não está registrada em lugar nenhum).

| Situação | Resposta |
| --- | --- |
| sem login | 401 "Faça login para continuar" |
| responsável, outro examinador, ou examinador sem sensei configurado (exceto o master) | 403 "Somente o master e o sensei gerem as assinaturas" |
| `id` inexistente ou que não é UUID | 404 "Assinatura não encontrada" |
| `GET /{id}/image` sem imagem | 404 "Assinatura sem imagem" |
| 4ª assinatura | 409 "O certificado aceita no máximo 3 assinaturas" |
| `name` ausente ou em branco; texto longo demais | 400 "Campo obrigatório: Nome" / "Nome: máximo de 120 caracteres" / "Graduação: máximo de 120 caracteres" |
| imagem inválida | 400 "Envie PNG ou JPEG de até 2 MB" (nada é gravado; a imagem atual fica) |
| DynamoDB ou S3 sem capacidade, S3 lento ou fora do ar, mesmo após as novas tentativas | 503 "Sistema ocupado no momento. Tente de novo em instantes." |

**Permissões** (`infra/template.yaml`), uma função por rota. Todas têm `dynamodb:GetItem` só nos itens `academy` e `certificate_signatures` (condição `dynamodb:LeadingKeys`); as que gravam têm `dynamodb:ConditionCheckItem` só em `academy` e `dynamodb:PutItem` só em `certificate_signatures`. No S3, só em `signatures/*`: `DeleteSignatureFunction` e `DeleteSignatureImageFunction` só `s3:DeleteObject`; `PutSignatureImageFunction` `s3:PutObject` e `s3:DeleteObject` (para apagar a chave nova quando a transação é recusada de forma definitiva e a anterior quando ela é trocada); `GetSignatureImageFunction` só `s3:GetObject` (é o que faz a URL funcionar). As funções de listar, criar, editar e reordenar não recebem `IMAGES_BUCKET` nem permissão no S3. Nenhuma função de logo alcança `signatures/*`, e nenhuma de assinatura alcança `logos/*`. As funções de configurações, de logo e da decisão do sensei ficam limitadas ao item `academy`; só a carga inicial (marcadores) tem acesso à tabela inteira. Sem recursos pagos novos: 8 funções Lambda e 8 rotas no mesmo HTTP API, o mesmo bucket e a mesma tabela.

### Exame do aluno e marcação (RN006, RN007)

`GET /events/{id}/exams/{student_id}` devolve, numa chamada só, tudo o que a tela do exame (§ 6.4) mostra:

```json
{
  "exam": {"id": "…", "event_id": "…", "student_id": "…", "student_name": "Ana",
           "target_belt_id": "…", "kind": "BELT", "status": "IN_PROGRESS",
           "decided_by_id": null, "decided_at": null, "notes": null,
           "created_by": "…", "created_at": "…",
           "source_belt_id": "…", "source_belt_since": "2026-03-14", "source_stripes": 0},
  "event": {"id": "…", "name": "Exame março/2027", "exam_date": "2027-03-20", "status": "OPEN"},
  "student": {"id": "…", "full_name": "Ana", "birth_date": "2018-05-10"},
  "target_belt": {"id": "…", "name": "Cinza/Azul", "sort_order": 2},
  "items": [
    {"id": "…", "belt_id": "…", "kind": "THEORY", "category": "Vocabulário",
     "description": "…", "expected_answer": "…", "sort_order": 1,
     "answer": {"requirement_id": "…", "correct": true, "marked_by": "<sub>",
                "marked_at": "2027-03-20T13:45:00+00:00"}},
    {"id": "…", "kind": "PRACTICE", "answer": null}
  ],
  "summary": {
    "THEORY": {"kind": "THEORY", "total": 11, "marked": 4, "correct": 3, "percent": 27.3},
    "PRACTICE": {"kind": "PRACTICE", "total": 13, "marked": 0, "correct": 0, "percent": 0.0}
  }
}
```

(Exemplo resumido: `event` e `target_belt` trazem todos os campos de `GET /events/{id}` e `GET /belts`.)

- `items` traz todos os itens da faixa-alvo na ordem da folha (`sort_order`); a tela agrupa por tipo e categoria. `answer` é `null` quando o item não foi marcado.
- `summary` é a RN007, por tipo: `percent` = acertos ÷ total de itens do tipo × 100, com 1 casa decimal (item não marcado conta como não acertado), e "marcados `marked` de `total`". Faixa sem itens de um tipo → `percent` `null` (a tela mostra "—"). O resumo é **sempre recalculado** a cada leitura e nunca é gravado.
- `student` é `null` se o aluno não existir mais (o mesmo vale para `student_name`).
- 404 "Evento não encontrado" ou "Exame não encontrado".

`PUT /events/{id}/exams/{student_id}/answers/{requirement_id}` com `{"correct": true}` (certo) ou `{"correct": false}` (errado) marca o item e devolve 200 com a resposta gravada e o resumo atualizado:

```json
{"answer": {"requirement_id": "…", "correct": false, "marked_by": "<sub>", "marked_at": "…"},
 "summary": {"THEORY": {"…": "…"}, "PRACTICE": {"…": "…"}}}
```

`DELETE` na mesma rota desmarca o item (volta a "não marcado") e devolve 200 com `{"answer": null, "summary": {…}}`. Desmarcar um item que não estava marcado não muda nada e também devolve 200.

Regras e erros (iguais no `PUT` e no `DELETE`):

| Situação | Resposta |
| --- | --- |
| responsável / sem login | 403 "Esta área é dos examinadores" / 401 "Faça login para continuar" |
| evento, exame ou requisito inexistente | 404 "Evento não encontrado" / "Exame não encontrado" / "Requisito não encontrado" |
| `correct` ausente ou não booleano (só no `PUT`) | 400 "Marcação inválida: envie correct como true (certo) ou false (errado)" |
| exame decidido (`status` ≠ `IN_PROGRESS`, RN010) | 409 "Exame já decidido" |
| evento encerrado (RN016) | 400 "Evento encerrado" |
| item de outra faixa | 400 "Item não pertence à faixa do exame" |
| conflito de transação que persistiu | 409 "Outra marcação está em andamento. Tente de novo." |
| limite de capacidade do DynamoDB que persistiu | 503 "Sistema ocupado no momento. Tente de novo em instantes." |

- Marcar de novo **substitui** a marcação anterior e grava o novo `marked_by` (o `sub` do token) e `marked_at`.
- **Marcações simultâneas no mesmo item: a última vence.** Nenhuma resulta em erro; o 409 só aparece se o DynamoDB cancelar a transação por conflito em todas as tentativas. Cancelamentos por limite de capacidade (`ThrottlingError`, `ProvisionedThroughputExceeded`) também são repetidos com espera crescente; se persistirem, a resposta é 503, e a mesma requisição pode ser reenviada.
- Cada gravação é uma transação (`TransactWriteItems`) que confere, no mesmo instante, que o exame ainda existe com o mesmo `id` e está `IN_PROGRESS` e que o evento ainda está `OPEN`. Por isso, se o evento for encerrado ou o exame decidido no meio do caminho, nenhuma marcação entra. A primeira resposta do item e a substituição também conferem que o requisito ainda existe e é da faixa-alvo.

**Leitura consistente das marcações.** A consulta das marcações do exame na tabela `Answers` (`Query` por `exam_id`) usa `ConsistentRead=True` em todas as páginas, no `GET` da folha e no `summary` do `PUT` e do `DELETE`. Vários examinadores marcam o mesmo exame ao mesmo tempo; com leitura eventualmente consistente, o resumo devolvido logo depois de uma marcação podia não incluir a marcação de outro item gravada milissegundos antes, e `marked`, `correct` e `percent` saíam um item atrás (#50). A leitura consistente custa 1 RCU a cada 4 KB, em vez de 0,5.

**Limitação: o `total` vem de um GSI.** Os itens da faixa-alvo (e, portanto, o `total` de cada tipo e a lista `items`) vêm do índice `by_belt` de `Requirements`, e o DynamoDB não aceita leitura consistente em GSI. Um item recém-criado ou movido de faixa (RN017) pode demorar um pouco (normalmente menos de um segundo) a aparecer no `total` e na folha. As marcações em si não são afetadas: a transação confere o requisito na tabela base.

**Conta de capacidade no dev (`Answers`: 3 RCU).** Cada item de `Answers` tem cerca de 270 bytes (UUIDs de exame, requisito, evento, aluno e `sub`, mais `correct` e `marked_at`). A consulta soma o tamanho dos itens devolvidos e arredonda para 4 KB, e a marcação do k-ésimo item lê as k marcações do exame. Contando todos os itens da faixa-alvo marcados:

| Faixa-alvo | Itens | Marcações do exame cheio | RCU por leitura, consistente (antes) | Média por marcação ao longo do exame |
| --- | --- | --- | --- | --- |
| mediana (58 itens) | 58 | ~15,7 KB | 4 (2) | ~2,5 RCU (antes ~1,2) |
| maior (Marrom, 139 itens) | 139 | ~37,5 KB | 10 (5) | ~5,1 RCU (antes ~2,6) |

Com 3 RCU em `Answers`, o dev sustenta em média cerca de 1,2 marcação por segundo na faixa mediana (antes, 1,5, limitado pelas escritas de 3 WCU) e cerca de 0,6 por segundo em exames de Marrom (antes, cerca de 1,2); cada `GET` da folha custa o mesmo que uma leitura do exame cheio. Num dia de exame, três examinadores marcando um item a cada 5 a 10 segundos somam 0,3 a 0,6 marcação por segundo, dentro do limite; picos acima disso usam o burst do DynamoDB (até 300 segundos de capacidade não usada) e, se ele acabar, as leituras são repetidas pelo botocore e, se persistirem, a resposta é 503. A capacidade não mudou: o total do free tier (25 RCU) já está todo distribuído. O prod é `PAY_PER_REQUEST` e não tem esse limite.

**Modelagem.** As respostas ficam na tabela `Answers` (PK `exam_id`, o UUID do exame; SK `requirement_id`), uma por (exame, requisito), com `correct`, `marked_by`, `marked_at`, `event_id` e `student_id`. A chave é o UUID do exame, e não `event_id#student_id`, para que respostas de um exame apagado nunca apareçam num exame novo do mesmo aluno no mesmo evento.

**Contador de respostas.** A transação da primeira resposta de um item num exame soma 1 ao atributo `answer_count` do requisito; desmarcar subtrai 1, e substituir não mexe no contador. O `DELETE /requirements/{id}` é condicional a `answer_count` zero ou ausente. Assim, uma resposta gravada durante a exclusão ainda resulta em 409, e uma marcação que chega depois da exclusão recebe 404 sem recriar o item. O `PUT /requirements/{id}` usa `UpdateItem` só nos campos do modelo e nunca perde o contador; a condição da mesma gravação só aceita trocar `belt_id` ou `kind` com `answer_count` zero ou ausente (409 caso contrário). Assim, uma primeira marcação que chega entre a leitura e a gravação do `PUT` ainda bloqueia a troca, e uma resposta nunca fica órfã fora da folha e do percentual do exame.

### Decisão do sensei (RN008, RN008a, RN009, RN010)

`POST /events/{id}/exams/{student_id}/decision` aprova ou reprova o exame:

```json
{"result": "APPROVED", "notes": "Ótimo ukemi"}
```

- `result`: `APPROVED` (aprovado) ou `FAILED` (reprovado), obrigatório.
- `notes`: observação opcional, até 500 caracteres; gravada sem espaços nas pontas. Ausente, `null` ou só espaços → sem observação.

A resposta (200) traz o exame decidido e, na aprovação, o aluno já com a nova graduação (`null` na reprovação):

```json
{
  "exam": {"id": "…", "status": "APPROVED", "decided_by_id": "<sub do sensei>",
           "decided_at": "2027-03-20T15:00:00+00:00", "notes": "Ótimo ukemi",
           "student_name": "Ana", "…": "…"},
  "student": {"id": "…", "current_belt_id": "<faixa-alvo>", "current_belt_since": "2027-03-20",
              "stripes": 0, "…": "…"}
}
```

- **Quem decide (RN008):** só o usuário gravado em `sensei_user_id` nas configurações, lido a cada decisão, e independentemente do percentual. O master só decide se for ele o sensei. A rota é de examinadores: o sensei precisa estar no grupo `admin` **no token** (claim `cognito:groups`; a rota não consulta o Cognito). Quem saiu do grupo deixa de decidir quando o token é renovado (no máximo 1 h).
- **Efeito da aprovação (RN009):** exame de faixa (`BELT`) → o aluno passa para `target_belt_id`, `current_belt_since` = data do evento e `stripes` = 0. Exame de grau (`STRIPE`) → `stripes` + 1, faixa e data mantidas. Reprovado: nada muda no aluno. Também muda o `updated_at` do aluno; `exam_count` e os demais campos ficam como estão.
- **Evento encerrado (RN008a):** a decisão continua permitida.
- **Aluno inativado depois da presença:** a decisão continua permitida (o aluno segue inativo, com a nova graduação se aprovado).
- **Graduação mudou desde a presença:** se a faixa, a data da faixa ou os graus do aluno não forem mais os da graduação de origem, a decisão (aprovação **ou** reprovação) é recusada e nada é gravado. Em exames antigos, sem a graduação de origem, a conferência possível é feita: a faixa-alvo precisa ser a faixa imediatamente seguinte à atual do aluno e o tipo do exame precisa corresponder aos graus atuais (RN004); se não, a mesma recusa.

| Situação | Resposta |
| --- | --- |
| responsável, ou conta fora do grupo `admin` no token / sem login | 403 "Esta área é dos examinadores" / 401 "Faça login para continuar" |
| evento ou exame inexistente | 404 "Evento não encontrado" / "Exame não encontrado" |
| nenhum sensei definido | 409 "Defina o sensei nas configurações da academia" |
| examinador que não é o sensei (inclusive o master) | 403 "Somente o sensei pode decidir o exame" |
| exame já decidido (RN010), inclusive numa decisão simultânea | 409 "Exame já decidido" |
| `result` ausente ou diferente de `APPROVED`/`FAILED` | 400 "Resultado inválido: envie result como APPROVED (aprovado) ou FAILED (reprovado)" |
| `notes` que não é texto / longo demais | 400 "Observação: valor inválido" / "Observação: máximo de 500 caracteres" |
| corpo que não é um objeto JSON | 400 "Corpo da requisição inválido: envie um objeto JSON" |
| aluno do exame inexistente | 404 "Aluno não encontrado" |
| outro exame do aluno marcado como em andamento (só com dados de antes da regra de exame único, RN005) | 409 "O aluno já tem um exame em andamento em outro evento." |
| graduação do aluno mudou desde a presença | 409 "A graduação do aluno mudou desde a presença. Confira antes de decidir." |
| conflito de transação que persistiu | 409 "Outra alteração deste exame está em andamento. Tente de novo." |
| limite de capacidade do DynamoDB que persistiu | 503 "Sistema ocupado no momento. Tente de novo em instantes." |

Sem sensei a resposta é 409, e não 400, porque o corpo está certo: o que falta é configurar a academia. As verificações seguem a ordem da tabela. A troca de sensei entre a leitura e a gravação também é barrada: quem deixou de ser o sensei recebe 403 "Somente o sensei pode decidir o exame" e, se o sensei foi removido, 409 "Defina o sensei nas configurações da academia"; nada é gravado.

**Gravação atômica.** A decisão é uma transação (`TransactWriteItems`) com três itens: o `UpdateItem` do exame, condicionado a ainda ser o mesmo exame (`id`) e estar `IN_PROGRESS`; no aluno, um `UpdateItem` condicionado a que a faixa, a data da faixa e os graus ainda sejam os esperados e a que `exam_in_progress_id` seja o do exame decidido (ou não exista): ele remove `exam_in_progress_id` (RN005) e, na aprovação, grava também os campos da graduação; e um `ConditionCheck` em `Settings` de que `sensei_user_id` ainda é quem decide (RN008). Se essa condição falhar, as configurações são relidas para separar a troca de sensei (403) da remoção (409). Por isso duas decisões simultâneas resultam em um 200 e um 409 "Exame já decidido", e a aprovação nunca é aplicada duas vezes. As marcações (RN006) conferem o mesmo `status` na própria transação: uma marcação que leu o exame antes da decisão e grava depois recebe 409 "Exame já decidido" e não entra. Uma marcação gravada antes da decisão fica como está. O evento não entra na transação: um evento com exames não pode ser apagado (`exam_count`), e o encerrado aceita a decisão. Conflitos de transação e limite de capacidade dentro da transação são repetidos algumas vezes com espera crescente; se persistirem, 409 ou 503 (a mesma requisição pode ser reenviada). Cada decisão custa 2 WCU em `Exams`, 2 em `Students` e 2 em `Settings` (o `ConditionCheck`, que numa transação também conta em dobro), o mesmo de antes: na reprovação o `ConditionCheck` no aluno virou `UpdateItem`, que custa o mesmo numa transação.

### Histórico de exames do aluno (RN018)

`GET /students/{id}/exams` devolve todos os exames do aluno, do mais recente para o mais antigo. Nenhum exame é apagado (RN018), então o histórico tem também os exames em andamento e os de aluno inativo. A rota é só dos examinadores: o responsável, mesmo dono do aluno, recebe 403 "Esta área é dos examinadores" antes de qualquer leitura, sem saber nem se o aluno existe. Se os pais vão ver o histórico é um ponto em aberto da arquitetura (card #39).

```json
[
  {"event_id": "…", "event_name": "Exame setembro/2027", "exam_date": "2027-09-25",
   "target_belt_id": "…", "target_belt_name": "Azul", "kind": "BELT", "status": "FAILED",
   "decided_by_id": "<sub do sensei>", "decided_at": "2027-09-25T15:00:00+00:00",
   "notes": "Treinar as quedas", "created_at": "2027-09-25T12:00:00+00:00",
   "source": {"belt_id": "…", "belt_name": "Cinza/Azul", "belt_since": "2027-03-20", "stripes": 0}},
  {"event_id": "…", "event_name": "Exame março/2027", "exam_date": "2027-03-20",
   "target_belt_id": "…", "target_belt_name": "Cinza/Azul", "kind": "BELT", "status": "APPROVED",
   "decided_by_id": "<sub do sensei>", "decided_at": "2027-03-20T15:00:00+00:00",
   "notes": "Ótimo ukemi", "created_at": "2027-03-20T12:00:00+00:00",
   "source": {"belt_id": "…", "belt_name": "Cinza", "belt_since": "2026-03-14", "stripes": 0}}
]
```

- A resposta é um array, como nas outras listas (`GET /students`, `GET /events/{id}/exams`). Aluno sem exames → `[]`.
- Cada item traz os campos do exame (§ 3.5) com o nome e a data do evento e o nome da faixa-alvo. `kind`: `STRIPE` (grau) ou `BELT` (faixa). `status`: `IN_PROGRESS` (em andamento; `decided_by_id`, `decided_at` e `notes` vêm `null`), `APPROVED` ou `FAILED`. `created_at` é a confirmação da presença. **Sem percentuais:** as marcações não são lidas; o percentual de cada exame continua na ficha (`GET /events/{id}/exams/{student_id}`).
- `source` é a graduação do aluno na presença (faixa, data da faixa e graus), a mesma que a decisão confere; `null` em exames confirmados antes de ela ser guardada (só no dev). Ajuda a ler o exame de grau (`STRIPE`): a faixa-alvo é a seguinte, de onde vêm os itens, mas o aluno continua na faixa de origem.
- **Histórico preservado:** faixa-alvo, tipo e origem são os gravados no exame na presença. Trocar a faixa do aluno depois, pela aprovação ou pela edição, não muda nenhum exame antigo. Os nomes (`event_name`, `target_belt_name`, `source.belt_name`) são os atuais do evento e da faixa.
- Evento ou faixa que não existe mais → o nome vem `null`, sem erro. Isso só acontece com dado apagado à mão: evento com exames não pode ser excluído (RN016) e nenhuma rota apaga faixa. Sem o evento, `exam_date` também vem `null`, e o exame vai para o fim da lista.
- **Ordem:** pela `exam_date` do evento, da mais recente para a mais antiga; na mesma data, a presença mais nova primeiro (`created_at`); por fim `event_id`, para a ordem ser estável.

| Situação | Resposta |
| --- | --- |
| sem login / responsável (mesmo o dono do aluno) | 401 "Faça login para continuar" / 403 "Esta área é dos examinadores" |
| aluno inexistente | 404 "Aluno não encontrado" |
| limite de capacidade do DynamoDB que persistiu em qualquer leitura (aluno, índice `by_student`, eventos ou faixas) | 503 "Sistema ocupado no momento. Tente de novo em instantes." |

Outros erros do DynamoDB respondem 500 "Erro interno. Tente de novo.", como nas demais rotas.

**Leituras.** O aluno é lido por chave, com `ConsistentRead=True`, porque decide o 404 (veja "Leitura consistente nas leituras por chave"). Os exames vêm do índice `by_student` de `Exams`: um `Query` que segue `LastEvaluatedKey` até a última página, sem `Limit`. Os eventos vêm num `BatchGetItem`, até 100 por chamada; as chaves que o DynamoDB devolve em `UnprocessedKeys` por falta de capacidade são pedidas de novo até 3 vezes, com espera crescente (de 0,05 a 0,4 s, no máximo 0,7 s somadas), e, se ainda sobrarem, a resposta é 503. As faixas vêm de um `Scan` em `Belts`. Eventos e faixas usam leitura eventual porque não decidem o código da resposta, e a `exam_date`, que decide a ordem, não muda depois da criação do evento. No pior caso, um nome editado há menos de um segundo aparece com o valor anterior. Aluno sem exames não lê eventos nem faixas.

**Limitação: o índice `by_student` é um GSI.** O DynamoDB não aceita leitura consistente em GSI. Um exame recém-criado pela presença pode demorar um pouco (normalmente menos de um segundo) a aparecer, e um exame recém-decidido pode aparecer ainda com a situação anterior. Recarregar a tela resolve.

**Rota própria (decisão do usuário, 2026-11-05).** A arquitetura descreve `GET /alunos/{id}` como "Detalhe do aluno e histórico de exames". O histórico ficou numa rota separada para que o `GET /students/{id}`, usado pelo formulário de edição, não fique mais caro nem falhe por causa do histórico; a resposta dele não mudou. O desvio é só de formato: o conteúdo é o que a arquitetura pede.

**Permissões** (`ListStudentExamsFunction`): `dynamodb:GetItem` em `Students`, `dynamodb:Query` só no índice `by_student` de `Exams` (não na tabela), `dynamodb:BatchGetItem` em `Events` e `dynamodb:Scan` em `Belts`. Nenhum acesso a `Answers`, a `Settings`, ao Cognito ou ao S3, e nenhuma gravação.

**Custo no dev.** Cada histórico custa 1 RCU no aluno (`Students`, 3 RCU), cerca de 0,5 no índice `by_student` (1 RCU; a consulta soma o tamanho dos exames, cerca de 0,5 KB cada), 0,5 por evento no `BatchGetItem` (`Events`, 2 RCU; cada item conta como 4 KB) e cerca de 0,5 no `Scan` das faixas (`Belts`, 3 RCU). Um aluno com 10 exames lê cerca de 5 RCU de `Events` de uma vez, o que o burst do DynamoDB cobre. A capacidade não mudou.

### Avisos de exame ao responsável (RN019)

`GET /students/{id}/exam-notices` devolve os avisos de exame de um aluno do responsável: um item por evento **aberto** em que o aviso vale. O front mostra cada item no perfil do aluno como "Exame de faixas dia dd/mm/aaaa" (§ 6.2). A rota só lê: o aviso é informativo, e o responsável não altera a data nem o exame.

```json
[
  {"event_id": "…", "event_name": "Exame dezembro/2026", "event_date": "2026-12-05",
   "target_belt_id": "…", "target_belt_name": "Cinza/Azul", "kind": "BELT"},
  {"event_id": "…", "event_name": "Exame março/2027", "event_date": "2027-03-20",
   "target_belt_id": "…", "target_belt_name": "Cinza/Azul", "kind": "BELT"}
]
```

- A resposta é um array, como nas outras listas. Sem aviso → `[]` (200).
- `event_date` é a data do evento (`exam_date` do evento), em `AAAA-MM-DD`; o front formata. `target_belt_id`, `target_belt_name` e `kind` (`STRIPE`, grau, ou `BELT`, faixa) têm o mesmo nome e formato de `eligibility` em `GET /students` e do histórico.
- **Só o mínimo do aviso (RN016):** a rota não devolve a lista de eventos nem a situação deles, e não traz percentuais, situação do exame, examinadores nem dados de outros alunos.
- **Ordem:** pela data do evento, da mais próxima para a mais distante; na mesma data, pelo `event_id`, para a ordem ser estável.

**Quando o aviso vale.** Para cada evento aberto:

| Situação do aluno | Aviso daquele evento |
| --- | --- |
| inativo | não (nenhum aviso, de nenhum evento) |
| sem exame no evento e elegível na **data do evento** (RN001 a RN004) | sim, com a faixa-alvo e o tipo calculados nessa data |
| sem exame no evento e não elegível na data do evento (idade, carência ou sem próxima faixa) | não |
| com exame em andamento em **outro** evento, aberto ou encerrado (RN005, RN008a) | não |
| com exame em andamento **neste** evento | sim, até a decisão, com a faixa-alvo e o tipo gravados no exame na presença |
| com exame decidido neste evento (aprovado ou reprovado) | não |

Evento encerrado nunca tem aviso; reaberto, volta a ter. A elegibilidade usa a mesma regra da presença (`domain.eligibility.evaluate`), sempre na data do evento e nunca na de hoje: o aluno que só completa a carência na data do evento já tem o aviso, e um evento ainda aberto depois da própria data continua avaliado naquela data. A presença só é confirmada na porta do evento, então o aviso vale para todo aluno elegível, com ou sem presença (decisão do usuário, card #106). Depois da aprovação, os avisos dos outros eventos são recalculados com a nova graduação (RN009).

| Situação | Resposta |
| --- | --- |
| sem login | 401 "Faça login para continuar" |
| examinador (inclusive master e sensei, e mesmo que seja o dono do aluno) | 403 "Esta área é dos responsáveis" |
| id vazio ou com mais de 1024 bytes, aluno inexistente ou aluno de outro responsável (RN013) | 404 "Aluno não encontrado" |
| limite de capacidade do DynamoDB que persistiu em qualquer leitura (aluno, eventos, índice `by_student` ou faixas) | 503 "Sistema ocupado no momento. Tente de novo em instantes." |

A permissão vem antes de qualquer leitura: o examinador recebe o 403 sem que nada seja lido, nem o id conferido. O aluno de outro responsável responde o mesmo 404 de `GET /students/{id}`, para não revelar que o aluno existe (RN013). Outros erros do DynamoDB respondem 500 "Erro interno. Tente de novo.".

**Leituras.** No máximo quatro chamadas, qualquer que seja o número de alunos da academia: `GetItem` do aluno, com `ConsistentRead=True`, porque decide o 404; `Scan` em `Events`; `Query` no índice `by_student` de `Exams` (os exames do aluno); e `Scan` em `Belts`. Aluno inativo só lê o aluno; sem evento aberto, a rota para depois do `Scan` dos eventos. Eventos, exames e faixas usam leitura eventual (o `by_student` é um GSI e não aceita outra): um evento encerrado, uma presença ou uma decisão de menos de um segundo atrás pode ainda não aparecer, e recarregar a tela resolve. Como o aviso é só informativo, isso não decide nada.

**`Scan` em `Events`.** É a única leitura que cresce, e cresce com o total de eventos da academia (alguns por ano, cerca de 0,2 KB cada), não com o de alunos: 100 eventos cabem em 20 KB, 2,5 RCU na leitura eventual. Um filtro por situação no `Scan` não reduziria o custo, porque o DynamoDB cobra pelos itens lidos, não pelos devolvidos. Se um dia pesar, o caminho é um índice por situação em `Events`, o que mexe na capacidade provisionada do dev.

**Permissões** (`ListStudentExamNoticesFunction`): `dynamodb:GetItem` em `Students`, `dynamodb:Scan` em `Events`, `dynamodb:Query` só no índice `by_student` de `Exams` (não na tabela) e `dynamodb:Scan` em `Belts`. Nenhum acesso a `Answers`, a `Settings`, ao Cognito ou ao S3, e nenhuma gravação.

**Custo no dev.** Cada consulta custa 1 RCU no aluno (`Students`, 3 RCU), cerca de 0,5 no `Scan` dos eventos (`Events`, 2 RCU), cerca de 0,5 no índice `by_student` (1 RCU) e cerca de 0,5 no `Scan` das faixas (`Belts`, 3 RCU). A capacidade não mudou.
