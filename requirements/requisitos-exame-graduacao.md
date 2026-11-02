# Requisitos — Sistema de exame de graduação de Judô

> Documento de entrada para um agente construir o sistema do zero. Reúne os requisitos
> levantados e validados numa prova de conceito (POC) anterior. **Não depende de nenhum
> template, CLI ou código da POC**: a stack é livre (ver § 11). Os itens de exame de cada
> faixa estão completos no **Apêndice A**.
>
> Versão: 2026-11-01 · Idioma do produto: português do Brasil (pt-BR).

---

## 1. Contexto e problema

Uma academia de Judô (Academia Tomiyama, Araraquara/SP, filiada à Federação Paulista e à
Confederação Brasileira de Judô) faz os exames de graduação de faixa **em papel**:

- imprime-se a folha de requisitos da próxima faixa de cada aluno;
- examinadores marcam um "check" em cada resposta;
- a idade mínima e a carência são conferidas à mão;
- os certificados são montados um a um no Canva.

São **~80 alunos num único sábado**, **2 exames por ano** (março e outubro), com **2 ou
mais examinadores** para a parte teórica e o **sensei** avaliando a parte prática (golpes).

**Objetivo do sistema:** digitalizar o exame de ponta a ponta — cadastro do aluno,
bloqueio automático por idade/carência, marcação item a item no dia, percentual de acertos,
decisão do sensei e certificado em PDF — eliminando papel e Canva. A **decisão continua
humana** (do sensei).

**Fora do escopo desta versão:** faixa preta (exame da federação); conteúdo de
Jiu-jitsu; **pular faixas** (a CBJ dispensa a sequência acima de 16 anos, mas a v1 examina
sempre para a próxima faixa); aprovação automática pelo percentual; acesso pela internet.

**Escopo da primeira versão:** só **Judô**, faixas de **Branca/Cinza até Marrom**. Faixa
preta fica fora (é exame da federação). O modelo deve permitir outras modalidades no
futuro (ex.: Jiu-jitsu), mas só Judô é carregado agora.

---

## 2. Perfis de usuário

| Perfil | Quem é | O que faz |
|---|---|---|
| **Responsável/aluno** | Qualquer pessoa que cria conta (cadastro aberto, e-mail + senha) | Cadastra **um ou mais alunos** (pais com vários filhos); vê e edita só os próprios alunos; vê a elegibilidade de cada um |
| **Examinador** | Usuário administrador | Gerencia faixas, requisitos e eventos; confirma presença; marca os itens do exame |
| **Admin master** | Um examinador com poder extra *(decisão do responsável, 2026-11-02)* | Tudo do examinador **e** é o **único** que escolhe/troca o sensei; gere as assinaturas do certificado; **não** decide exames |
| **Sensei** | Um examinador específico, escolhido pelo master nas configurações | Tudo do examinador **e** é o **único** que aprova/reprova; gere as assinaturas do certificado |

Como os perfis nascem:

- **Primeiro examinador:** criado na instalação (e-mail e senha definidos na configuração
  do servidor).
- **Novos examinadores:** um examinador promove uma conta existente a examinador (ou cria
  a conta já como examinador) numa tela de usuários; também pode desativar contas.
- **Admin master:** o primeiro examinador já nasce master; outros, só pelo console da
  nuvem (Cognito), nunca pelo sistema. Master é sempre também examinador *(decisão do responsável, 2026-11-02)*.
- **Sensei:** escolhido **pelo master** entre os examinadores ativos, na aba Academia (§ 6.6).
- **Contas:** senha com no mínimo 8 caracteres; recuperação de senha por e-mail é
  desejável, mas opcional nesta fase (a POC rodava sem servidor de e-mail).

Regras de acesso:

- Rotas de exame, faixas (escrita), requisitos, eventos e configurações: **só examinadores**.
- Faixas (leitura): qualquer usuário logado (o cadastro do aluno escolhe a faixa atual).
- Itens de menu de examinador ficam **ocultos** para responsáveis. Se um responsável abrir
  uma rota de examinador pelo endereço, a tela diz "Esta área é dos examinadores" e
  oferece o link para "Meus alunos".

---

## 3. Modelo de dados

Identificadores sugeridos em inglês; rótulos de tela em pt-BR. Todos os registros têm
`id` (UUID) e `created_at`. Datas sem hora (nascimento, data na faixa, data do exame) são
**dias de calendário**: guarde como data (ou meia-noite UTC) e nunca converta para o fuso
local ao exibir (sempre `dd/mm/aaaa`).

### 3.1 Faixa (`Belt`)
| Campo | Tipo | Regras |
|---|---|---|
| `name` | texto ≤ 40 | único (ex.: "Cinza/Azul") |
| `kyu` | inteiro, opcional | 11 a 1; Branca sem kyū |
| `sort_order` | inteiro | único; define a sequência (Branca = 0 … Marrom = 11) |
| `level` | enum `BASIC` / `INTERMEDIATE` | rótulos "Básico" / "Intermediário" |
| `min_age_years` | inteiro ≥ 0 | idade mínima |
| `min_months_previous` | inteiro ≥ 0 | carência mínima na faixa anterior (meses) |
| `color_primary` | `#RRGGBB` | cor da faixa |
| `color_secondary` | `#RRGGBB`, opcional | cor das pontas (faixas de duas cores) |

Faixas não são criadas nem excluídas pela tela (só editadas). Carga inicial no § 4.

### 3.2 Requisito da faixa (`BeltRequirement`) — **um registro por item avaliado**
| Campo | Tipo | Regras |
|---|---|---|
| `belt_id` | FK → Faixa | obrigatório |
| `kind` | enum `THEORY` / `PRACTICE` | "Teórico" / "Prático" |
| `category` | texto ≤ 60 | ex.: Naguewaza, Vocabulário, Histórico |
| `description` | texto longo | o que se pergunta/pede (ex.: "Contar até 10 em japonês") |
| `expected_answer` | texto longo, opcional | resposta esperada, mostrada ao examinador |
| `sort_order` | inteiro | ordem na folha |

Cada golpe, cada termo do vocabulário e cada fato histórico é **um item** (necessário para
o percentual por item). Carga inicial no **Apêndice A** (692 itens).

### 3.3 Aluno (`Student`) — pertence ao responsável que o cadastrou
| Campo | Tipo | Regras |
|---|---|---|
| `owner_id` | FK → Usuário | quem cadastrou |
| `full_name` | texto ≤ 120 | obrigatório |
| `birth_date` | data | obrigatório |
| `current_belt_id` | FK → Faixa | obrigatório |
| `current_belt_since` | data | desde quando está na faixa atual (para a carência) |
| `stripes` | inteiro 0–4 | graus (tiras) na faixa atual; padrão 0 |
| `federation_id` | texto ≤ 30, opcional | registro na federação |
| `active` | booleano | padrão verdadeiro |

A **elegibilidade é calculada** (nunca gravada) — ver § 5.

### 3.4 Evento de exame (`ExamEvent`)
| Campo | Tipo | Regras |
|---|---|---|
| `name` | texto ≤ 80 | ex.: "Exame março/2027" |
| `exam_date` | data | a data de referência de idade e carência |
| `status` | enum `OPEN` / `CLOSED` | "Aberto" / "Encerrado"; padrão `OPEN` |

### 3.5 Exame do aluno (`Exam`) — nasce na confirmação de presença
| Campo | Tipo | Regras |
|---|---|---|
| `event_id` | FK → Evento | |
| `student_id` | FK → Aluno | **sem exclusão em cascata** (ver RN018) |
| `target_belt_id` | FK → Faixa | calculada na presença |
| `kind` | enum `STRIPE` / `BELT` | "Grau" / "Faixa"; calculado na presença |
| `status` | enum `IN_PROGRESS` / `APPROVED` / `FAILED` | "Em andamento" / "Aprovado" / "Reprovado" |
| `decided_by_id` | FK → Usuário, opcional | quem decidiu |
| `decided_at` | data-hora, opcional | |
| `notes` | texto, opcional | observação da decisão |

