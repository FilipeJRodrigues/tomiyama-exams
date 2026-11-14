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

**Sem piscar em branco:** o `index.html` não tem `data-mantine-color-scheme` nem script, então a página aparece clara até o React montar. Ponha no `index.html` o atributo e um script curto que leia a escolha salva (a chave `tomiyama.color-scheme` do `colorSchemeManager`) antes do React, com escuro quando não houver escolha, como faz o `ColorSchemeScript` do Mantine.

## Papel de cada cor por tema

| Papel | Tema claro | Tema escuro |
|---|---|---|
| Fundo da página | branco | carvão `#1C1C1C` |
| Cartões, diálogos, menus suspensos, cabeçalho e menu lateral | branco (com borda) | `#2A2A2A` |
| Texto principal | o do Mantine | claro, por volta de `#C9C9C9` (10,3:1 no fundo, 8,7:1 no cartão) |
| Texto secundário (`dimmed`) | `gray.7` (como hoje) | por volta de `#B8B8B8` (8,6:1 no fundo, 7,2:1 no cartão) |
| **Cor principal** (`primary`): botão cheio, link (sempre sublinhado), item ativo do menu, anel de foco | **azul** `#0A265F` | **amarelo** `#FCEC27`, com texto azul sobre ele |
| Fundo das telas de entrada | azul `#0A265F` | azul `#0A265F` |
| Hover de item do menu | `gray.0` do Mantine | por volta de `#3B3B3B` (`dark.5`), diferente do menu (o padrão do `NavLink` é `dark.6`) |
| Hover de linha de tabela (`highlightOnHover`) | `gray.1` (padrão do `Table`) | por volta de `#3B3B3B` (`dark.5`, padrão do `Table`) |
| **Borda de controle**: campos, botões `default` e `ActionIcon` `default`, `Checkbox` e `Radio` desmarcados, trilho do `Switch` desligado, Certo/Errado não escolhido | `#737B83` | `#8F8F8F` |
| Erro e perigo | vermelho `#D62211` | vermelho mais claro, por volta de `#FF8577` (≥ 4,5:1 também na linha de tabela em hover) |
| Sucesso (Certo, Aprovado, Elegível) | verde (veja abaixo) | verde |
| Aviso (Dados simulados, avisos de evento) | `orange` do Mantine | `orange` do Mantine |
| Neutro (Inativo, Não marcado) | `gray` do Mantine | `gray` do Mantine |

**O escuro é carvão neutro, não azulado**, como nas referências (veja o `SKILL.md`). A paleta `dark` do Mantine (`#242424` em `dark.7`, `#2E2E2E` em `dark.6`) já está perto; o `theme.ts` a ajusta para os alvos acima e deriva os outros tons dela. Com o carvão, o amarelo se destaca, e o azul fica para a cor principal do tema claro e para as telas de entrada.

**Ajustar a paleta não basta para as superfícies.** No Mantine 9, só o `Card` e o `Popover` usam `dark.6`. O `Paper` (inclusive o `AuthCard`), o `Modal` e o `Drawer` (pelo `ModalBase`) e o cabeçalho e o menu do `AppShell` usam `--mantine-color-body`, que é o fundo da página (`dark.7`); o cabeçalho fixo do `Modal` e do `Drawer` também tem esse fundo próprio. Para eles ficarem em `#2A2A2A` no escuro, defina o fundo deles no tema (inclusive o desse cabeçalho, senão sobra uma faixa `#1C1C1C`) (`Component.extend` com `styles` ou `vars`), sem mudar o `--mantine-color-body`, que continua sendo o fundo da página.

**A cor principal muda de cor entre os temas.** O azul sobre o carvão dá 1,18:1 e o botão sumiria; o amarelo dá 13,9:1. No Mantine isso é um `virtualColor` (por exemplo, `primary` com `light: 'tomiyama-blue'` e `dark: 'tomiyama-yellow'`). O `cssVariablesResolver` do `theme.ts` corrige as cores reais (`tomiyama-blue`, `tomiyama-yellow`), mas **não** as variáveis da própria cor virtual: o Mantine gera `--mantine-color-primary-light`, `--mantine-color-primary-light-hover` e `--mantine-color-primary-light-color` direto da escala, sem a correção. É delas que vêm o fundo e o texto do item ativo do `NavLink` e do `Badge` e do `Alert` na variante `light`. O resolver precisa corrigir também essas variáveis, por tema, a partir da cor real de cada tema. O mesmo vale para o `--app-focus-ring`: monte-o com a cor real de cada tema (azul no claro, amarelo no escuro), não com `primary[8]`, que vira `var(--mantine-color-primary-8)`.

**Texto sobre o amarelo é azul** (`#0A265F`, 11,8:1). No Mantine 9, o `autoContrast` sozinho dá **preto** sobre o amarelo (`--mantine-color-black`; 17,2:1, que passa, mas não é o azul decidido), e sem ele o texto fica **branco** (1,22:1, proibido). Para o azul, ligue `autoContrast: true` no tema e ponha **`--mantine-color-primary-contrast: #0A265F`** no tema escuro do `cssVariablesResolver`. O nome segue o formato `--mantine-color-<nome da cor virtual>-contrast`, que é o que a variante `filled` de uma cor virtual lê (`default-variant-colors-resolver` do Mantine 9.7.4). A `--mantine-primary-color-contrast`, com nome parecido, não é lida por nenhum componente: pode ser definida junto, por coerência, mas sozinha não muda nada. Confira o hover.

