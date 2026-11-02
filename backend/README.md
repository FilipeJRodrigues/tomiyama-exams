# Backend — exames de graduação de Judô

Python 3.12 em AWS Lambda, DynamoDB (provisionado no dev, on-demand no prod), Cognito e API Gateway (HTTP API).
A infraestrutura fica em [`../infra/template.yaml`](../infra/template.yaml) (AWS SAM).

## Estrutura

```
src/
├── handlers/    # uma função Lambda por rota + utilitários HTTP
├── domain/      # regras de negócio puras (RN001–RN018), sem acesso à AWS
└── repository/  # acesso ao DynamoDB e (leitura) ao Cognito
tests/           # pytest + moto; testes de regra nomeados test_rnXXX_*
```

## Testes

```bash
cd backend
uv sync --python 3.12
uv run pytest
```

## Deploy

Precisa do [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). Os comandos rodam dentro de `infra/`.

### Parâmetros do template

| Parâmetro | Padrão | Uso |
| --- | --- | --- |
| `AdminEmail` | (obrigatório) | Primeiro examinador; recebe a senha temporária e os alertas do Budgets. |
| `AllowedOrigin` | `http://localhost:5173` | Origem liberada no CORS (troque pela URL do Amplify). |
| `BudgetLimitUsd` | `1` | Limite mensal (US$) do alerta do AWS Budgets: e-mail ao passar de 80% do real e de 100% da previsão. |
| `Environment` | `dev` | `dev` ou `prod`; veja a tabela abaixo. |

| | `dev` | `prod` |
| --- | --- | --- |
| DynamoDB | `PROVISIONED`, 25 RCU e 24 WCU somando as 7 tabelas e os 3 GSIs (free tier permanente: até 25/25), sem auto scaling | `PAY_PER_REQUEST` |
| PITR | desligado | ligado |
| Retenção dos logs das funções | 7 dias | 30 dias |
| Tabelas ao apagar a stack | apagadas | mantidas |

**Atenção no dev:** apagar a stack dev (ou o rollback de um primeiro deploy que falhou) apaga as tabelas e os dados de teste. Se sobrar tabela de um deploy antigo (de antes desta regra, por exemplo), apague-a antes de reimplantar: ela continua provisionada e ocupa parte dos 25 RCU/WCU do free tier. No prod as tabelas ficam (`DeletionPolicy` e `UpdateReplacePolicy` `Retain`). O template usa a transform `AWS::LanguageExtensions` para escolher a política pelo ambiente, por isso o deploy pede `CAPABILITY_AUTO_EXPAND`.

As capacidades de cada tabela e GSI ficam no mapping `DevCapacity` do template; `tests/test_template.py` falha se a soma passar de 25. Cada marcação de item (RN006) é uma transação que custa 2 WCU em `Exams`, em `Events` e em `Answers` (e mais 2 em `Requirements`, além da escrita no GSI `by_belt`, na primeira marcação do item); com 3 WCU em cada uma, o dev aguenta em média 1,5 marcação por segundo somando todos os examinadores, com folga para picos curtos (burst do DynamoDB). O free tier vale para a conta inteira na região: outra stack provisionada na mesma conta e região soma no mesmo limite.

Todas as funções escrevem no log group `/aws/lambda/<stack>`, um stream por função.

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

**E-mail sem distinção de maiúsculas.** O nome de usuário é o e-mail, e o pool tem `UsernameConfiguration.CaseSensitive: false`: `Mae.Silva@example.com` e `mae.silva@example.com` são a mesma conta. O front também normaliza o e-mail para minúsculas antes de cadastrar e entrar. Essa opção só é definida na criação do pool, e o CloudFormation não recria o pool sozinho ao mudá-la: mudá-la exige apagar e recriar o pool (no dev, apagar e recriar a stack). Isso gera novos `UserPoolId` e `UserPoolClientId` (atualize a configuração do front), apaga as contas (o examinador inicial recebe uma nova senha temporária) e, como os alunos guardam o `sub` do dono (`owner_id`), quebra o vínculo dos responsáveis com os próprios alunos. Por isso, no prod, decida antes do primeiro deploy.

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
| GET | /events | examinador |
| POST | /events | examinador |
| GET/PUT/DELETE | /events/{id} | examinador |
| GET | /events/{id}/exams | examinador |
| POST | /events/{id}/exams | examinador |
| GET | /events/{id}/exams/{student_id} | examinador |
| PUT/DELETE | /events/{id}/exams/{student_id}/answers/{requirement_id} | examinador |
| POST | /events/{id}/exams/{student_id}/decision | examinador (só o sensei decide) |
| GET/PUT | /settings | examinador |
| GET | /examiners | examinador |

