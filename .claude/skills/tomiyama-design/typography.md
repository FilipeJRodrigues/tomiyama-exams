# Tipografia

## Fonte de títulos: Barlow Condensed

- **Onde:** títulos de nível 1 e 2 (`<Title order={1}>` e `order={2}`, ou seja, `h1` e `h2`, qualquer que seja o `size` visual) e o nome **"Tomiyama"** no cabeçalho e nas telas de entrada.
- **Onde não:** subtítulos `h3` a `h6`, texto corrido, rótulos, botões, selos, tabelas e campos. Esses usam a fonte do sistema; os subtítulos menores vão em negrito.
- **Por quê:** esportiva e estreita, com letras minúsculas (o § 6 pede caixa de frase; fontes só de maiúsculas, como Bebas Neue, ficam de fora) e cabe bem no celular.
- **Pacote:** `@fontsource/barlow-condensed` (dependência aprovada pelo responsável em 2026-11-14), hospedada no próprio site. **Nunca** pelo Google Fonts: mandaria o IP dos usuários ao Google (LGPD) e dependeria de outro servidor no dia do exame.
- **Peso e subconjunto:** um peso só, **600**, e só o subconjunto `latin` (tem os acentos do português), algo como `import '@fontsource/barlow-condensed/latin-600.css'`. Cada peso a mais custa uns 20 KB no celular.
- **Peso no CSS:** os títulos que usam a fonte pedem `font-weight: 600`. Pedir 700 sem o arquivo de 700 faz o navegador engrossar a letra artificialmente.
- **Reserva:** `'Barlow Condensed', 'Arial Narrow', sans-serif`, com `font-display: swap` (o padrão do Fontsource): o título aparece na hora com a reserva e troca quando a fonte chega.
- **Como aplicar:** pelo tema, numa variável CSS própria (por exemplo, `--app-font-display`) aplicada a `h1`, `h2` e ao nome da marca. O `headings.fontFamily` do Mantine vale para todos os níveis, então não serve sozinho.

## Fonte do resto: a do sistema

A pilha padrão do Mantine (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, ...`) fica como está: zero custo de rede, ótima leitura em telas pequenas.

## Regras de texto

- **Caixa de frase** em tudo, inclusive títulos, botões e selos (§ 6). O tema já desliga a caixa alta do `Badge`; não reative com `textTransform` ou `tt="uppercase"`.
- **Sem espaçamento de letras decorativo** (`letter-spacing`) nos títulos.
- **Botões em negrito** (700); o resto do peso segue o Mantine.
- **Tamanhos:** a escala do Mantine (`xs` a `xl`, `h1` a `h6`). Não crie tamanhos soltos em `px`.
- Textos em pt-BR, datas `dd/mm/aaaa`, percentuais "72,5%" (§ 6), como já está no agente `frontend`.