**Outros controles sobre o amarelo** calculam a cor em JS ou têm branco fixo no CSS, sem tratar cor virtual. Defina a cor explicitamente, em azul, no tema escuro:
- o texto do item escolhido do `SegmentedControl`, se ele levar a cor principal;
- o polegar do `Switch` **ligado** (`--switch-thumb-bg`, branco por padrão: 1,22:1 no trilho amarelo), como em "Ativo" e "Só não marcados". A regra do Mantine vale para ligado e desligado: aplique o azul só no estado ligado (`input:checked`). **Desligado, o polegar continua claro** (branco, 3,23:1 sobre o trilho desligado `#8F8F8F` do escuro e 4,29:1 sobre o `#737B83` do claro; veja "Caixas de seleção, rádios e interruptores" em `components.md`): azul ali sumiria no trilho, e o estado ficaria só na cor do trilho;
- o ponto do `Radio` e o ícone do `Checkbox` (`iconColor`), que saem brancos pelo `getContrastColor`.

**Informação usa a cor principal**, não `blue` fixo: um `color="blue"` no código vira `primary` (ou some) quando a paleta Tomiyama entrar.

## Cores com significado

- **Verde (sucesso):** o `green.9` do Mantine com texto branco dá 4,37:1, abaixo do mínimo. O botão cheio usa um verde mais escuro, por volta de `#237A36` (5,37:1 com branco). No tema escuro, esse verde dá 3,17:1 contra o fundo e só 2,67:1 contra o cartão: o botão cheio verde ganha **borda clara de 2 px**, na cor do texto principal do escuro (por volta de `#C9C9C9`, 8,7:1 sobre o cartão), para o estado selecionado ter ≥ 3:1 contra o que está em volta. Vale para todo botão cheio verde ou vermelho no escuro: Certo e Errado escolhidos, Aprovar e Reprovar, e o botão que confirma no diálogo.
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
| vermelho claro `#FF8577` sobre o fundo carvão / cartão / linha de tabela em hover `#3B3B3B` | 7,20:1 / 6,06:1 / 4,73:1 |
| `#FF6B5B` (mais escuro) sobre a linha de tabela em hover | 4,00:1 (não passa; por isso o `#FF8577`) |
| borda de controle `#737B83` (claro) sobre branco / linha de tabela em hover `gray.1` / alerta vermelho `light` (`red.1` `#FFE3E3`) | 4,29:1 / 3,86:1 / 3,55:1 |
| borda de controle `#8F8F8F` (escuro) sobre o cartão / fundo / linha de tabela em hover `#3B3B3B` / alerta vermelho `light` (por volta de `#641515`) | 4,44:1 / 5,27:1 / 3,46:1 / 3,91:1 |
| `gray.6` (a borda de antes) sobre a linha em hover / sobre o alerta vermelho | 2,99:1 / 2,74:1 (não passa; por isso a borda de controle) |
| polegar branco do `Switch` desligado sobre o trilho `#737B83` (claro) / `#8F8F8F` (escuro) | 4,29:1 / 3,23:1 |
| vermelho `#D62211` sobre azul | **2,81:1** (nada vermelho nas telas de entrada fora do cartão) |
| laranja `#FF7A15` sobre branco | 2,61:1 |
| branco sobre verde `#237A36` | 5,37:1 |
| branco sobre `green.9` `#2B8A3E` | 4,37:1 (não passa) |
| verde `#237A36` sobre o fundo carvão / sobre o cartão | 3,17:1 / 2,67:1 (precisa da borda clara) |
| preto sobre amarelo (o que o `autoContrast` dá) | 17,17:1 |
| amarelo / texto `#C9C9C9` sobre o hover escuro `#3B3B3B` | 9,16:1 / 6,76:1 |
| azul sobre o hover claro `gray.0` `#F8F9FA` | 13,69:1 |
| borda clara `#C9C9C9` sobre o cartão / sobre o fundo carvão | 8,67:1 / 10,29:1 |
| `dimmed` claro `gray.7` `#495057` sobre branco / sobre a linha em hover `gray.1` | 8,18:1 / 7,35:1 |
| `dimmed` escuro `#B8B8B8` sobre o fundo carvão / cartão / hover `#3B3B3B` | 8,59:1 / 7,24:1 / 5,65:1 |
| borda `#8F8F8F` sobre azul (o cartão escuro das telas de entrada) | 4,46:1 |
| texto secundário `#C5CEE6` sobre azul | 9,17:1 |

Ao mudar um tom no `theme.ts`, meça de novo (há a função `contrastRatio` no próprio `theme.ts`) e mantenha a folga de 4,6:1 que o tema já usa para texto.