`GET /students` aceita os filtros `active=true|false`, `belt_id` e `reference_date=AAAA-MM-DD`. O último é a data da elegibilidade; sem ele, vale a data de hoje.

`PUT /students/{id}` recebe todos os campos do `POST`. Enquanto o aluno tiver um exame em andamento (RN005), a troca de faixa (`current_belt_id`), da data da faixa (`current_belt_since`) ou dos graus (`stripes`) é recusada com 409 "Não é possível alterar a graduação com exame em andamento. Decida o exame primeiro." e nada é gravado, para examinadores e responsáveis. Nome, nascimento, registro e ativo continuam editáveis, e reenviar a mesma graduação (como o formulário faz) é aceito. Quando a graduação enviada é a mesma da leitura, a gravação não toca nos campos da graduação: só os outros campos são gravados, então uma aprovação do sensei entre a leitura e a gravação não é desfeita (RN009). A resposta (200) traz o aluno como ficou gravado (`ReturnValues=ALL_NEW`), já com a graduação da aprovação nesse caso. Limite de capacidade do DynamoDB que persistiu, na leitura do aluno, do marcador ou na gravação → 503 "Sistema ocupado no momento. Tente de novo em instantes." (vale também para `GET` e `DELETE /students/{id}`). Depois da decisão do sensei a graduação volta a ser editável. A condição está na própria gravação (`UpdateItem` condicionado a `exam_in_progress_id` ausente, só quando a graduação muda), então uma presença confirmada no meio da edição também barra a troca. **Precedência para o responsável:** a trava do RN013 (403 "Somente examinadores alteram a graduação após o primeiro exame") vem antes, porque continua valendo depois da decisão; como todo aluno com exame em andamento já tem exame, o responsável que tenta trocar a graduação recebe sempre o 403. Aluno apagado no meio do caminho → 404.

`GET /requirements` aceita os filtros `belt_id` e `kind=THEORY|PRACTICE`. Sem filtro, devolve todos os itens na ordem das faixas e da folha. No `POST`, sem `sort_order`, o item vai para o fim da faixa. O `PUT` recebe os mesmos campos do `POST`; se o item já tiver resposta em algum exame, a troca de `belt_id` ou de `kind` é recusada com 409 "Não é possível trocar a faixa ou o tipo de um requisito com respostas registradas" e nada é gravado. Descrição, resposta esperada, categoria e ordem continuam editáveis, e reenviar a mesma faixa e o mesmo tipo (como o formulário faz) é aceito. O `DELETE` é recusado com 409 "Requisito possui respostas registradas" se algum exame tiver resposta para o item (veja "Contador de respostas" abaixo).

`GET /events` devolve os eventos do mais recente para o mais antigo (`exam_date`; empate pelo mais novo cadastro). No `POST`, `status` é opcional (padrão `OPEN`). O `PUT` altera `name` e `status`; um evento `CLOSED` pode ser reaberto. A `exam_date` não muda depois da criação: reenviar a mesma data é aceito, outra data é recusada. O `DELETE` é recusado (409) se o evento tiver exames.