**Único por (evento, aluno).**

### 3.6 Resposta do item (`ExamAnswer`)
| Campo | Tipo | Regras |
|---|---|---|
| `exam_id` | FK → Exame | apagar o exame apaga as respostas |
| `requirement_id` | FK → Requisito | |
| `correct` | booleano | certo / errado |
| `marked_by_id` | FK → Usuário | quem marcou (manter a marcação se o usuário for removido) |

**Único por (exame, requisito).** Item sem registro = "não marcado".

### 3.7 Configurações da academia (registro único)
| Campo | Tipo | Regras |
|---|---|---|
| `academy_name` | texto ≤ 255 | aparece no topo do certificado |
| `sensei_user_id` | FK → Usuário, opcional | precisa ser **examinador**; único que decide; só o master escolhe/troca |
| `certificate_city` | texto ≤ 80, opcional | ex.: "Araraquara" |
| `logo_primary`, `logo_secondary` | imagem (binário + tipo) | PNG ou JPEG, ≤ 2 MB cada |
| assinaturas do certificado (até 3) | lista ordenada | cada uma: **nome**, **graduação** (texto livre, ex.: "Fundador, 6º Dan (in memoriam)"), **imagem** da assinatura (PNG ou JPEG, ≤ 2 MB) e **posição** no certificado; pode ser de pessoa sem login; ≥ 1 completa para emitir certificado |

Os antigos `sensei_display_name`, `sensei_title` e `signature` saem: o nome e a graduação no certificado vêm das assinaturas *(decisão do responsável, 2026-11-02)*.

As imagens **não** vão no JSON das configurações (saem por rota própria); quem pode lê-las
está na RN012.

---

## 4. Tabela de faixas (carga inicial)

Fonte: Regulamento para Exame e Outorga de Faixas e Graus da CBJ, 09/02/2011, art. 2º.
Valores **editáveis** na tela (a federação pode ter tabela mais nova — pendência § 12).

| Ordem | Faixa | Kyū | Nível | Idade mín. | Carência na anterior | Cor | Pontas |
|---|---|---|---|---|---|---|---|
| 0 | Branca | — | Básico | — | — | `#FFFFFF` | — |
| 1 | Branca/Cinza | 11 | Básico | 4 | 3 meses | `#FFFFFF` | `#9E9E9E` |
| 2 | Cinza | 10 | Básico | 5 | 3 meses | `#9E9E9E` | — |
| 3 | Cinza/Azul | 9 | Básico | 6 | 6 meses | `#9E9E9E` | `#1E63C6` |
| 4 | Azul | 8 | Básico | 7 | 6 meses | `#1E63C6` | — |
| 5 | Azul/Amarela | 7 | Básico | 8 | 6 meses | `#1E63C6` | `#F2C200` |
| 6 | Amarela | 6 | Básico | 9 | 6 meses | `#F2C200` | — |
| 7 | Amarela/Laranja | 5 | Básico | 10 | 12 meses | `#F2C200` | `#F07C00` |
| 8 | Laranja | 4 | Intermediário | 11 | 12 meses | `#F07C00` | — |
| 9 | Verde | 3 | Intermediário | 12 | 12 meses | `#2E8B3A` | — |
| 10 | Roxa | 2 | Intermediário | 13 | 12 meses | `#6B2FA0` | — |
| 11 | Marrom | 1 | Intermediário | 14 | 12 meses | `#6D4423` | — |

Nas faixas de duas cores, as pontas levam a cor da faixa seguinte (CBJ art. 2º §2º).

---

## 5. Regras de negócio

Cada regra deve ter **teste automatizado** nomeado pelo id (ex.: `test_rn001_...`).

### Elegibilidade (calculada na data de referência: a data do evento; sem evento, hoje)

- **RN001 — Idade mínima.** Idade em **anos completos** ≥ `min_age_years` da faixa-alvo.
  Vale para exame de **faixa**; o exame de grau não muda de faixa e não checa idade.
  Bloqueio: *"Idade mínima para a faixa {faixa}: {n} anos"*.
- **RN002 — Carência.** **Meses completos** entre `current_belt_since` e a data de
  referência ≥ `min_months_previous` da faixa-alvo; no **exame de grau**, ≥ **metade**
  (divisão inteira; 12 → 6). **Dispensada** para quem tem **16 anos completos ou mais**
  (CBJ art. 2º §4º). Bloqueio: *"Carência mínima de {n} meses na faixa atual (faltam {m})"*.
- **RN003 — Próxima faixa.** A faixa-alvo é a de `sort_order` imediatamente seguinte.
  Marrom não tem próxima: *"Faixa preta é exame da federação"*.
- **RN004 — Grau antes da faixa.** Se a faixa atual é **intermediária** (Laranja, Verde,
  Roxa) e `stripes = 0`, o exame é de **grau** (`STRIPE`), com os itens da faixa-alvo;
  aprovado, ganha 1 grau e continua na faixa. Com `stripes ≥ 1`, o exame é de **faixa**
  (`BELT`). Nas faixas básicas, sempre de faixa.

  Exemplos: Verde 0 graus → grau rumo à Roxa; Verde 1 grau → faixa Roxa;
  Amarela/Laranja → faixa Laranja (básica).

### Exame

- **RN005 — Confirmação de presença.** O examinador confirma a presença de aluno **ativo**
  e **elegível** (RN001–RN003) num evento **aberto**. Cria o exame com faixa-alvo e tipo
  calculados (RN003/RN004) e status "Em andamento". Inelegível → erro com o motivo.
  Repetido → *"Presença já confirmada neste evento"* (409, inclusive em corrida simultânea).
  **Um exame em andamento por vez** (decisão do responsável, 2026-11-02): se o aluno já
  tem um exame "Em andamento" em outro evento, a presença é recusada com *"O aluno já tem
  um exame em andamento em outro evento."* (409) e nada é gravado, inclusive em corrida
  simultânea. A decisão do sensei (aprovado ou reprovado) libera o aluno para outro evento.
  Enquanto o exame estiver em andamento, ninguém altera `current_belt_id`,
  `current_belt_since` ou `stripes` do aluno, nem examinador: *"Não é possível alterar a
  graduação com exame em andamento. Decida o exame primeiro."* (409), nada é gravado,
  inclusive se a presença for confirmada no meio da edição. Os outros campos continuam
  editáveis e reenviar a mesma graduação é aceito. Para o responsável a trava do RN013
  (403) tem precedência, porque vale também depois da decisão *(decisão do responsável,
  2026-11-02)*.
- **RN006 — Marcação.** Examinador marca cada item como certo/errado; marcar de novo
  **substitui** (correção antes da decisão); registra quem marcou. O item precisa ser da
  faixa-alvo (*"Item não pertence à faixa do exame"*). Bloqueado com exame decidido ou
  evento encerrado. Duas marcações simultâneas no mesmo item não podem gerar erro 500.
- **RN007 — Percentual de acertos.** Por tipo (teórico e prático, separados):
  `acertos ÷ total de itens do tipo na faixa-alvo × 100`, 1 casa decimal, exibido em pt-BR
  ("72,5%"). Item não marcado conta como não acertado. Mostrar junto "marcados X de N".
  Faixa sem itens de um tipo → percentual "—". **Sempre recalculado** (nunca gravado).
