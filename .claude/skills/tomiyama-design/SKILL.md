---
name: tomiyama-design
description: Identidade visual do site da Academia Tomiyama (Área de exames e a futura landing page) — cores do logo, tema Mantine claro e escuro, tipografia, botões, selos, logo, cabeçalho e telas de entrada. Use ao criar ou alterar qualquer elemento visual em frontend/ e ao revisar a aparência de uma mudança.
---

# Identidade visual da Tomiyama

Guia de referência da aparência do site. Decisões do responsável de 2026-11-14 (card #165). Ele diz **como o site se parece**; **o que cada tela mostra** continua no § 6 de `requirements/requisitos-exame-graduacao.md`, e o § 6.7 (acessibilidade) vale sempre por cima deste guia.

## Marca

- O nome que aparece no site é **"Tomiyama"**. Este sistema é a **"Área de exames"**, uma parte do site da academia; a landing page (card #168) é a outra.
- Nomes internos não mudam: repositório, quadro "Tomiyama Exams", pacote `tomiyama-exams-frontend`.
- A academia ensina judô e jiu-jitsu (o logo diz "Judô - Jiu Jitsu"). A base comum deste guia não fala só de judô; a camada da Área de exames é de judô.

## Personalidade

**Esportiva e vibrante**, com as cores fortes do logo: azul-marinho, amarelo e vermelho. Vibrante não é poluída: os dados do exame vêm primeiro, e cada cor tem um papel fixo (veja `colors.md`). Quem usa é o examinador no celular, no tatame, e os pais em casa: tudo precisa ser lido de relance.

## Regras que nunca se quebram

1. **Contraste** (§ 6.7): texto ≥ 4,5:1 e indicadores (borda de campo, anel de foco, contorno de selo, estado de botão) ≥ 3:1, **nos dois temas** e nos estados de hover, foco e selecionado.
2. **Estado nunca só por cor:** ícone e texto acompanham a cor (Certo/Errado, Bloqueado, faixa sempre com o nome escrito).
3. **Caixa de frase** (§ 6): nada de caixa alta decorativa, nem em títulos, selos ou botões. Por isso não há fonte só de maiúsculas.
4. **Tema claro e escuro** sempre; nenhuma cor fixa que só funcione num deles.
5. **Amarelo nunca sobre branco** (1,22:1): no tema claro ele só aparece sobre o azul.
6. **Vermelho só para erro e perigo**, nunca como enfeite.
7. **Dentro das áreas azuis** (cabeçalho, menu, telas de entrada) o texto é branco ou amarelo e o **anel de foco é amarelo**; o azul do foco some ali.
8. **Mantine com tema próprio**, sem outra biblioteca de interface nem CSS-in-JS novo. Dependência nova só com o master.

## Como aplicar

Na ordem de preferência:

1. **Tema** (`frontend/src/app/theme.ts`: `createTheme`, `cssVariablesResolver`) e `frontend/src/app/a11y.css`.
2. **Props e variantes do Mantine** (`color`, `variant`, `radius`) e `Component.extend` no tema.
3. **Módulo CSS** (`*.module.css`, com o `postcss-preset-mantine`) usando as variáveis `--mantine-*` e `--app-*`.

Nunca escreva um hex solto num componente: as cores vêm do tema. As **6 cores-base** ficam neste guia; os **tons derivados** (as escalas de 10 tons do Mantine, hover, a paleta `dark`) ficam só no `theme.ts`. Se o `theme.ts` ainda não tiver a paleta Tomiyama (card #166, etapa 1), siga o tema que existe e avise o master, em vez de pintar uma tela à parte.

## Arquivos de referência

Leia o que a tarefa pede:

- [colors.md](colors.md): cores-base, papel de cada cor nos dois temas, contrastes medidos e cores com significado (sucesso, erro, aviso).
- [typography.md](typography.md): Barlow Condensed nos títulos, fonte do sistema no resto.
- [components.md](components.md): botões, selos, campos, cabeçalho e menu, telas de entrada, selo de faixa, Certo/Errado e decisão.
- [logo.md](logo.md): arquivos, tamanhos, texto alternativo e usos proibidos.

## Ainda não

- **Mascote e kanji 富山** fora do logo: só com a arte original da academia (card #167). Não recorte o mascote do JPEG nem use fonte japonesa.
- **Landing page:** a base comum (cores, logo, tipografia, botões) vale para ela; o que for só dela entra neste guia quando for planejada (card #168).

## Lista de conferência

O `frontend` confere antes de entregar; o `qa-frontend` confere na revisão e trata cada item reprovado como falha (com teste de regressão quando der para testar):

- [ ] Nenhum hex solto em componente; cores do tema ou variáveis CSS.
- [ ] Contraste conferido nos **dois temas**, em repouso, hover, foco e selecionado (texto 4,5:1, indicadores 3:1).
- [ ] Amarelo só sobre azul (claro) ou como cor principal (escuro); nunca sobre branco.
- [ ] Vermelho só em erro e perigo; laranja do logo fora da interface.
- [ ] Anel de foco visível em fundo branco, no fundo escuro e dentro das áreas azuis.
- [ ] Botões, selos e seletores segmentados em pílula, com texto em negrito nos botões; campos e cartões com `md`.
- [ ] Barlow Condensed só nos títulos h1 e h2 e no nome "Tomiyama"; sem caixa alta.
- [ ] Estado com ícone e texto, nunca só por cor; faixa sempre com o nome escrito.
- [ ] Logo pelos arquivos de `frontend/src/assets/brand/`, sem distorcer, sem recolorir, com texto alternativo.
- [ ] Layout de 390 px e zoom de 200% sem perder ações (§ 6.7).
