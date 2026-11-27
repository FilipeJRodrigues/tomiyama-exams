/**
 * Selo de faixa como mini faixa (#166, etapa 4; skill tomiyama-design, "Selo de faixa"): o corpo
 * na cor principal da faixa, as pontas na secundária com 18% da largura de cada lado (a mesma
 * geometria do desenho da tela Faixas), contorno de 1 px na cor do texto secundário, 32×12 px nas
 * listas e 48×16 px no cabeçalho do exame, decorativo (`aria-hidden`). As cores vêm da API
 * (inline); o resto, do `BeltShape.module.css`, medido com `tests/computedCss.ts`.
 */
import { Card, MantineProvider, Table } from '@mantine/core';
import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Belt } from '../../../src/api/types';
import { cssVariablesResolver, theme } from '../../../src/app/theme';
import {
  BeltDrawing,
  BeltInText,
  MiniBelt,
  NamedBelt,
} from '../../../src/features/belts/BeltShape';
import { BELT_TIP_PERCENT, beltBackground } from '../../../src/features/belts/beltGeometry';
import { mockBelts } from '../../../src/mocks/data';
import { Styles, contrast, expectContrast, hex, loadStyles } from '../../computedCss';
import { beltStops, hexOf } from './miniBeltHelpers';

type Scheme = 'light' | 'dark';

const MIN_INDICATOR = 3;

const colors = mergeMantineTheme(DEFAULT_THEME, theme).colors;

/** `--mantine-color-dimmed` of each scheme (`cssVariablesResolver`): gray.7 / dark.1. */
const DIMMED: Record<Scheme, string> = {
  light: colors.gray[7].toLowerCase(),
  dark: colors.dark[1].toLowerCase(),
};

function belt(name: string): Belt {
  const found = mockBelts.find((item) => item.name === name);
  if (!found) throw new Error(`Faixa ${name} fora da base simulada.`);
  return found;
}

/** A black belt: the base has none (black is the federation's exam), but the selo must show it. */
const BLACK: Belt = { ...belt('Marrom'), id: 'preta', name: 'Preta', color_primary: '#000000' };

function renderInTheme(scheme: Scheme, children: ReactNode) {
  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme={scheme}
    >
      {children}
    </MantineProvider>,
  );
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
}

function selos(): HTMLElement[] {
  return screen.getAllByTestId('belt-swatch');
}

/** Value of the declaration that wins on the element, with its `var()` resolved. */
function value(styles: Styles, element: Element, prop: string): string | null {
  const winner = styles.declared(element, [prop]);
  return winner === null ? null : styles.resolve(element, winner.value);
}

beforeAll(loadStyles);