- **RN008 — Decisão do sensei.** Só o usuário configurado como sensei aprova/reprova,
  **independentemente do percentual** (o % é só apoio). Grava quem e quando.
  Outro usuário → *"Somente o sensei pode decidir o exame"* (403); sem sensei →
  *"Defina o sensei nas configurações da academia"*. O admin master **não** decide (a menos
  que seja ele o sensei). Só o master escolhe/troca o sensei; outro examinador que tente →
  *"Somente o administrador master escolhe o sensei"* (403) *(decisão do responsável, 2026-11-02)*.
- **RN009 — Efeito da aprovação.** Exame de **faixa** aprovado: aluno passa à faixa-alvo,
  `current_belt_since` = data do evento, `stripes` = 0. Exame de **grau** aprovado:
  `stripes` + 1, faixa mantida. Reprovado: nada muda.
- **RN008a — Evento encerrado.** Encerrar o evento bloqueia presença e marcação (RN016), mas
  o sensei **ainda pode decidir** os exames em andamento desse evento.
- **RN010 — Decisão final.** Decidido, não se alteram respostas nem a decisão
  (*"Exame já decidido"*).
- **RN011 — Certificado.** Só para exame **aprovado** (faixa **e** grau), em PDF (§ 7).
  Exige **pelo menos uma assinatura completa** (nome, graduação e imagem); sem ela →
  *"Cadastre ao menos uma assinatura completa nas configurações"* *(decisão do responsável, 2026-11-02)*.
  A faixa impressa **não pode depender do estado atual do aluno**: no grau, é a faixa
  imediatamente anterior à faixa-alvo; na faixa, é a faixa-alvo. (Reimprimir um
  certificado antigo deve sair igual, mesmo que o aluno tenha avançado depois.)

### Cadastros e configurações

- **RN012 — Imagens.** Logos e assinaturas: só PNG ou JPEG (validar a assinatura binária do
  arquivo, não só o content-type), até 2 MB (*"Envie PNG ou JPEG de até 2 MB"*). Logos:
  upload, remoção e leitura por examinadores. Assinaturas do certificado: criação, edição,
  remoção **e leitura** só pelo **master** e pelo **sensei** *(decisão do responsável, 2026-11-02)* — nunca por um
  responsável nem por outro examinador (risco de falsificação de certificado); o PDF é
  gerado no servidor.
- **RN013 — Posse e trava de graduação.** O responsável vê/edita só os próprios alunos;
  examinadores veem todos. Depois do **primeiro exame** do aluno, `current_belt_id`,
  `current_belt_since` e `stripes` só mudam por examinador (ou pelo exame) —
  *"Somente examinadores alteram a graduação após o primeiro exame"* (403). A trava
  compara com os **valores atuais**: reenviar o mesmo valor (o formulário sempre envia
  todos os campos) não pode bloquear a edição de nome ou registro.
- **RN014 — Datas.** Nascimento e "desde" não podem ser futuros; "desde" ≥ nascimento
  (*"Datas inválidas: verifique nascimento e data da faixa atual"*).
- **RN015 — Faixas.** Só examinador edita; nome e ordem únicos; idade e carência ≥ 0;
  cores `#RRGGBB`.
- **RN016 — Evento.** Só examinador gerencia. Encerrado bloqueia presença e marcação.
  Evento com exames não pode ser excluído (*"Evento possui exames registrados"*).
- **RN017 — Requisitos.** Só examinador gerencia; faixa precisa existir; listagem filtrável
  por faixa e tipo, ordenada (sem limite que corte a Marrom, que tem 139 itens).
- **RN018 — Histórico preservado.** Aluno **com exames** não pode ser excluído pelo
  responsável (*"Aluno possui exames registrados"*); o examinador pode inativá-lo.
  Nunca apagar exames em cascata ao excluir aluno (apagaria o histórico e contornaria a
  RN013).

---

## 6. Telas

Texto em caixa de frase (sem caixa alta decorativa), pt-BR, datas `dd/mm/aaaa`.
Funcionar **em notebook e em celular/tablet** na mesma rede (vários examinadores ao mesmo
tempo no sábado). Tema claro e escuro.

### 6.1 Login e cadastro
Login por e-mail/senha; "Cadastre-se" aberto (cria responsável).

### 6.2 Alunos (todos os perfis)
- Lista: nome, faixa atual (+ graus), idade, "na faixa desde", **próximo exame**
  ("Faixa Cinza/Azul" ou "Grau (rumo à Roxa)") e **situação** ("Elegível" ou
  "Bloqueado: {motivo}" em vermelho; "Inativo").
- Formulário: nome, **faixa atual (seletor)**, nascimento, "na faixa desde", graus (0–4),
  registro na federação, ativo.

### 6.3 Dia do exame (examinadores) — lista → ação
- Seletor do evento (padrão: o evento aberto mais recente); busca por nome; filtros com
  contagem: Todos · Elegíveis · Bloqueados · Presentes.
- Lista só os alunos **ativos**, em ordem alfabética, com a elegibilidade calculada na
  **data do evento** (não na data de hoje).
- Tabela: aluno, idade, faixa atual, próximo exame, situação, ação
  (**"Confirmar presença"** para elegível sem exame · **"Abrir exame"** para presente ·
  nada para bloqueado). No celular, lista de cartões.
- Estados: sem evento aberto ("Criar evento"), sem alunos, carregando, erro com "Tentar de
  novo", evento encerrado (sem ações).

### 6.4 Exame do aluno (examinadores) — inspeção → decisão
- Cabeçalho: navegação "Dia do exame / {aluno}", idade, "Faixa X" ou "Grau na faixa X
  (rumo à Y)", evento, selo do resultado; botões **anterior/próximo aluno presente**.
- Abas **Teórico** e **Prático** com "marcados/total"; opção "Só não marcados".
- Itens agrupados por categoria (com "x/N" por categoria); cada item mostra a descrição, a
  **resposta esperada** (texto secundário) e dois botões **Certo / Errado** (alvo de toque
  ≥ 44 px). Clicar salva **na hora** (atualização otimista; em erro, volta e avisa).
