# Cores

## Cores-base (medidas no logo)

| Nome | Hex | Onde está no logo | Papel no site |
|---|---|---|---|
| Azul Tomiyama | `#0A265F` | círculo interno | cor principal no tema claro; fundo das telas de entrada nos dois temas |
| Amarelo Tomiyama | `#FCEC27` | letras | cor principal no tema escuro; no tema claro, só sobre o azul |
| Vermelho Tomiyama | `#D62211` | contorno das letras | só erro e perigo (Errado, Reprovar, Bloqueado, Excluir, mensagens de erro) |
| Laranja do bico | `#FF7A15` | bico do mascote | **fora da interface** (2,61:1 sobre branco; só serviria de enfeite) |
| Preto | `#000000` | anel externo | texto e contornos; não é cor de superfície |
| Branco | `#FFFFFF` | judogi, kanji | fundo do tema claro; texto sobre o azul |

Os tons derivados (as escalas de 10 tons do Mantine, hover, a paleta `dark`) ficam só no `theme.ts`, calculados a partir destas cores e dos alvos abaixo.

## Tema padrão

O site abre no **tema escuro** na primeira visita (`defaultColorScheme="dark"`). O botão de tema continua no cabeçalho, e a escolha salva pelo usuário vale nas visitas seguintes. O tema claro continua completo (§ 6): tudo o que vale para um vale para o outro.

## Papel de cada cor por tema

| Papel | Tema claro | Tema escuro |
|---|---|---|
| Fundo da página | branco | carvão `#1C1C1C` |
| Cartões, diálogos, menus suspensos, cabeçalho e menu lateral | branco (com borda) | `#2A2A2A` |
| Texto principal | o do Mantine | claro, por volta de `#C9C9C9` (10,3:1 no fundo, 8,7:1 no cartão) |
| Texto secundário (`dimmed`) | `gray.7` (como hoje) | por volta de `#B8B8B8` (8,6:1 no fundo, 7,2:1 no cartão) |
| **Cor principal** (`primary`): botão cheio, link, item ativo do menu, anel de foco | **azul** `#0A265F` | **amarelo** `#FCEC27`, com texto azul sobre ele |
| Fundo das telas de entrada | azul `#0A265F` | azul `#0A265F` |
| Borda de campo em repouso | `gray.6` (como hoje) | por volta de `#828282` (4,4:1 no fundo, 3,7:1 no cartão) |
| Erro e perigo | vermelho `#D62211` | vermelho mais claro, por volta de `#FF6B5B` |
| Sucesso (Certo, Aprovado, Elegível) | verde (veja abaixo) | verde |
| Aviso (Dados simulados, avisos de evento) | `orange` do Mantine | `orange` do Mantine |
| Neutro (Inativo, Não marcado) | `gray` do Mantine | `gray` do Mantine |

**O escuro é carvão neutro, não azulado**, como nas referências (veja o `SKILL.md`). A paleta `dark` do Mantine (`#242424` no fundo, `#2E2E2E` nos cartões) já está perto; o `theme.ts` a ajusta para os alvos acima e deriva os outros tons dela. Com o carvão, o amarelo se destaca, e o azul fica para a cor principal do tema claro e para as telas de entrada.

**A cor principal muda de cor entre os temas.** O azul sobre o carvão dá 1,18:1 e o botão sumiria; o amarelo dá 13,9:1. No Mantine isso é um `virtualColor` (por exemplo, `primary` com `light: 'tomiyama-blue'` e `dark: 'tomiyama-yellow'`). O `cssVariablesResolver` do `theme.ts` já pula as cores virtuais nas correções de contraste; confira se as cores reais por trás delas continuam corrigidas.

**Texto sobre o amarelo é azul** (`#0A265F`, 11,8:1), nunca branco. Use `autoContrast` ou a cor de texto explícita do botão; confira o hover também.

**Informação usa a cor principal**, não `blue` fixo: um `color="blue"` no código vira `primary` (ou some) quando a paleta Tomiyama entrar.

## Cores com significado

- **Verde (sucesso):** o `green.9` do Mantine com texto branco dá 4,37:1, abaixo do mínimo. O botão cheio usa um verde mais escuro, por volta de `#237A36` (5,37:1 com branco). No tema escuro, esse verde dá 3,17:1 contra o fundo e só 2,67:1 contra o cartão: o botão cheio verde ganha borda clara de 2 px para o estado selecionado ter ≥ 3:1 contra o que está em volta.
- **Vermelho (erro e perigo):** no tema claro, o vermelho do logo (5,13:1 sobre branco e com texto branco). No tema escuro, como **texto ou borda** use o tom mais claro (o original dá 3,32:1 sobre o fundo e 2,80:1 sobre o cartão); como **fundo de botão cheio** com texto branco, o vermelho do logo serve nos dois temas (5,13:1), com a mesma borda clara do verde no escuro.
- **Laranja (aviso):** o `orange` do Mantine, na variante `light`, como já é hoje. Não confundir com o laranja do bico, que fica fora.
- **Amarelo não é aviso.** Ele é a marca; aviso é laranja.

## Contrastes medidos

| Par | Razão |
|---|---|
| branco sobre azul `#0A265F` | 14,43:1 |
| amarelo `#FCEC27` sobre azul | 11,80:1 |
| amarelo sobre branco | **1,22:1** (proibido) |
| amarelo sobre o fundo carvão `#1C1C1C` / sobre o cartão `#2A2A2A` | 13,93:1 / 11,73:1 |
| azul sobre o fundo carvão | **1,18:1** (por isso a principal vira amarelo no escuro) |
| vermelho `#D62211` sobre branco / branco sobre vermelho | 5,13:1 |
| vermelho `#D62211` sobre o fundo carvão / sobre o cartão | 3,32:1 / 2,80:1 (só como fundo de botão) |
| vermelho claro `#FF6B5B` sobre o fundo carvão / sobre o cartão | 6,09:1 / 5,13:1 |
| vermelho `#D62211` sobre azul | **2,81:1** (nada vermelho nas telas de entrada fora do cartão) |
| laranja `#FF7A15` sobre branco | 2,61:1 |
| branco sobre verde `#237A36` | 5,37:1 |
| branco sobre `green.9` `#2B8A3E` | 4,37:1 (não passa) |
| verde `#237A36` sobre o fundo carvão / sobre o cartão | 3,17:1 / 2,67:1 (precisa da borda clara) |
| `gray.6` `#868E96` sobre branco / fundo carvão / cartão | 3,32:1 / 5,13:1 / 4,32:1 |
| texto secundário `#C5CEE6` sobre azul | 9,17:1 |

Ao mudar um tom no `theme.ts`, meça de novo (há a função `contrastRatio` no próprio `theme.ts`) e mantenha a folga de 4,6:1 que o tema já usa para texto.
