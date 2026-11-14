# Componentes

As cores citadas aqui estão em [colors.md](colors.md); a fonte, em [typography.md](typography.md).

## Base comum (Área de exames e landing page)

### Botões

- **Formato:** pílula (raio total; no Mantine, `radius="xl"` como padrão do `Button` e do `ActionIcon` pelo `extend` do tema). Texto em **negrito** (700).
- **Variantes:**
  - **principal:** `filled` na cor principal (azul no claro, amarelo com texto azul no escuro). Uma ação principal por área da tela.
  - **secundária:** `default` ou `outline`.
  - **perigo:** `filled` vermelho na confirmação de algo que não se desfaz (Excluir, Reprovar); `light` ou `outline` vermelho para o botão que só abre a confirmação.
  - **suave:** `light` ou `subtle`, para ações de apoio.
- **Tamanho:** os botões Certo/Errado têm alvo ≥ 44 px (§ 6.4). No celular, prefira 44 px também nos outros botões de ação (card #149).
- **Somente leitura:** não use botão desabilitado para mostrar um estado (contraste ruim, § 6.4): mostre texto com ícone.

### Selos, seletores, campos e cartões

- **Selos (`Badge`)** e **seletores segmentados (`SegmentedControl`):** pílula, caixa de frase, cor pelo significado (sucesso, erro, aviso, neutro), sempre com texto.
- **Campos** (`TextInput`, `NativeSelect`, `Textarea`, `PasswordInput`...), **cartões** (`Paper`, `Card`) e **diálogos** (`Modal`): raio `md`, como hoje. Uma caixa de texto em pílula fica estranha.
- **Bordas e foco:** os de `a11y.css` (`--app-input-border`, `--app-focus-ring`), refeitos com a paleta nova.

### Ícones

Tabler (`@tabler/icons-react`), tamanho 18 a 20 nos controles. Ícone decorativo leva `aria-hidden`; o texto ao lado dá o nome.

### Áreas de marca (azul)

Cabeçalho, menu lateral e telas de entrada usam o azul `#0A265F` **nos dois temas**. Dentro delas:

- texto em **branco** (14,4:1) ou **amarelo** (11,8:1); texto secundário num azul bem claro, por volta de `#C5CEE6` (9,2:1);
- **anel de foco amarelo**;
- **nada vermelho** (2,8:1 sobre o azul): um erro ali vai num cartão ou num alerta com fundo próprio;
- qualquer selo (por exemplo, "Dados simulados") tem o contraste medido contra o azul, não contra o branco.

## Área de exames

### Cabeçalho e menu lateral

- **Formato:** cabeçalho e menu lateral azuis formam um bloco em "L". No celular, a gaveta do menu é azul também.
- **Cabeçalho**, da esquerda para a direita:
  - botão do menu (só no celular);
  - **logo redondo** de uns 40 px, com texto alternativo "Academia Tomiyama" (veja [logo.md](logo.md));
  - **"Tomiyama"** em Barlow Condensed branca;
  - **"Área de exames"** menor, no texto secundário claro. Some abaixo do breakpoint `sm`, onde fica só "Tomiyama".
- **Lado direito do cabeçalho:** o e-mail em branco e os botões Tema e Sair com **contorno branco** e texto branco.
- **Linha amarela** de uns 3 px, na largura toda, embaixo do cabeçalho.
- **Itens do menu:** texto e ícone brancos; hover com um véu branco leve, mantendo o texto ≥ 4,5:1.
- **Item ativo:** **pílula amarela com texto azul** (11,8:1) e em negrito. O `aria-current="page"` do React Router continua.
- **Rodapé do menu** (e-mail e perfil): branco e texto secundário claro.
- **Título da aba do navegador:** "Área de exames · Tomiyama".

### Telas de entrada (login, cadastro, esqueci a senha)

Todas usam o `AuthCard`.

- **Fundo:** azul `#0A265F` na tela inteira, nos dois temas.
- **Acima do cartão, centralizados:**
  - o **logo** com **160 px**. Abaixo do breakpoint `sm` (celular de 390 px, zoom de 200%) e em telas baixas, ele cai para **96 px**, para o formulário continuar à vista sem rolar;
  - **"Tomiyama"** em Barlow Condensed branca;
  - **"Área de exames"** no texto secundário claro.

  Nenhum dos dois textos é título (`h1`): o `h1` é o título do cartão ("Entrar", "Criar conta"...).
- **Cartão:** branco no claro e `#16213F` no escuro, com borda. O botão principal fica na cor principal.
- O texto "Tomiyama Exams" que hoje está dentro do cartão sai.

### Selo de faixa

Ele substitui o `BeltSwatch` de `frontend/src/features/students/studentCells.tsx`. É uma **mini faixa**, sempre ao lado do nome da faixa escrito; ele é decorativo (`aria-hidden`).

- **Corpo:** na cor principal da faixa (`color_primary` da API).
- **Faixas de duas cores:** as **pontas**, um quarto da largura de cada lado, ficam na cor secundária (`color_secondary`), como no certificado (§ 7, item 5). A faixa de uma cor só não tem pontas.
- **Contorno:** 1 px em `gray.6` nos dois temas (3,3:1 sobre branco, 5,6:1 sobre o fundo escuro e 4,8:1 sobre o cartão escuro). Assim, a faixa branca aparece no claro e a preta no escuro.
- **Tamanho:** 32×12 px nas listas e maior no cabeçalho do exame do aluno (por volta de 48×16 px). Cantos quase retos (2 a 3 px), porque é uma faixa, não um selo.
- **Cores inline:** as cores da faixa vêm da API, então é o único lugar com cor inline vinda de dado. Isso não abre exceção para hex fixo no código.

### Certo / Errado (§ 6.4)

- **Não escolhido:** variante `default`, com contorno, como hoje.
- **Escolhido:** **cheio**:
  - Certo em verde escuro (por volta de `#237A36`) com texto branco;
  - Errado no vermelho do logo `#D62211` com texto branco.
  
  No tema escuro, o escolhido ganha borda clara de 2 px para ter ≥ 3:1 contra o cartão.
- **O que não muda:** o ícone preenchido no escolhido, o `aria-pressed`, a altura ≥ 44 px, a largura mínima e o nome acessível ("Certo: Osoto gari").
- **Exame decidido ou evento encerrado:** texto com ícone ("Certo", "Errado", "Não marcado"), nunca botão desabilitado.

### Decisão

- **Aprovar:** verde cheio.
- **Reprovar:** vermelho do logo cheio.
- **Confirmação:** o diálogo repete as mesmas cores no botão que confirma.
- **"Baixar certificado":** botão principal.

### Selos de situação e de resultado

A cor vem do significado: Elegível e Aprovado em verde, Bloqueado e Reprovado em vermelho, Inativo em cinza, avisos em laranja. A forma é pílula e o texto vem sempre junto ("Bloqueado: {motivo}", § 6.2), com ícone quando já houver.

### Telas vazias e de erro

Por enquanto, um ícone Tabler e o texto. O mascote entra aqui quando houver a arte original (card #167).