- **Resumo** (coluna fixa à direita no notebook; barra fixa no rodapé no celular, com botão
  "Decidir" que abre um painel): % teórico e % prático (grandes), barra de progresso de
  marcação, e:
  - sensei: **Aprovar** / **Reprovar**, sempre com confirmação ("Aprovar Ana para a faixa
    Cinza/Azul? A decisão não pode ser desfeita.");
  - outros: "A decisão é do sensei {nome}";
  - sem sensei: aviso com link para as configurações;
  - decidido: "Decidido por {nome}" e **"Baixar certificado"** (desabilitado com o motivo
    se não houver assinatura completa).
- Exame decidido ou evento encerrado: itens somente leitura, mostrando "Certo", "Errado" ou
  "Não marcado" em texto com ícone (não usar botões desabilitados — contraste ruim).
- Recarregar o exame ao voltar o foco na janela (dois examinadores no mesmo exame).

### 6.5 Faixas, Requisitos e Eventos (examinadores)
CRUDs simples. Faixas na ordem da graduação; eventos do mais recente para o mais antigo. Requisitos com filtro por faixa (padrão: Branca/Cinza) e por tipo.
Enums sempre como seletor com rótulo em pt-BR.

### 6.6 Academia (aba de templates, examinadores)
Nome da academia; **sensei** (seletor entre examinadores ativos; só o master altera);
cidade; dois espaços de imagem (**logo principal**, **logo secundário**) com prévia,
"Carregar/Trocar" e "Remover"; e a lista de **assinaturas do certificado** (até 3; nome,
graduação, imagem com prévia; ordem ajustável), visível e editável só pelo master e pelo
sensei *(decisão do responsável, 2026-11-02)*.

---

### 6.7 Acessibilidade e responsividade
- Larguras de referência: **1280 px** (lista e resumo lado a lado), **768 px** e **390 px**
  (celular, uma coluna); zoom de **200%** deve cair no layout estreito sem perder ações.
- Contraste mínimo 4,5:1 para texto e 3:1 para indicadores; estado nunca só por cor
  (bloqueado tem o texto "Bloqueado: …"; certo/errado têm ícone e texto).
- Teclado: todos os controles alcançáveis por Tab; `Esc` fecha diálogos e painéis.
- Os percentuais são anunciados a leitores de tela quando mudam (região "ao vivo").
- Os percentuais são **dado calculado**: uma dica no rótulo explica
  "acertos ÷ itens do tipo; item não marcado conta como não acertado".
- Sem instruções de uso na tela ("clique aqui…"); os rótulos dos controles bastam.
- Navegação no celular: o menu recolhe num botão (gaveta), sem esconder o usuário/sair.

## 7. Certificado (PDF, A4 paisagem, gerado no servidor)

Layout (de cima para baixo):

1. Moldura fina; logo principal no canto superior esquerdo e secundário no direito
   (opcionais, proporção preservada).
2. Nome da academia (pequeno, cinza).
3. Título **"Certificado de graduação"**.
4. Texto (neutro em gênero):
   - faixa: "Certificamos a aprovação de **{nome}** no exame de graduação de Judô,
     conferindo-lhe a faixa **{faixa}**."
   - grau: "…conferindo-lhe o **1º grau** na faixa **{faixa}**."
5. A faixa desenhada como **barra horizontal** na cor dela; nas faixas de duas cores, as
   pontas na cor secundária; contorno cinza (para a faixa branca aparecer).
6. "{cidade}, {data do exame por extenso}" — ex.: "Araraquara, 13 de março de 2027".
   Usar a **data do exame**, não a de emissão.
7. De 1 a 3 assinaturas lado a lado, na ordem configurada: cada uma com a imagem sobre
   uma linha e, abaixo, o nome e a graduação *(decisão do responsável, 2026-11-02)*.

Nome do arquivo: `certificado-{nome do aluno}.pdf`. A fonte do PDF precisa suportar
acentuação do português.

---

## 8. Requisitos não funcionais

- **Local:** roda numa máquina da academia, acessada pelo navegador na rede local. Nada é
  publicado na internet nesta fase.
- **Dados pessoais (LGPD):** guarda nome e data de nascimento de **crianças**; só
  examinadores veem todos os alunos; senhas com hash forte; sessão por cookie httpOnly ou
  equivalente.
- **Concorrência:** vários examinadores simultâneos; restrições de unicidade no banco e
  conflito tratado como 409, nunca 500.
- **Desempenho:** a lista do dia e a navegação entre exames não podem fazer consultas por
  aluno em laço (80 alunos).
- **Carga inicial idempotente:** faixas e requisitos carregados na primeira subida; rodar de
  novo não duplica nem sobrescreve edições feitas na tela.
- **Testes:** um teste de aceitação por regra (RN001–RN018) + fluxo ponta a ponta
  (cadastro → presença → marcação → aprovação → PDF).

---

## 9. Fluxo completo (critério de aceite da POC)

1. O master escolhe o sensei; um examinador configura o nome da academia, a cidade e os
   logos; o master ou o sensei cadastra ao menos uma assinatura do certificado (nome,
   graduação e imagem) *(decisão do responsável, 2026-11-02)*.
2. Examinador cria o evento "Exame março/2027" (13/03/2027).
3. Responsável cria conta e cadastra a aluna Ana (Cinza desde 14/03/2026, nascida em
   10/05/2018) e o aluno Bruno (Azul, 7 anos).
4. No Dia do exame: Ana aparece "Elegível" (próximo: faixa Cinza/Azul); Bruno aparece
   "Bloqueado: Idade mínima para a faixa Azul/Amarela: 8 anos" e não tem botão.
5. Examinador confirma a presença da Ana e marca os 24 itens (11 teóricos, 13 práticos).
6. O resumo mostra os dois percentuais; o sensei aprova com confirmação.
7. Ana passa a Cinza/Azul (desde 13/03/2027, 0 graus); o certificado PDF sai com os
   dados da § 7.

---

## 10. Decisões já tomadas pelo responsável

| Tema | Decisão |
|---|---|
| Modalidade | Só Judô agora; modelo preparado para outras |
| Conteúdo do exame | A **folha da academia** (Apêndice A), não o programa da CBJ (art. 5º), que difere em alguns itens |
| Idade/carência | Tabela da CBJ 2011 (§ 4), editável |
| Dispensa de carência | 16 anos **completos** |
| Grau | Quem já é Laranja, Verde ou Roxa passa por um exame de grau antes da faixa; carência do grau = metade |
| Certificado de grau | Sim, também gera certificado |
| Data no certificado | Data do exame (o pedido original dizia "data corrente"; trocado para a data do exame para que reimprimir não mude a data) |
| Aprovação | Card com % teórico e prático; **o sensei decide** |
| Cadastro | O próprio aluno/responsável se cadastra; um login pode ter vários alunos |
| Presença | Examinadores confirmam no dia |
| Inelegível | **Bloqueia** (não só avisa) |
| Aparelhos | Notebook e celular/tablet |
| Hospedagem | Tudo local |
| Admin master e assinaturas (2026-11-02) | Grupo **master** (o primeiro examinador; outros só pelo console): único que escolhe o sensei, **não** decide exames. Certificado com 1–3 assinaturas (nome, graduação, imagem, posição), geridas pelo master e pelo sensei; ≥ 1 completa para emitir |

---

## 11. Liberdade de implementação

Stack livre. Qualquer combinação que entregue: backend com API e banco relacional
(chaves únicas e FKs), frontend web responsivo, geração de PDF no servidor e testes
automatizados. Não há exigência de nuvem, CI ou identidade visual específica — a
identidade da academia aparece no certificado (logos carregados na aba Academia). (Na POC
o app usava o tema padrão do template da EvcomX por escolha do responsável; aqui isso não
se aplica.) Tema claro e escuro.

---

## 12. Pendências em aberto (não bloqueiam o início)

| Item | Ação | Prazo |
|---|---|---|
| Diferenças folha × CBJ | A folha da academia difere do programa da CBJ em alguns itens (ex.: a CBJ pede 1 Ossaewaza na Branca/Cinza, a folha não pede nenhum; a folha da Azul/Amarela não lista ukemi). Vale a folha; confirmar com o sensei se é intencional | 15/11/2026 |
| Conferir transcrição | "Kouti gari" aparece duas vezes na lista de Naguewaza da Amarela em diante (itens 12 e 15) — mantido como "(repetido na folha: conferir)"; Shimewaza 3–10 e Kansetsuwaza 3–8 da Marrom vieram de foto girada | 15/11/2026 |
| Regra do grau | Confirmar com o sensei a carência do grau (6 meses) | 15/11/2026 |
| Tabela da federação | Verificar se a FPJudô tem tabela de idade/carência mais nova que a CBJ 2011 | 15/11/2026 |
| Modelo do certificado | Ajustar o layout ao certificado atual feito no Canva | 15/11/2026 |
| Indicador de sucesso | Medir hoje: tempo de montagem dos ~80 certificados e duração do sábado; meta proposta: certificados prontos no mesmo dia | 15/11/2026 |
| Validação real | Rodar em paralelo com o papel no exame de março/2027 | 31/03/2027 |

---

## Apêndice A — Itens de exame por faixa

Transcrição das folhas de exame da Academia Tomiyama (PDF "Exame de faixa", Branca/Cinza a
Verde, e fotos das folhas Roxa e Marrom). O conteúdo é **cumulativo** (cada faixa repete a
anterior e acrescenta). Formato: `descrição → *resposta esperada*`. Classificação:
"Demonstrar…", golpes, ukemi, posturas (Shissei), kata, guarda e arbitragem são **práticos**;
vocabulário, histórico, princípios, ordem das faixas, formas da prática, classificação das
técnicas e Kodansha são **teóricos**. A Branca não tem exame (é a faixa inicial).

### 1. Branca/Cinza (11º kyū) — 6 itens (2 teóricos, 4 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Amortecimento de quedas (deitado) → *Ushirokemi e Yokoukemi*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*

### 2. Cinza (10º kyū) — 14 itens (5 teóricos, 9 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Amortecimento de quedas lateral (Yokoukemi) → *A partir da posição agachada, em pé e para frente com rolamento*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*

### 3. Cinza/Azul (9º kyū) — 24 itens (11 teóricos, 13 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar 3 tipos de ukemi (em movimento)

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*

### 4. Azul (8º kyū) — 34 itens (18 teóricos, 16 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar 3 tipos de ukemi (em movimento)

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*

### 5. Azul/Amarela (7º kyū) — 45 itens (26 teóricos, 19 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar tipos de postura (Shissei) → *Shizen-hontai, Miguishizentai, Hidarishizentai, Jigohontai, Miguijigotai, Hidarijigotai*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi
- Hiza guruma
- Seoi nague

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame
- Kami shiho gatame

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*
- Treinamento de entradas de técnicas → *Utikomi*
- Treino livre → *Randori*
- Competição → *Shiai*
- Academia → *Dojô*
- Local de competição → *Shiaijô*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*
- Nascimento do Shihan Jigoro Kano → *28 de outubro de 1860, província de Hiyogo, Japão*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*
- Princípio: “Conhecer-se…” → *Conhecer-se é dominar-se, dominar-se é triunfar*

**Teórico · Conhecimentos gerais**

- Saber a ordem das faixas no Judô → *Kyus (graus inferiores) — básicos: Branca, Branca/Cinza, Cinza, Cinza/Azul, Azul, Azul/Amarela, Amarela, Amarela/Laranja; intermediários: Laranja, Verde, Roxa e Marrom. Yudansha: faixas pretas do 1º ao 5º Dan. Kodansha: faixas vermelha e branca do 6º ao 8º Dan e faixas vermelhas do 9º ao 10º Dan*

### 6. Amarela (6º kyū) — 58 itens (29 teóricos, 29 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar tipos de postura (Shissei) → *Shizen-hontai, Miguishizentai, Hidarishizentai, Jigohontai, Miguijigotai, Hidarijigotai*
- Demonstrar 2 tipos de deslocamento sobre o tatame (Shintai) → *Passadas naturais (Ayumiashi) e passadas sucessivas (Tsuguiashi)*
- Executar defesa (Fussegui) → *Com as pernas em katamewaza e de técnicas em pé em tatiwaza*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi
- Hiza guruma
- Seoi nague
- Tai otoshi
- Kouti gari
- Ko soto gari
- Harai goshi

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame
- Kami shiho gatame
- Kata gatame

**Prático · Renrakuwaza**

- Deashi barai / Osoto gari
- Koshi guruma / Ouchi gari

**Prático · Kaeshiwaza**

- Osoto gari / Osoto otoshi

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*
- Treinamento de entradas de técnicas → *Utikomi*
- Treino livre → *Randori*
- Competição → *Shiai*
- Academia → *Dojô*
- Local de competição → *Shiaijô*
- Judoca ativo e judoca passivo → *Tori e Uke*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*
- Nascimento do Shihan Jigoro Kano → *28 de outubro de 1860, província de Hiyogo, Japão*
- A morte do Shihan Jigoro Kano → *04 de maio de 1938, a bordo de um navio que o levava de volta ao Japão, vindo do Cairo (Egito), onde participou da assembleia geral do Comitê Olímpico Internacional*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*
- Princípio: “Conhecer-se…” → *Conhecer-se é dominar-se, dominar-se é triunfar*
- Princípio: “O judoca não se aperfeiçoa…” → *O judoca não se aperfeiçoa para lutar, luta para se aperfeiçoar*

**Teórico · Conhecimentos gerais**

- Saber a ordem das faixas no Judô → *Kyus (graus inferiores) — básicos: Branca, Branca/Cinza, Cinza, Cinza/Azul, Azul, Azul/Amarela, Amarela, Amarela/Laranja; intermediários: Laranja, Verde, Roxa e Marrom. Yudansha: faixas pretas do 1º ao 5º Dan. Kodansha: faixas vermelha e branca do 6º ao 8º Dan e faixas vermelhas do 9º ao 10º Dan*

### 7. Amarela/Laranja (5º kyū) — 74 itens (33 teóricos, 41 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar tipos de postura (Shissei) → *Shizen-hontai, Miguishizentai, Hidarishizentai, Jigohontai, Miguijigotai, Hidarijigotai*
- Demonstrar 2 tipos de deslocamento sobre o tatame (Shintai) → *Passadas naturais (Ayumiashi) e passadas sucessivas (Tsuguiashi)*
- Executar defesa (Fussegui) → *Com as pernas em katamewaza e de técnicas em pé em tatiwaza*
- Demonstrar formas de movimentos rotatórios do corpo (esquiva) → *Taissabaki*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi
- Hiza guruma
- Seoi nague
- Tai otoshi
- Kouti gari
- Ko soto gari
- Harai goshi
- Kouti gari (repetido na folha: conferir)
- Tsuri komi goshi
- Okuri ashi barai
- Uti mata
- Tsuri goshi
- Hane goshi

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame
- Kami shiho gatame
- Kata gatame
- Makura kessa gatame

**Prático · Renrakuwaza**

- Deashi barai / Osoto gari
- Koshi guruma / Ouchi gari
- Osoto gari / Osoto otoshi
- Ouchi gari / Tai otoshi

**Prático · Kaeshiwaza**

- Osoto gari / Osoto otoshi
- Deashi barai / Tsubame gaeshi
- Koshi guruma / Utsuri goshi

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*
- Treinamento de entradas de técnicas → *Utikomi*
- Treino livre → *Randori*
- Competição → *Shiai*
- Academia → *Dojô*
- Local de competição → *Shiaijô*
- Judoca ativo e judoca passivo → *Tori e Uke*
- Significado da palavra Judô → *Caminho da suavidade: Ju significa suavidade, não resistência; Dô significa meio, caminho, doutrina*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*
- Nascimento do Shihan Jigoro Kano → *28 de outubro de 1860, província de Hiyogo, Japão*
- A morte do Shihan Jigoro Kano → *04 de maio de 1938, a bordo de um navio que o levava de volta ao Japão, vindo do Cairo (Egito), onde participou da assembleia geral do Comitê Olímpico Internacional*
- Realização do 1º Campeonato Brasileiro de Judô → *1954*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*
- Princípio: “Conhecer-se…” → *Conhecer-se é dominar-se, dominar-se é triunfar*
- Princípio: “O judoca não se aperfeiçoa…” → *O judoca não se aperfeiçoa para lutar, luta para se aperfeiçoar*
- Significado de Seiryokuzenjô → *Melhor uso da energia vital (princípio da máxima eficiência com o mínimo de esforço)*
- Significado de Jitakyôei → *Amizade e prosperidade mútua (princípio da prosperidade e benefícios mútuos)*

**Teórico · Conhecimentos gerais**

- Saber a ordem das faixas no Judô → *Kyus (graus inferiores) — básicos: Branca, Branca/Cinza, Cinza, Cinza/Azul, Azul, Azul/Amarela, Amarela, Amarela/Laranja; intermediários: Laranja, Verde, Roxa e Marrom. Yudansha: faixas pretas do 1º ao 5º Dan. Kodansha: faixas vermelha e branca do 6º ao 8º Dan e faixas vermelhas do 9º ao 10º Dan*

### 8. Laranja (4º kyū) — 83 itens (35 teóricos, 48 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar tipos de postura (Shissei) → *Shizen-hontai, Miguishizentai, Hidarishizentai, Jigohontai, Miguijigotai, Hidarijigotai*
- Demonstrar 2 tipos de deslocamento sobre o tatame (Shintai) → *Passadas naturais (Ayumiashi) e passadas sucessivas (Tsuguiashi)*
- Executar defesa (Fussegui) → *Com as pernas em katamewaza e de técnicas em pé em tatiwaza*
- Demonstrar formas de movimentos rotatórios do corpo (esquiva) → *Taissabaki*
- Demonstrar as fases necessárias para a aplicação de uma técnica → *Desequilíbrio (Kuzushi, oito tipos), preparação (Tsukuri) e execução (Kake)*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi
- Hiza guruma
- Seoi nague
- Tai otoshi
- Kouti gari
- Ko soto gari
- Harai goshi
- Kouti gari (repetido na folha: conferir)
- Tsuri komi goshi
- Okuri ashi barai
- Uti mata
- Tsuri goshi
- Hane goshi
- Ashi guruma
- Tomoe nague
- Ko soto gake

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame
- Kami shiho gatame
- Kata gatame
- Makura kessa gatame
- Ushiro kessa gatame

**Prático · Renrakuwaza**

- Deashi barai / Osoto gari
- Koshi guruma / Ouchi gari
- Osoto gari / Osoto otoshi
- Ouchi gari / Tai otoshi
- Ippon seoi nague / Kouti makikomi

**Prático · Kaeshiwaza**

- Osoto gari / Osoto otoshi
- Deashi barai / Tsubame gaeshi
- Koshi guruma / Utsuri goshi
- Ippon seoi nague / Tani otoshi

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*
- Treinamento de entradas de técnicas → *Utikomi*
- Treino livre → *Randori*
- Competição → *Shiai*
- Academia → *Dojô*
- Local de competição → *Shiaijô*
- Judoca ativo e judoca passivo → *Tori e Uke*
- Significado da palavra Judô → *Caminho da suavidade: Ju significa suavidade, não resistência; Dô significa meio, caminho, doutrina*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*
- Nascimento do Shihan Jigoro Kano → *28 de outubro de 1860, província de Hiyogo, Japão*
- A morte do Shihan Jigoro Kano → *04 de maio de 1938, a bordo de um navio que o levava de volta ao Japão, vindo do Cairo (Egito), onde participou da assembleia geral do Comitê Olímpico Internacional*
- Realização do 1º Campeonato Brasileiro de Judô → *1954*
- Inclusão do Judô nos Jogos Olímpicos → *Tóquio 1964, em caráter não oficial; oficialmente em Munique 1972*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*
- Princípio: “Conhecer-se…” → *Conhecer-se é dominar-se, dominar-se é triunfar*
- Princípio: “O judoca não se aperfeiçoa…” → *O judoca não se aperfeiçoa para lutar, luta para se aperfeiçoar*
- Significado de Seiryokuzenjô → *Melhor uso da energia vital (princípio da máxima eficiência com o mínimo de esforço)*
- Significado de Jitakyôei → *Amizade e prosperidade mútua (princípio da prosperidade e benefícios mútuos)*
- Princípio: “Somente se aproxima da perfeição…” → *Somente se aproxima da perfeição quem a procura com constância, sabedoria e, sobretudo, humildade*

**Teórico · Conhecimentos gerais**

- Saber a ordem das faixas no Judô → *Kyus (graus inferiores) — básicos: Branca, Branca/Cinza, Cinza, Cinza/Azul, Azul, Azul/Amarela, Amarela, Amarela/Laranja; intermediários: Laranja, Verde, Roxa e Marrom. Yudansha: faixas pretas do 1º ao 5º Dan. Kodansha: faixas vermelha e branca do 6º ao 8º Dan e faixas vermelhas do 9º ao 10º Dan*

### 9. Verde (3º kyū) — 99 itens (39 teóricos, 60 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar tipos de postura (Shissei) → *Shizen-hontai, Miguishizentai, Hidarishizentai, Jigohontai, Miguijigotai, Hidarijigotai*
- Demonstrar 2 tipos de deslocamento sobre o tatame (Shintai) → *Passadas naturais (Ayumiashi) e passadas sucessivas (Tsuguiashi)*
- Executar defesa (Fussegui) → *Com as pernas em katamewaza e de técnicas em pé em tatiwaza*
- Demonstrar formas de movimentos rotatórios do corpo (esquiva) → *Taissabaki*
- Demonstrar as fases necessárias para a aplicação de uma técnica → *Desequilíbrio (Kuzushi, oito tipos), preparação (Tsukuri) e execução (Kake)*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi
- Hiza guruma
- Seoi nague
- Tai otoshi
- Kouti gari
- Ko soto gari
- Harai goshi
- Kouti gari (repetido na folha: conferir)
- Tsuri komi goshi
- Okuri ashi barai
- Uti mata
- Tsuri goshi
- Hane goshi
- Ashi guruma
- Tomoe nague
- Ko soto gake
- Harai tsuri komi ashi
- Kata guruma
- Yoko otoshi
- Tani otoshi
- Sukui nague
- O guruma
- Sumi gaeshi

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame
- Kami shiho gatame
- Kata gatame
- Makura kessa gatame
- Ushiro kessa gatame
- Kuzure kessa gatame

**Prático · Renrakuwaza**

- Deashi barai / Osoto gari
- Koshi guruma / Ouchi gari
- Osoto gari / Osoto otoshi
- Ouchi gari / Tai otoshi
- Ippon seoi nague / Kouti makikomi
- Kouti gari / Ouchi gari

**Prático · Kaeshiwaza**

- Osoto gari / Osoto otoshi
- Deashi barai / Tsubame gaeshi
- Koshi guruma / Utsuri goshi
- Ippon seoi nague / Tani otoshi
- Uti mata / Sukashi nague

**Prático · Nague no Kata**

- Demonstrar o grupo de Tewaza do Nague no Kata

**Prático · Katamewaza**

- Demonstrar uma passagem de guarda de pernas em Katamewaza

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*
- Treinamento de entradas de técnicas → *Utikomi*
- Treino livre → *Randori*
- Competição → *Shiai*
- Academia → *Dojô*
- Local de competição → *Shiaijô*
- Judoca ativo e judoca passivo → *Tori e Uke*
- Significado da palavra Judô → *Caminho da suavidade: Ju significa suavidade, não resistência; Dô significa meio, caminho, doutrina*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*
- Nascimento do Shihan Jigoro Kano → *28 de outubro de 1860, província de Hiyogo, Japão*
- A morte do Shihan Jigoro Kano → *04 de maio de 1938, a bordo de um navio que o levava de volta ao Japão, vindo do Cairo (Egito), onde participou da assembleia geral do Comitê Olímpico Internacional*
- Realização do 1º Campeonato Brasileiro de Judô → *1954*
- Inclusão do Judô nos Jogos Olímpicos → *Tóquio 1964, em caráter não oficial; oficialmente em Munique 1972*
- Realização do 1º Campeonato Mundial → *1956, no Japão*
- Campeonatos Mundiais realizados no Brasil → *1965 e 2007, ambos no Rio de Janeiro*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*
- Princípio: “Conhecer-se…” → *Conhecer-se é dominar-se, dominar-se é triunfar*
- Princípio: “O judoca não se aperfeiçoa…” → *O judoca não se aperfeiçoa para lutar, luta para se aperfeiçoar*
- Significado de Seiryokuzenjô → *Melhor uso da energia vital (princípio da máxima eficiência com o mínimo de esforço)*
- Significado de Jitakyôei → *Amizade e prosperidade mútua (princípio da prosperidade e benefícios mútuos)*
- Princípio: “Somente se aproxima da perfeição…” → *Somente se aproxima da perfeição quem a procura com constância, sabedoria e, sobretudo, humildade*
- Princípio: “A única vitória que perdura…” → *A única vitória que perdura é a conquista sobre a própria ignorância*

**Teórico · Conhecimentos gerais**

- Formas da prática do Judô → *São 3 formas fundamentais: Randori (treino livre), Kata (forma) e Shiai (competição)*
- Saber a ordem das faixas no Judô → *Kyus (graus inferiores) — básicos: Branca, Branca/Cinza, Cinza, Cinza/Azul, Azul, Azul/Amarela, Amarela, Amarela/Laranja; intermediários: Laranja, Verde, Roxa e Marrom. Yudansha: faixas pretas do 1º ao 5º Dan. Kodansha: faixas vermelha e branca do 6º ao 8º Dan e faixas vermelhas do 9º ao 10º Dan*

### 10. Roxa (2º kyū) — 116 itens (41 teóricos, 75 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar tipos de postura (Shissei) → *Shizen-hontai, Miguishizentai, Hidarishizentai, Jigohontai, Miguijigotai, Hidarijigotai*
- Demonstrar 2 tipos de deslocamento sobre o tatame (Shintai) → *Passadas naturais (Ayumiashi) e passadas sucessivas (Tsuguiashi)*
- Executar defesa (Fussegui) → *Com as pernas em katamewaza e de técnicas em pé em tatiwaza*
- Demonstrar formas de movimentos rotatórios do corpo (esquiva) → *Taissabaki*
- Demonstrar as fases necessárias para a aplicação de uma técnica → *Desequilíbrio (Kuzushi, oito tipos), preparação (Tsukuri) e execução (Kake)*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi
- Hiza guruma
- Seoi nague
- Tai otoshi
- Kouti gari
- Ko soto gari
- Harai goshi
- Kouti gari (repetido na folha: conferir)
- Tsuri komi goshi
- Okuri ashi barai
- Uti mata
- Tsuri goshi
- Hane goshi
- Ashi guruma
- Tomoe nague
- Ko soto gake
- Harai tsuri komi ashi
- Kata guruma
- Yoko otoshi
- Tani otoshi
- Sukui nague
- O guruma
- Sumi gaeshi
- Hane makikomi
- Utsuri goshi
- Soto makikomi
- Uki otoshi
- Osoto guruma
- Yoko wakare
- Sumi otoshi
- Yoko gake

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame
- Kami shiho gatame
- Kata gatame
- Makura kessa gatame
- Ushiro kessa gatame
- Kuzure kessa gatame
- Kuzure yoko shiho gatame

**Prático · Renrakuwaza**

- Deashi barai / Osoto gari
- Koshi guruma / Ouchi gari
- Osoto gari / Osoto otoshi
- Ouchi gari / Tai otoshi
- Ippon seoi nague / Kouti makikomi
- Kouti gari / Ouchi gari
- Uti mata / Kouti gari

**Prático · Kaeshiwaza**

- Osoto gari / Osoto otoshi
- Deashi barai / Tsubame gaeshi
- Koshi guruma / Utsuri goshi
- Ippon seoi nague / Tani otoshi
- Uti mata / Sukashi nague
- Ouchi gari / Ouchi gaeshi

**Prático · Shimewaza**

- Nami juji jime
- Okuri eri jime

**Prático · Kansetsuwaza**

- Ude garami
- Ude gatame

**Prático · Nague no Kata**

- Demonstrar os grupos de Tewaza e Koshiwaza do Nague no Kata

**Prático · Katamewaza**

- Demonstrar duas passagens de guarda de pernas em Katamewaza

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*
- Treinamento de entradas de técnicas → *Utikomi*
- Treino livre → *Randori*
- Competição → *Shiai*
- Academia → *Dojô*
- Local de competição → *Shiaijô*
- Judoca ativo e judoca passivo → *Tori e Uke*
- Significado da palavra Judô → *Caminho da suavidade: Ju significa suavidade, não resistência; Dô significa meio, caminho, doutrina*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*
- Nascimento do Shihan Jigoro Kano → *28 de outubro de 1860, província de Hiyogo, Japão*
- A morte do Shihan Jigoro Kano → *04 de maio de 1938, a bordo de um navio que o levava de volta ao Japão, vindo do Cairo (Egito), onde participou da assembleia geral do Comitê Olímpico Internacional*
- Realização do 1º Campeonato Brasileiro de Judô → *1954*
- Inclusão do Judô nos Jogos Olímpicos → *Tóquio 1964, em caráter não oficial; oficialmente em Munique 1972*
- Realização do 1º Campeonato Mundial → *1956, no Japão*
- Campeonatos Mundiais realizados no Brasil → *1965 e 2007, ambos no Rio de Janeiro*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*
- Princípio: “Conhecer-se…” → *Conhecer-se é dominar-se, dominar-se é triunfar*
- Princípio: “O judoca não se aperfeiçoa…” → *O judoca não se aperfeiçoa para lutar, luta para se aperfeiçoar*
- Significado de Seiryokuzenjô → *Melhor uso da energia vital (princípio da máxima eficiência com o mínimo de esforço)*
- Significado de Jitakyôei → *Amizade e prosperidade mútua (princípio da prosperidade e benefícios mútuos)*
- Princípio: “Somente se aproxima da perfeição…” → *Somente se aproxima da perfeição quem a procura com constância, sabedoria e, sobretudo, humildade*
- Princípio: “A única vitória que perdura…” → *A única vitória que perdura é a conquista sobre a própria ignorância*
- Princípio: “Nunca te orgulhes…” → *Nunca te orgulhes de haver vencido um adversário; ao que venceste hoje, poderá vencer-te amanhã*

**Teórico · Conhecimentos gerais**

- Formas da prática do Judô → *São 3 formas fundamentais: Randori (treino livre), Kata (forma) e Shiai (competição)*
- Classificação das técnicas de Judô → *1) Projeção (Naguewaza): em pé (Tatiwaza) — braço (Tewaza), quadril (Koshiwaza), pé ou perna (Ashiwaza); de pé para deitado (Sutemiwaza) — na linha do corpo (Masutemiwaza), lateral (Yokosutemiwaza). 2) Controle e domínio no solo (Katamewaza): imobilização (Ossaewaza), estrangulamento (Shimewaza), chave de braço (Kansetsuwaza), ataque aos pontos vitais (Atemiwaza)*
- Saber a ordem das faixas no Judô → *Kyus (graus inferiores) — básicos: Branca, Branca/Cinza, Cinza, Cinza/Azul, Azul, Azul/Amarela, Amarela, Amarela/Laranja; intermediários: Laranja, Verde, Roxa e Marrom. Yudansha: faixas pretas do 1º ao 5º Dan. Kodansha: faixas vermelha e branca do 6º ao 8º Dan e faixas vermelhas do 9º ao 10º Dan*

