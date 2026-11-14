# Logo

## O que é

Um selo redondo. De fora para dentro:
- anel preto com "ACADEMIA TOMIYAMA" e "JUDÔ - JIU JITSU" em amarelo, com contorno vermelho;
- círculo azul-marinho com o kanji 富山 em branco;
- o mascote: uma ave preta de bico laranja, de judogi branco e faixa preta.

É o mesmo logo do Instagram da academia.

O único arquivo que existe hoje é um **JPEG de 640×640 com fundo branco nos cantos**. Não há vetor (veja "Pendente").

## Arquivos

Os arquivos ficam em `frontend/src/assets/brand/`. A etapa 2 do card #166 os cria; até lá, o original está na pasta `logo/` da raiz, fora do git.

| Arquivo | Uso |
|---|---|
| `tomiyama-logo-original.jpeg` | o original, sem alteração; só serve de fonte para gerar os outros |
| `tomiyama-logo-96.webp` | cabeçalho (exibido com uns 40 px; o arquivo maior fica nítido em tela retina) |
| `tomiyama-logo-320.webp` | telas de entrada (exibido com 160 px ou 96 px) |

As duas versões menores são **recortadas em círculo, com fundo transparente**:
- **Por quê:** os cantos brancos do JPEG apareceriam sobre o azul e no tema escuro.
- **Como gerar:** uma única vez, com um script descartável (por exemplo, `uv run --with pillow`), sem dependência nova no projeto.
- **Borda:** a máscara entra 1 a 2 px no anel preto, para não sobrar franja branca, e é suavizada (desenhada maior e reduzida).
- **Formato:** se o WebP mostrar franja, use PNG.

## Como usar

- **Texto alternativo:** "Academia Tomiyama". Se o logo virar link (por exemplo, para a landing page, card #168), o texto alternativo passa a dizer o destino.
- **Tamanhos:**
  - cabeçalho: uns 40 px;
  - telas de entrada: 160 px, ou 96 px abaixo do `sm` e em telas baixas;
  - mínimo: 32 px.
- **Fundos:** branco, azul `#0A265F` e o fundo escuro. O anel preto separa o logo de qualquer um deles.
- **Formato:** sempre redondo e com proporção 1:1 (`width` = `height`, `object-fit: contain`).

## Não faça

- Distorcer, girar, recolorir ou aplicar filtro, sombra pesada ou opacidade.
- Pôr texto ou outro elemento por cima.
- Recortar só o mascote ou só o kanji do JPEG: fica serrilhado (card #167).
- Usar os logos carregados na tela Academia (§ 6.6, `GET /settings/logos/{slot}`) no cabeçalho ou no login. Eles são do certificado, e a rota só responde a examinador, ou seja, não funciona no login nem para os responsáveis.

## Pendente

- **Logo em vetor** (SVG, PDF ou AI do designer): quando a academia mandar, ele substitui as versões recortadas e fica nítido em qualquer tamanho (card #167).
- **Mascote e kanji soltos:** só com a arte original (card #167).