describe('selo de faixa: mini faixa (#166, etapa 4)', () => {
  it('faixa de duas cores: corpo na cor principal e pontas na secundária, 18% de cada lado', () => {
    renderInTheme('dark', <MiniBelt belt={belt('Cinza/Azul')} />);
    const [selo] = selos();
    expect(beltStops(selo!)).toEqual([
      ['#1e63c6', 0, 18],
      ['#9e9e9e', 18, 82],
      ['#1e63c6', 82, 100],
    ]);
  });

  it('faixa de uma cor só: só o corpo, sem pontas', () => {
    renderInTheme('dark', <MiniBelt belt={belt('Branca')} />);
    const [selo] = selos();
    expect(selo!.style.background).not.toContain('gradient');
    expect(beltStops(selo!)).toEqual([['#ffffff', 0, 100]]);
  });

  it('a proporção das pontas é a do desenho da tela Faixas: o mesmo código', () => {
    expect(BELT_TIP_PERCENT).toBe(18);
    const twoColors = belt('Amarela/Laranja');
    renderInTheme(
      'light',
      <>
        <MiniBelt belt={twoColors} />
        <BeltDrawing belt={twoColors} />
      </>,
    );
    const drawing = screen.getByTestId('belt-drawing');
    const [selo] = selos();
    expect(beltStops(drawing)).toEqual(beltStops(selo!));
    expect(beltStops(selo!)).toEqual([
      ['#f07c00', 0, BELT_TIP_PERCENT],
      ['#f2c200', BELT_TIP_PERCENT, 100 - BELT_TIP_PERCENT],
      ['#f07c00', 100 - BELT_TIP_PERCENT, 100],
    ]);
    expect(beltBackground(twoColors)).toBe(
      'linear-gradient(to right, #F07C00 0 18%, #F2C200 18% 82%, #F07C00 82% 100%)',
    );
    expect(beltBackground(belt('Laranja'))).toBe('#F07C00');
  });

  it('tamanho por contexto: 32×12 px nas listas e 48×16 px no cabeçalho, cantos de 2 a 3 px', async () => {
    renderInTheme(
      'light',
      <>
        <MiniBelt belt={belt('Verde')} />
        <MiniBelt belt={belt('Verde')} size="header" />
      </>,
    );
    const [list, header] = selos();
    expect(list).toHaveAttribute('data-size', 'list');
    expect(header).toHaveAttribute('data-size', 'header');
    const styles = await Styles.now();
    const size = (element: Element) =>
      ['width', 'height', 'border-radius'].map((prop) => value(styles, element, prop));
    expect(size(list!)).toEqual(['32px', '12px', '2px']);
    expect(size(header!)).toEqual(['48px', '16px', '3px']);
    expect(value(styles, list!, 'display')).toBe('inline-block');
    expect(value(styles, list!, 'flex')).toBe('none');
  });

  it('decorativo: aria-hidden, fora do nome acessível, com o nome sempre escrito ao lado', () => {
    renderInTheme(
      'light',
      <h2>
        <NamedBelt belt={belt('Cinza/Azul')}>Cinza/Azul</NamedBelt>
      </h2>,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveAccessibleName('Cinza/Azul');
    expect(heading).toHaveTextContent(/^Cinza\/Azul$/);
    const selo = within(heading).getByTestId('belt-swatch');
    expect(selo).toHaveAttribute('aria-hidden', 'true');
    expect(selo).toBeEmptyDOMElement();
    // The belt comes before the name, which is written in the same row.
    expect(selo.nextElementSibling).toHaveTextContent(/^Cinza\/Azul$/);
  });

  it('sem a faixa (lista de faixas carregando ou com erro): só o nome, sem selo', () => {
    renderInTheme('light', <NamedBelt belt={undefined}>Roxa · 1 grau</NamedBelt>);
    expect(screen.queryByTestId('belt-swatch')).toBeNull();
    expect(screen.getByText('Roxa · 1 grau')).toBeInTheDocument();
  });

  it('contorno de 1 px na variável dimmed (não no gray.6), no selo e no desenho', async () => {
    renderInTheme(
      'light',
      <>
        <MiniBelt belt={belt('Branca')} />
        <BeltDrawing belt={belt('Branca')} />
      </>,
    );
    const styles = await Styles.now();
    for (const element of [...selos(), screen.getByTestId('belt-drawing')]) {
      expect(styles.declared(element, ['border', 'border-color'])?.value).toBe(
        '1px solid var(--mantine-color-dimmed)',
      );
    }
  });

  it('só as cores da faixa ficam inline; nenhum hex fixo no código do selo', () => {
    renderInTheme('light', <MiniBelt belt={belt('Cinza/Azul')} />);
    const [selo] = selos();
    expect(selo!.getAttribute('style')).toMatch(/^background: [^;]+;$/);

    const sources = import.meta.glob<string>(
      [
        '../../../src/features/belts/BeltShape.tsx',
        '../../../src/features/belts/BeltShape.module.css',
        '../../../src/features/belts/beltGeometry.ts',
      ],
      { query: '?raw', import: 'default', eager: true },
    );
    expect(Object.keys(sources)).toHaveLength(3);
    for (const [path, source] of Object.entries(sources)) {
      // The code, without the comments (they cite cards like #143).
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code.match(/#[0-9a-f]{3,8}\b/gi), path).toBeNull();
      expect(code, path).not.toMatch(/gray-6|gray\.6|gray\[6\]/);
    }
  });

  it('o BeltSwatch antigo saiu: nenhuma tela o usa mais', () => {
    const sources = import.meta.glob<string>('../../../src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const found = Object.entries(sources)
      .filter(([, source]) => /\bBeltSwatch\b/.test(source))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });

  it('nome em duas linhas: o selo fica na primeira linha, não centralizado entre as duas', async () => {
    renderInTheme(
      'light',
      <>
        <NamedBelt belt={belt('Amarela/Laranja')}>Amarela/Laranja · 2 graus</NamedBelt>
        <p>
          15 anos · <BeltInText belt={belt('Marrom')} text="Faixa Marrom" />
        </p>
      </>,
    );
    const [list, header] = selos();
    const styles = await Styles.now();
    const row = list!.parentElement!;
    expect(value(styles, row, 'display')).toBe('flex');
    expect(value(styles, row, 'align-items')).toBe('flex-start');
    // From the top of the line, down half of what the line has over the belt: the belt's
    // middle on the middle of line 1, in a row (lists) and in a line of text (header).
    for (const selo of [list!, header!]) {
      expect(value(styles, selo, 'vertical-align')).toBe('top');
    }
    expect(value(styles, list!, 'margin-top')).toBe('calc((1lh - 12px) / 2)');
    expect(value(styles, header!, 'margin-top')).toBe('calc((1lh - 16px) / 2)');
  });
});

describe('selo dentro de uma linha de texto (cabeçalho do exame, #166)', () => {
  it('maior, antes do texto, colado à primeira palavra; o texto lê e quebra como antes', async () => {
    renderInTheme(
      'dark',
      <p data-testid="line">
        15 anos · <BeltInText belt={belt('Verde')} text="Grau na faixa Verde (rumo à Roxa)" />
      </p>,
    );
    const line = screen.getByTestId('line');
    expect(line).toHaveTextContent(/^15 anos · Grau na faixa Verde \(rumo à Roxa\)$/);
    const [selo] = selos();
    expect(selo).toHaveAttribute('data-size', 'header');
    expect(selo).toHaveAttribute('aria-hidden', 'true');
    // The text stays whole in one element, right after the belt (screen readers and
    // `getByText` read it as before).
    const text = selo!.nextElementSibling!;
    expect(screen.getByText('Grau na faixa Verde (rumo à Roxa)')).toBe(text);
    // No line break between the belt and the text (their nearest common ancestor is `nowrap`);
    // inside the text, the usual breaks.
    const wrapper = selo!.parentElement!;
    expect(text.parentElement).toBe(wrapper);
    const styles = await Styles.now();
    expect(value(styles, wrapper, 'white-space')).toBe('nowrap');
    expect(value(styles, text, 'white-space')).toBe('normal');
    expect(value(styles, selo!, 'margin-inline-end')).toBe('8px');
  });

  it('título de uma palavra só e título sem faixa: o texto continua igual', () => {
    renderInTheme(
      'dark',
      <>
        <p data-testid="one">
          <BeltInText belt={belt('Roxa')} text="Grau" />
        </p>
        <p data-testid="none">
          15 anos · <BeltInText belt={undefined} text="Grau (rumo à Roxa)" />
        </p>
      </>,
    );
    expect(screen.getByTestId('one')).toHaveTextContent(/^Grau$/);
    expect(within(screen.getByTestId('one')).getByTestId('belt-swatch')).toBeInTheDocument();
    expect(screen.getByTestId('none')).toHaveTextContent(/^15 anos · Grau \(rumo à Roxa\)$/);
    expect(within(screen.getByTestId('none')).queryByTestId('belt-swatch')).toBeNull();
  });
});

describe.each<Scheme>(['light', 'dark'])('selo de faixa no tema %s (#166)', (scheme) => {
  it('contorno na cor do texto secundário do tema, ≥ 3:1 na página, no cartão e na linha em hover', async () => {
    renderInTheme(
      scheme,
      <>
        <div data-testid="page">
          <MiniBelt belt={belt('Branca')} />
          <MiniBelt belt={BLACK} size="header" />
        </div>
        <Card withBorder data-testid="card">
          <MiniBelt belt={belt('Branca')} />
          <MiniBelt belt={BLACK} />
        </Card>
        <Table highlightOnHover>
          <Table.Tbody>
            <Table.Tr data-testid="row">
              <Table.Td>
                <NamedBelt belt={belt('Branca')}>Branca</NamedBelt>
              </Table.Td>
              <Table.Td>
                <NamedBelt belt={BLACK}>Preta</NamedBelt>
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </>,
    );
    const row = screen.getByTestId('row');
    const styles = await Styles.now({ hover: row });
    const backgrounds = {
      page: styles.background(screen.getByTestId('page')),
      card: styles.background(screen.getByTestId('card')),
      row: styles.background(row),
    };
    // The hover really paints the row (gray.1 / dark.5), not the page behind it.
    expect(hex(backgrounds.row)).toBe(
      (scheme === 'light' ? colors.gray[1] : colors.dark[5]).toLowerCase(),
    );
    const areas = [
      ['page', backgrounds.page],
      ['card', backgrounds.card],
      ['row', backgrounds.row],
    ] as const;
    for (const [area, background] of areas) {
      const container = screen.getByTestId(area);
      for (const selo of within(container).getAllByTestId('belt-swatch')) {
        const outline = styles.borderColor(selo);
        expect(hex(outline)).toBe(DIMMED[scheme]);
        expectContrast(
          `contorno da faixa ${hexOf(selo.style.backgroundColor)} (${area}, tema ${scheme})`,
          outline,
          background,
          MIN_INDICATOR,
        );
      }
    }
  });

  it('a faixa branca aparece no claro e a preta no escuro pelo contorno, não pela cor da faixa', async () => {
    const own = scheme === 'light' ? belt('Branca') : BLACK;
    renderInTheme(scheme, <MiniBelt belt={own} />);
    const [selo] = selos();
    const styles = await Styles.now();
    const page = styles.background(selo!.parentElement!);
    // The belt alone would vanish on the page (white on white, black on charcoal)...
    const body = hexOf(selo!.style.backgroundColor);
    const bodyRgb = [1, 3, 5].map((start) => parseInt(body.slice(start, start + 2), 16)) as [
      number,
      number,
      number,
    ];
    expect(contrast(bodyRgb, page)).toBeLessThan(MIN_INDICATOR);
    // ...and the outline draws its edge.
    expectContrast('contorno da faixa', styles.borderColor(selo!), page, MIN_INDICATOR);
  });
});