### 11. Marrom (1º kyū) — 139 itens (42 teóricos, 97 práticos)

**Prático · Fundamentos**

- Demonstrar saudação em pé → *Ritsurei*
- Demonstrar saudação ajoelhado → *Zarei*
- Demonstrar formas de pegar no kimono → *Kumikata*
- Demonstrar formas de desequilíbrio → *Kuzushi*
- Demonstrar tipos de postura (Shissei) → *Shizen-hontai, Miguishizentai, Hidarishizentai, Jigohontai, Miguijigotai, Hidarijigotai*
- Demonstrar 2 tipos de deslocamento sobre o tatame (Shintai) → *Passadas naturais (Ayumiashi) e passadas sucessivas (Tsuguiashi)*
- Executar defesa (Fussegui) → *Com as pernas em katamewaza e de técnicas em pé em tatiwaza*
- Demonstrar formas de movimentos rotatórios do corpo (esquiva) → *Taissabaki*
- Demonstrar as fases necessárias para a aplicação de uma técnica → *Desequilíbrio (Kuzushi, oito tipos), preparação (Tsukuri) e execução (Kake)*

**Prático · Naguewaza**

- Deashi barai
- Osoto gari
- Ogoshi
- Ippon seoi nague
- Koshi guruma
- Ouchi gari
- Sassae tsuri komi ashi
- Uki goshi
- Hiza guruma
- Seoi nague
- Tai otoshi
- Kouti gari
- Ko soto gari
- Harai goshi
- Kouti gari (repetido na folha: conferir)
- Tsuri komi goshi
- Okuri ashi barai
- Uti mata
- Tsuri goshi
- Hane goshi
- Ashi guruma
- Tomoe nague
- Ko soto gake
- Harai tsuri komi ashi
- Kata guruma
- Yoko otoshi
- Tani otoshi
- Sukui nague
- O guruma
- Sumi gaeshi
- Hane makikomi
- Utsuri goshi
- Soto makikomi
- Uki otoshi
- Osoto guruma
- Yoko wakare
- Sumi otoshi
- Yoko gake
- Uki waza
- Yoko guruma
- Ushiro goshi
- Ura nague

