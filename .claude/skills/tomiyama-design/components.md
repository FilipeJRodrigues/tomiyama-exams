# Componentes

As cores citadas aqui estão em [colors.md](colors.md); a fonte, em [typography.md](typography.md).

## Base comum (Área de exames e landing page)

### Botões

- **Formato:** pílula (raio total; no Mantine, `radius="xl"` como padrão do `Button` e do `ActionIcon` pelo `extend` do tema). Texto em **negrito** (700).
- **Variantes:**
  - **principal:** `filled` na cor principal (azul no claro, amarelo com texto azul no escuro). Uma ação principal por área da tela; a exceção é a decisão do exame (veja "Decisão").
  - **secundária:** `default` ou `outline`. O botão `default` tem o fundo `--mantine-color-default` (branco no claro, `dark.6` no escuro, igual ao cartão e ao cabeçalho) e uma borda padrão fraca (`gray.4` 1,49:1; `dark.4` 1,43:1). Dê a ele a **borda de controle** (`#737B83` / `#8F8F8F`, veja `colors.md`), medida em todas as superfícies onde há botões `default`: cartão, fundo, linha de tabela em hover ("Editar", "Abrir exame") e alerta vermelho ("Tentar de novo", "Reler a faixa"). Aplique pelo `Button.extend` **e** pelo `ActionIcon.extend` (o botão Tema é um `ActionIcon`), sem mudar a `--mantine-color-default-border` global.
  - **perigo:** `filled` vermelho no botão do diálogo que confirma algo que não se desfaz (por exemplo, o "Excluir" da confirmação); `light` ou `outline` vermelho no botão que só abre a confirmação (o "Excluir" da lista). A decisão do exame é exceção (veja "Decisão").
  - **suave:** `light` ou `subtle`, para ações de apoio.
