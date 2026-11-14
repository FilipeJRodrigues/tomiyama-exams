# Cores

## Cores-base (medidas no logo)

| Nome | Hex | Onde está no logo | Papel no site |
|---|---|---|---|
| Azul Tomiyama | `#0A265F` | círculo interno | cor principal no tema claro; áreas de marca (cabeçalho, menu, telas de entrada) nos dois temas |
| Amarelo Tomiyama | `#FCEC27` | letras | destaque no tema claro (só sobre o azul); cor principal no tema escuro |
| Vermelho Tomiyama | `#D62211` | contorno das letras | só erro e perigo (Errado, Reprovar, Bloqueado, Excluir, mensagens de erro) |
| Laranja do bico | `#FF7A15` | bico do mascote | **fora da interface** (2,61:1 sobre branco; só serviria de enfeite) |
| Preto | `#000000` | anel externo | texto e contornos; não é cor de superfície |
| Branco | `#FFFFFF` | judogi, kanji | fundo do tema claro; texto sobre o azul |

Os tons derivados (as escalas de 10 tons do Mantine, hover, a paleta `dark`) ficam só no `theme.ts`, calculados a partir destas cores.

## Papel de cada cor por tema

| Papel | Tema claro | Tema escuro |
|---|---|---|
| Fundo da página | branco | marinho escuro `#0B1328` |
| Cartões, diálogos, menus suspensos | branco (com borda) | `#16213F` |
| Texto principal | o do Mantine | claro, por volta de `#E9EDF7` (≥ 4,5:1 sobre o fundo e os cartões) |
| Texto secundário (`dimmed`) | `gray.7` (como hoje) | por volta de `#A9B6D6` (9,1:1 no fundo, 7,8:1 no cartão) |
| **Cor principal** (`primary`): botão cheio, link, item selecionado, anel de foco | **azul** `#0A265F` | **amarelo** `#FCEC27`, com texto azul sobre ele |
| Destaque de marca | amarelo, só sobre o azul | amarelo |
| Áreas de marca (cabeçalho, menu, telas de entrada) | azul `#0A265F` | azul `#0A265F` |
| Borda de campo em repouso | `gray.6` (como hoje) | por volta de `#7A88AD` (≥ 3:1 no fundo e no cartão) |
| Erro e perigo | vermelho `#D62211` | vermelho mais claro, por volta de `#FF6B5B` |
| Sucesso (Certo, Aprovado, Elegível) | verde (veja abaixo) | verde |
| Aviso (Dados simulados, avisos de evento) | `orange` do Mantine | `orange` do Mantine |
| Neutro (Inativo, Não marcado) | `gray` do Mantine | `gray` do Mantine |

**A cor principal muda de cor entre os temas.** O azul sobre o fundo escuro dá 1,28:1 e o botão sumiria; o amarelo dá 15:1. No Mantine isso é um `virtualColor` (por exemplo, `primary` com `light: 'tomiyama-blue'` e `dark: 'tomiyama-yellow'`). O `cssVariablesResolver` do `theme.ts` já pula as cores virtuais nas correções de contraste; confira se as cores reais por trás delas continuam corrigidas.

**Texto sobre o amarelo é azul** (`#0A265F`, 11,8:1), nunca branco. Use `autoContrast` ou a cor de texto explícita do botão; confira o hover também.

**Informação usa a cor principal**, não `blue` fixo: um `color="blue"` no código vira `primary` (ou some) quando a paleta Tomiyama entrar.

## Cores com significado

- **Verde (sucesso):** o `green.9` do Mantine com texto branco dá 4,37:1, abaixo do mínimo. O botão cheio usa um verde mais escuro, por volta de `#237A36` (5,37:1 com branco). No tema escuro, o botão cheio verde fica com borda clara de 2 px para o estado selecionado ter ≥ 3:1 contra o cartão (o verde sozinho dá 2,95:1 sobre `#16213F`).
- **Vermelho (erro e perigo):** no tema claro, o vermelho do logo (5,13:1 sobre branco e com texto branco). No tema escuro, como **texto ou borda** use o tom mais claro (o original dá 3,6:1 sobre o fundo e 3,1:1 sobre o cartão); como **fundo de botão cheio** com texto branco, o vermelho do logo serve nos dois temas (5,13:1).
- **Laranja (aviso):** o `orange` do Mantine, na variante `light`, como já é hoje. Não confundir com o laranja do bico, que fica fora.
- **Amarelo não é aviso.** Ele é a marca; aviso é laranja.

## Contrastes medidos

| Par | Razão |
|---|---|
| branco sobre azul `#0A265F` | 14,43:1 |
| amarelo `#FCEC27` sobre azul | 11,80:1 |
| amarelo sobre branco | **1,22:1** (proibido) |
| amarelo sobre o fundo escuro `#0B1328` | 15,08:1 |
| amarelo sobre o cartão escuro `#16213F` | 12,97:1 |
| azul sobre o fundo escuro `#0B1328` | **1,28:1** (por isso a principal vira amarelo) |
| vermelho `#D62211` sobre branco / branco sobre vermelho | 5,13:1 |
| vermelho `#D62211` sobre o fundo escuro / sobre o cartão | 3,60:1 / 3,10:1 (só como fundo de botão) |
| vermelho claro `#FF6B5B` sobre o fundo escuro / sobre o cartão | 6,60:1 / 5,67:1 |
| vermelho `#D62211` sobre azul | **2,81:1** (nada vermelho dentro das áreas azuis) |
| laranja `#FF7A15` sobre branco | 2,61:1 |
| branco sobre verde `#237A36` | 5,37:1 |
| branco sobre `green.9` `#2B8A3E` | 4,37:1 (não passa) |
| `gray.6` `#868E96` sobre branco / fundo escuro / cartão escuro | 3,32:1 / 5,56:1 / 4,78:1 |
| texto secundário `#C5CEE6` sobre azul | 9,17:1 |

Ao mudar um tom no `theme.ts`, meça de novo (há a função `contrastRatio` no próprio `theme.ts`) e mantenha a folga de 4,6:1 que o tema já usa para texto.