**Prático · Ossaewaza**

- Hon kessa gatame
- Yoko kessa gatame
- Tate shiho gatame
- Kami shiho gatame
- Kata gatame
- Makura kessa gatame
- Ushiro kessa gatame
- Kuzure kessa gatame
- Kuzure yoko shiho gatame
- Kuzure kami shiho gatame

**Prático · Renrakuwaza**

- Deashi barai / Osoto gari
- Koshi guruma / Ouchi gari
- Osoto gari / Osoto otoshi
- Ouchi gari / Tai otoshi
- Ippon seoi nague / Kouti makikomi
- Kouti gari / Ouchi gari
- Uti mata / Kouti gari
- Harai goshi / Harai makikomi

**Prático · Kaeshiwaza**

- Osoto gari / Osoto otoshi
- Deashi barai / Tsubame gaeshi
- Koshi guruma / Utsuri goshi
- Ippon seoi nague / Tani otoshi
- Uti mata / Sukashi nague
- Ouchi gari / Ouchi gaeshi
- Sassae tsuri komi ashi / Ko soto gake

**Prático · Shimewaza**

- Nami juji jime
- Okuri eri jime
- Kata juji jime
- Guiaku juji jime
- Kataha jime
- Jigoku jime
- Hadaka jime
- Sode guruma jime
- Niguiri jime
- Sankaku jime