- **Tamanho:** os botões Certo/Errado têm alvo ≥ 44 px (§ 6.4). No celular, prefira 44 px também nos outros botões de ação (card #149).
- **Desabilitado:**
  - **nunca para mostrar o estado de algo somente leitura** (contraste ruim, § 6.4): as marcações de um exame decidido ou de um evento encerrado aparecem como texto com ícone ("Certo", "Errado", "Não marcado"), não como Certo/Errado desabilitados;
  - **aceito** quando a ação está momentaneamente ou logicamente indisponível:
    - **durante um envio:** o botão que envia mostra o carregamento (`loading`) e os outros controles do formulário ou do diálogo ficam desabilitados até a resposta, como hoje;
    - **ação indisponível com o motivo escrito ao lado**, legível (≥ 4,5:1): "Baixar certificado" sem assinatura completa (§ 6.4), o botão que confirma a decisão enquanto as marcações ainda salvam;
    - **navegação nas pontas:** "Anterior" no primeiro aluno presente e "Próximo" no último, como hoje;
    - **campo que só outro perfil altera**, com o motivo escrito e o valor legível (≥ 4,5:1): o seletor de sensei da Academia para quem não é master (§ 6.6), como hoje (`READ_ONLY_SELECT_STYLES` em `AcademyForm.tsx`).
  - **campo de texto somente leitura:** prefira `readOnly` a `disabled` (o valor fica legível e focável), como a data no formulário de evento (`EventForm.tsx`).

### Selos, seletores, campos e cartões

- **Selos (`Badge`):** pílula, caixa de frase, cor pelo significado (sucesso, erro, aviso, neutro), sempre com texto.
- **Seletores segmentados (`SegmentedControl`):** pílula, caixa de frase, **neutros**, com o **item escolhido bem visível**: o indicador padrão do Mantine dá só 1,11:1 contra o trilho no claro e 1,47:1 no escuro, e o rótulo escolhido só muda de cor (o filtro do Dia do exame está assim hoje, abaixo do § 6.7).
  - **claro:** indicador `gray.7` com texto branco em negrito (7,35:1 contra o trilho `gray.1`; texto 8,18:1);
  - **escuro:** indicador por volta de `#C9C9C9` com texto `#1C1C1C` em negrito (≥ 9,9:1 contra o trilho `dark.8`, que fica ainda mais escuro com a paleta ajustada; texto 10,29:1).
  - **foco:** o anel com `outline-offset` de 2 px, para não colar no indicador do item escolhido (contra o indicador, o anel daria 1,76:1 no claro e 1,35:1 no escuro; contra o trilho, passa com folga).

  Se um dia levarem a cor principal, defina a cor do texto do item escolhido explicitamente (veja `colors.md`: ele não trata cor virtual).
- **Cartões** (`Paper`, `Card`), **diálogos** (`Modal`), **gavetas** (`Drawer`) e **painéis:** raio **`lg`** (16 px), os blocos grandes e arredondados das referências. No escuro, todos em `#2A2A2A`: só o `Card` e o `Popover` pegam isso da paleta; os outros precisam do fundo definido no tema (veja `colors.md`).
- **Campos** (`TextInput`, `NativeSelect`, `Textarea`, `PasswordInput`...): raio **`md`**, como hoje. Uma caixa de texto em pílula ou muito arredondada fica estranha.
- **Bordas e foco:** os de `a11y.css`, refeitos com a paleta nova: a borda de controle vira uma variável só (por exemplo, `--app-control-border`, que substitui a `--app-input-border`), usada por todos os controles da tabela de `colors.md` (inclusive a seta dos seletores, que o Mantine pinta no tom do placeholder, 2,61:1 no escuro) e no inline de `MarkButtons`, sem hex solto; `--app-focus-ring` vem da cor real de cada tema (veja `colors.md`).

### Links

- **Sempre sublinhados** (`underline="always"`, como padrão pelo `Anchor.extend`), na cor principal: sem o sublinhado, o link no meio de uma frase só se distingue do texto pela cor (azul sobre o texto preto dá 1,46:1; amarelo sobre o texto claro, 1,35:1), o que fere "estado nunca só por cor" (§ 6.7). Vale para todo `Anchor`: "Cadastre-se", "Entrar", "Trocar e-mail", o "Dia do exame" da trilha do exame do aluno, o nome do aluno nas listas. Alguns já estão assim hoje (`underline="always"` nas telas de entrada).
- **Não vale para o menu lateral** (`NavLink`), que tem a barra e o negrito do item ativo.

### Caixas de seleção, rádios e interruptores

- **Desmarcados:** borda do `Checkbox` e do `Radio` e trilho do `Switch` desligado na **borda de controle** (`#737B83` no claro, 4,29:1 sobre branco; `#8F8F8F` no escuro, 4,44:1 sobre o cartão). O polegar do `Switch` desligado continua branco (4,29:1 e 3,23:1 contra esses trilhos). Os padrões do Mantine ficam abaixo (`gray.4` 1,49:1, `gray.3` 1,30:1, `dark.4` 1,43:1); hoje "Ativo", "Só não marcados" e "Perfil simulado" estão assim (card #173).
- **Marcados, no escuro:** a cor principal (amarelo) com o ícone, o ponto ou o polegar em azul (veja `colors.md`). O polegar do `Switch` desligado continua claro.

### Abas (`Tabs`)

Linha do ativo na cor principal (azul 14,43:1 sobre branco; amarelo 11,73:1 sobre o cartão) e rótulo ativo em negrito, para não depender só da cor.

### Ícones

Tabler (`@tabler/icons-react`), tamanho 18 a 20 nos controles. Ícone decorativo leva `aria-hidden`; o texto ao lado dá o nome.

### Áreas de marca (azul)

As telas de entrada usam o fundo azul `#0A265F` **nos dois temas**. Fora do cartão, sobre o azul:

- texto em **branco** (14,4:1) ou **amarelo** (11,8:1); texto secundário num azul bem claro, por volta de `#C5CEE6` (9,2:1);
- **anel de foco amarelo** (o azul do foco some ali);
- **nada vermelho** (2,8:1 sobre o azul): erro vai dentro do cartão;
- um selo que fique sobre o azul tem o contraste medido contra o azul, não contra o branco. Hoje o aviso "Dados simulados" das telas de entrada é um alerta dentro do cartão, não um selo sobre o azul.

## Área de exames

### Cabeçalho e menu lateral

O modelo é a moldura da POS TECH (veja o `SKILL.md`), em caixa de frase:

- **Fundo:** cabeçalho e menu lateral na cor de **superfície** (branco no claro, o cartão `#2A2A2A` no escuro), com uma borda sutil que os separa do conteúdo. O `AppShell` usa o fundo da página por padrão: defina o fundo do `AppShell.Header` e do `AppShell.Navbar` no tema. No celular, a gaveta do menu segue o mesmo visual.
- **Cabeçalho**, da esquerda para a direita:
  - botão do menu (só no celular);
  - **logo redondo** de uns 40 px, com texto alternativo "Academia Tomiyama" (veja [logo.md](logo.md));
  - **"Tomiyama"** em Barlow Condensed;
  - **"Área de exames"** menor, em texto secundário. Some abaixo do breakpoint `sm`, onde fica só "Tomiyama";
  - o selo **"Dados simulados"** (só com os dados de teste), logo depois, como hoje: some abaixo do `xs` e continua em caixa de frase.
- **Lado direito do cabeçalho:** o e-mail e os botões Tema (`ActionIcon`) e Sair (`Button`), variante `default`, com a borda de controle da regra de "secundária": o fundo deles é a cor do próprio cabeçalho.
- **Sem linha amarela** sob o cabeçalho: no tema claro ela ficaria quase invisível (1,22:1), e a marca já vem do logo e da cor principal.
- **Itens do menu:** ícone e texto na cor normal do texto. Hover num fundo diferente da superfície: `gray.0` no claro e por volta de `#3B3B3B` (`dark.5`) no escuro. O hover padrão do `NavLink` no escuro é `dark.6`, a mesma cor do menu, e não apareceria.
- **Item ativo:**
  - texto e ícone na **cor principal** e em **negrito**;
  - **sem fundo próprio**: em repouso, o fundo do menu; no hover, o mesmo hover dos outros itens. O `NavLink` ativo pinta por padrão o fundo `--nl-bg` (`--mantine-primary-color-light`) e o `--nl-hover`, e, conforme a escala do amarelo, o texto pode ficar abaixo de 4,5:1 nesses fundos. O ativo fica sobre a superfície (azul 14,4:1 no claro; amarelo 11,7:1 no escuro) e, no hover, sobre o mesmo hover dos outros itens (azul 13,7:1; amarelo 9,2:1);
  - uma **barra vertical** de 3 a 4 px na cor principal, na borda esquerda do item. Assim, o item ativo não depende só da cor: tem barra, negrito e o `aria-current="page"` do React Router.
- **Rodapé do menu** (e-mail e perfil): texto normal e texto secundário.
- **Título da aba do navegador:** "Área de exames · Tomiyama".

### Telas de entrada (login, cadastro, esqueci a senha)

Todas usam o `AuthCard`.

- **Fundo:** azul `#0A265F` na tela inteira, nos dois temas.
- **Acima do cartão, centralizados:**
  - o **logo** com **160 px**. Abaixo do breakpoint `sm` (celular de 390 px, zoom de 200%) e em telas baixas, ele cai para **96 px**, para o formulário continuar à vista sem rolar;
  - **"Tomiyama"** em Barlow Condensed branca;
  - **"Área de exames"** no texto secundário claro.

  Nenhum dos dois textos é título (`h1`): o `h1` é o título do cartão ("Entrar", "Criar conta"...).
- **Cartão:** branco no claro e `#2A2A2A` no escuro, raio `lg`, com borda visível. No escuro, o cartão carvão sobre o azul dá só 1,01:1, e é a borda que o separa do fundo: use a borda de controle do escuro, `#8F8F8F` (4,46:1 sobre o azul). A borda padrão do `Paper` (`dark.4`) dá 1,44:1 e não serve.
- **Botão principal:** na cor principal.
- O texto "Tomiyama Exams" que hoje está dentro do cartão sai.

### Selo de faixa

Ele substitui o `BeltSwatch` de `frontend/src/features/students/studentCells.tsx`. É uma **mini faixa**, sempre ao lado do nome da faixa escrito; ele é decorativo (`aria-hidden`).

- **Corpo:** na cor principal da faixa (`color_primary` da API).
- **Faixas de duas cores:** as **pontas** ficam na cor secundária (`color_secondary`), como no certificado (§ 7, item 5), com a **mesma proporção do `BeltDrawing`** da tela Faixas (`frontend/src/features/belts/BeltFixedData.tsx`): 18% da largura de cada lado. O ideal é os dois saírem do mesmo código. A faixa de uma cor só não tem pontas.
- **Contorno:** 1 px na cor do texto secundário (`var(--mantine-color-dimmed)`), como o `BeltSwatch` de hoje: `gray.7` no claro (8,2:1 sobre branco e 7,4:1 na linha em hover das tabelas) e por volta de `#B8B8B8` no escuro (8,6:1 no fundo, 7,2:1 no cartão, 5,65:1 no hover). Assim, a faixa branca aparece no claro e a preta no escuro, também nas linhas em hover. O `gray.6` não serve: dá 2,99:1 na linha em hover (`gray.1`).
- **Tamanho:** 32×12 px nas listas e maior no cabeçalho do exame do aluno (por volta de 48×16 px). Cantos quase retos (2 a 3 px), porque é uma faixa, não um selo.
- **Cores inline:** as cores da faixa vêm da API, então é o único lugar com cor inline vinda de dado. Isso não abre exceção para hex fixo no código.

### Certo / Errado (§ 6.4)

- **Não escolhido:** variante `default`, com contorno de 2 px na **borda de controle**. Hoje a cor do contorno está inline em `MarkButtons` (`ExamItems.tsx`, `borderColor: 'var(--mantine-color-default-border)'`) e vence o `Button.extend`: mude ali, para a borda de controle.
- **Escolhido:** **cheio**:
  - Certo em verde escuro (por volta de `#237A36`) com texto branco;
  - Errado no vermelho do logo `#D62211` com texto branco.

  No tema escuro, o escolhido ganha borda clara de 2 px (por volta de `#C9C9C9`, 8,7:1 sobre o cartão), porque o verde dá 2,67:1 e o vermelho 2,80:1 contra o cartão, e o estado selecionado precisa de ≥ 3:1.
- **O que não muda:** o ícone preenchido no escolhido, o `aria-pressed`, a altura ≥ 44 px, a largura mínima e o nome acessível ("Certo: Osoto gari").
- **Exame decidido ou evento encerrado:** texto com ícone ("Certo", "Errado", "Não marcado"), nunca botão desabilitado.

### Decisão

A decisão é a exceção às regras de "principal" e "perigo" dos botões: são duas ações de mesmo peso, lado a lado, e as duas são cheias, embora só abram a confirmação.

- **Aprovar:** verde cheio.
- **Reprovar:** vermelho do logo cheio.
- **No escuro:** os dois com a borda clara de 2 px de Certo e Errado.
- **Confirmação:** o diálogo repete as mesmas cores no botão que confirma.
- **"Baixar certificado":** botão principal; desabilitado só com o motivo escrito (§ 6.4).

### Selos de situação e de resultado

A cor vem do significado: Elegível e Aprovado em verde, Bloqueado e Reprovado em vermelho, Inativo em cinza, avisos em laranja. A forma é pílula e o texto vem sempre junto ("Bloqueado: {motivo}", § 6.2), com ícone quando já houver.

### Telas vazias e de erro

Por enquanto, um ícone Tabler e o texto. O mascote entra aqui quando houver a arte original (card #167).