`POST /events/{id}/exams` confirma a presença (RN005) com o corpo `{"student_id": "..."}` e devolve 201 com o exame criado: faixa-alvo (`target_belt_id`) e tipo (`kind`: `STRIPE` ou `BELT`) calculados na **data do evento**, `status` `IN_PROGRESS` e quem confirmou (`created_by`). Recusa com 400 se o evento estiver encerrado ("Evento encerrado"), se o aluno estiver inativo ("Aluno inativo não pode fazer exame") ou inelegível (os motivos da elegibilidade, separados por `; `); 404 para evento ou aluno inexistente; 409 se a presença já foi confirmada ("Presença já confirmada neste evento") ou se o aluno já tem um exame `IN_PROGRESS` em outro evento ("O aluno já tem um exame em andamento em outro evento."; nada é gravado). A gravação é uma única transação (`TransactWriteItems`): o exame só entra se ainda não existir e se, no mesmo instante, o evento existir e estiver aberto e o aluno existir e estiver ativo. Por isso confirmações simultâneas do mesmo aluno resultam em um 201 e um 409, e um evento apagado ou encerrado no meio do caminho nunca recebe exame. Conflitos de transação são repetidos algumas vezes; se persistirem, a resposta é 409 "Outra confirmação está em andamento. Tente de novo.". A transação também exige que a faixa atual, a data da faixa e os graus do aluno ainda sejam os lidos ao calcular a faixa-alvo; se mudaram no meio do caminho, a resposta é 409 "Os dados do aluno mudaram. Tente de novo." e nada é gravado.

O exame também guarda a **graduação de origem**, a do aluno no momento da presença: `source_belt_id`, `source_belt_since` e `source_stripes`. A decisão (RN008) usa esses campos para saber se a graduação mudou desde a presença. Exames confirmados antes desta versão não têm os campos (vêm `null`); veja a decisão abaixo.

**Contador de exames.** A mesma transação soma 1 ao atributo `exam_count` do evento e do aluno (itens sem o atributo contam como zero). O `DELETE /events/{id}` e o `DELETE /students/{id}` são gravações condicionais a `exam_count` zero ou ausente, então uma presença confirmada no meio da exclusão ainda resulta em 409 ("Evento possui exames registrados" / "Aluno possui exames registrados") e nada é apagado. Pelo mesmo contador, quando um responsável altera faixa, data da faixa ou graus, a gravação só acontece se o aluno ainda não tiver exame (403 "Somente examinadores alteram a graduação após o primeiro exame"). As edições de evento e aluno usam `UpdateItem` só nos campos do modelo e nunca perdem o contador.

**Um exame em andamento por aluno** (RN005, decisão do responsável de 2026-11-02). A mesma transação da presença grava no aluno o atributo `exam_in_progress_id` (o `id` do exame criado), com a condição de que ele ainda não exista. Se o aluno já tem um exame em andamento em outro evento, a resposta é 409 "O aluno já tem um exame em andamento em outro evento." e nada é gravado; no mesmo evento continua valendo 409 "Presença já confirmada neste evento", que tem precedência. Como a condição está na transação, duas presenças simultâneas do mesmo aluno em eventos diferentes resultam em um 201 e um 409. A decisão do sensei (aprovação ou reprovação) remove o atributo na própria transação, e o aluno fica livre para outra presença. A remoção é condicionada a o atributo ser o do exame decidido (ou não existir). O atributo é interno: não aparece nas respostas de `/students`, e as edições do aluno (`PUT /students/{id}`) não o apagam, porque mexem só nos campos do modelo. **Dados antigos:** exames em andamento confirmados antes desta regra (só existem no dev) não têm o atributo e não bloqueiam outra presença; se o aluno tiver um desses e um exame novo com o atributo, decidir o antigo responde 409 "O aluno já tem um exame em andamento em outro evento." até o novo ser decidido. Se o novo for **aprovado**, a graduação do aluno muda e deixa de ser a da presença do exame antigo (sem marcador); daí em diante decidir o exame antigo responde 409 "A graduação do aluno mudou desde a presença. Confira antes de decidir." para sempre (o exame antigo fica `IN_PROGRESS` e não tem saída pela API). Enquanto o atributo existir, a graduação do aluno não pode ser alterada pelo `PUT /students/{id}` (409, veja acima), então o exame não fica preso por uma graduação diferente da de origem.

`GET /events/{id}/exams` lista os exames do evento em ordem alfabética do aluno, cada um com `student_name`.

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
- As imagens (logos e assinaturas do certificado) nunca aparecem neste JSON (RN012); terão rotas próprias. Os nomes, graduações e imagens que vão no certificado serão as **assinaturas do certificado** (até 3, geridas pelo master e pelo sensei; passo 5), e não campos destas configurações.

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