**Prático · Kansetsuwaza**

- Ude garami
- Ude gatame
- Waki gatame
- Juji gatame
- Hiza gatame
- Hara gatame
- Ashi gatame
- Sankaku gatame

**Prático · Nague no Kata**

- Demonstrar os grupos de Tewaza, Koshiwaza e Ashiwaza do Nague no Kata

**Prático · Katamewaza**

- Demonstrar duas passagens de guarda de pernas em Katamewaza e defesa com finalização

**Prático · Arbitragem**

- Demonstrar noções básicas de arbitragem → *Voz de comando, gestos e avaliação*

**Teórico · Vocabulário**

- Professor → *Sensei*
- Contar até 10 em japonês → *iti, ni, san, shi, go, roku, shiti, rati, kyu, jú*
- Peças que compõem o local de treino ou competição → *Tatame*
- Uniforme do praticante do Judô → *Judogui*
- Parar → *Mate*
- Começar → *Hajime*
- Terminar → *Soremade*
- Não se mova → *Sonomama*
- Atenção ou posição de sentido → *Kiotsuke*
- Calça → *Shitabaki*
- Casaco → *Uwagui*
- Faixa → *Obi*
- Chinelo → *Surippa*
- Treinamento de entradas de técnicas → *Utikomi*
- Treino livre → *Randori*
- Competição → *Shiai*
- Academia → *Dojô*
- Local de competição → *Shiaijô*
- Judoca ativo e judoca passivo → *Tori e Uke*
- Significado da palavra Judô → *Caminho da suavidade: Ju significa suavidade, não resistência; Dô significa meio, caminho, doutrina*

**Teórico · Histórico**

- Nome do fundador do Judô → *Jigoro Kano*
- Nome da primeira escola de Judô → *Kodokan*
- Data da fundação do Kodokan → *Maio de 1882*
- A arte que deu origem ao Judô → *Jujutsu, a arte da maleabilidade espiritual*
- Nascimento do Shihan Jigoro Kano → *28 de outubro de 1860, província de Hiyogo, Japão*
- A morte do Shihan Jigoro Kano → *04 de maio de 1938, a bordo de um navio que o levava de volta ao Japão, vindo do Cairo (Egito), onde participou da assembleia geral do Comitê Olímpico Internacional*
- Realização do 1º Campeonato Brasileiro de Judô → *1954*
- Inclusão do Judô nos Jogos Olímpicos → *Tóquio 1964, em caráter não oficial; oficialmente em Munique 1972*
- Realização do 1º Campeonato Mundial → *1956, no Japão*
- Campeonatos Mundiais realizados no Brasil → *1965 e 2007, ambos no Rio de Janeiro*

**Teórico · Princípios do Judô**

- Princípio: “Quem teme perder…” → *Quem teme perder já está vencido*
- Princípio: “Conhecer-se…” → *Conhecer-se é dominar-se, dominar-se é triunfar*
- Princípio: “O judoca não se aperfeiçoa…” → *O judoca não se aperfeiçoa para lutar, luta para se aperfeiçoar*
- Significado de Seiryokuzenjô → *Melhor uso da energia vital (princípio da máxima eficiência com o mínimo de esforço)*
- Significado de Jitakyôei → *Amizade e prosperidade mútua (princípio da prosperidade e benefícios mútuos)*
- Princípio: “Somente se aproxima da perfeição…” → *Somente se aproxima da perfeição quem a procura com constância, sabedoria e, sobretudo, humildade*
- Princípio: “A única vitória que perdura…” → *A única vitória que perdura é a conquista sobre a própria ignorância*
- Princípio: “Nunca te orgulhes…” → *Nunca te orgulhes de haver vencido um adversário; ao que venceste hoje, poderá vencer-te amanhã*

**Teórico · Conhecimentos gerais**

- Formas da prática do Judô → *São 3 formas fundamentais: Randori (treino livre), Kata (forma) e Shiai (competição)*
- Classificação das técnicas de Judô → *1) Projeção (Naguewaza): em pé (Tatiwaza) — braço (Tewaza), quadril (Koshiwaza), pé ou perna (Ashiwaza); de pé para deitado (Sutemiwaza) — na linha do corpo (Masutemiwaza), lateral (Yokosutemiwaza). 2) Controle e domínio no solo (Katamewaza): imobilização (Ossaewaza), estrangulamento (Shimewaza), chave de braço (Kansetsuwaza), ataque aos pontos vitais (Atemiwaza)*
- Saber a ordem das faixas no Judô → *Kyus (graus inferiores) — básicos: Branca, Branca/Cinza, Cinza, Cinza/Azul, Azul, Azul/Amarela, Amarela, Amarela/Laranja; intermediários: Laranja, Verde, Roxa e Marrom. Yudansha: faixas pretas do 1º ao 5º Dan. Kodansha: faixas vermelha e branca do 6º ao 8º Dan e faixas vermelhas do 9º ao 10º Dan*
- Conceito da palavra Kodansha → *Título de alta graduação, específico do Judô, criado pelo Instituto Kodokan, outorgado a quem se empenhou no aprendizado, na prática contínua, na eficiência técnica em competição e na dedicação ao ensino, ao estudo e à pesquisa; é depositário e responsável pela difusão dos princípios do Judô preconizados pelo Shihan Jigoro Kano*
