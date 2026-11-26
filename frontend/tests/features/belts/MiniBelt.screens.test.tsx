/**
 * A mini faixa nas telas (#166, etapa 4): Alunos (§ 6.2), Dia do exame (§ 6.3) e Faixas (§ 6.5),
 * na tabela (1280 px) e nos cartões (390 px), e no cabeçalho do exame do aluno (§ 6.4), sempre
 * ao lado do nome da faixa escrito e com as cores da faixa. Nos dois temas, o contorno fica a
 * 3:1 ou mais do fundo atrás dele, em repouso e com o item em hover (`tests/computedCss.ts`).
 */
import { screen, within } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Belt } from '../../../src/api/types';
import { examPath } from '../../../src/app/navigation';
import { COLOR_SCHEME_KEY } from '../../../src/app/theme';
import { BELT_TIP_PERCENT } from '../../../src/features/belts/beltGeometry';
import { createMockDb, MOCK_EVENT_IDS, mockBelts } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { Styles, expectContrast, loadStyles } from '../../computedCss';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import { beltStops } from './miniBeltHelpers';

type Scheme = 'light' | 'dark';
type Layout = 'tabela' | 'cartões';

const MIN_INDICATOR = 3;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';

const SCREENS = [
  { name: 'Alunos (§ 6.2)', route: '/alunos', list: 'Alunos', column: 'Faixa atual' },
  {
    name: 'Dia do exame (§ 6.3)',
    route: '/dia-do-exame',
    list: 'Alunos do evento',
    column: 'Faixa atual',
  },
  { name: 'Faixas (§ 6.5)', route: '/faixas', list: 'Faixas', column: 'Faixa' },
] as const;

type ScreenCase = (typeof SCREENS)[number];

const LAYOUTS = [
  { layout: 'tabela', width: 1280 },
  { layout: 'cartões', width: 390 },
] as const;

function beltNamed(name: string): Belt {
  const found = mockBelts.find((belt) => belt.name === name);
  if (!found) throw new Error(`Faixa ${name} fora da base simulada.`);
  return found;
}

/** What the mini belt of a belt paints: the body, and the tips of a two-color belt. */
function expectedStops(belt: Belt): [string, number, number][] {
  const body = belt.color_primary.toLowerCase();
  const tips = belt.color_secondary?.toLowerCase();
  if (!tips) return [[body, 0, 100]];
  return [
    [tips, 0, BELT_TIP_PERCENT],
    [body, BELT_TIP_PERCENT, 100 - BELT_TIP_PERCENT],
    [tips, 100 - BELT_TIP_PERCENT, 100],
  ];
}

async function open(route: string, width: number, scheme: Scheme) {
  window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  setViewportWidth(width);
  await renderApp({ route, signedInAs: 'examiner' });
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
}

/** The items of the list: the body rows of the table or the cards. */
async function itemsOf(layout: Layout, list: string): Promise<HTMLElement[]> {
  if (layout === 'tabela') {
    const table = await screen.findByRole('table', { name: list });
    return within(table).getAllByRole('row').slice(1);
  }
  const cards = await screen.findByRole('list', { name: list });
  return within(cards).getAllByRole('listitem');
}

/** Where the item writes its belt: the column of the table, the field or the title of the card. */
function beltPlace(item: HTMLElement, layout: Layout, column: string): HTMLElement {
  if (layout === 'tabela') {
    const table = item.closest('table')!;
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent.trim());
    const cell = item.children[headers.indexOf(column)];
    if (!(cell instanceof HTMLElement)) throw new Error(`Coluna ${column} fora da linha.`);
    return cell;
  }
  if (column === 'Faixa') return within(item).getByRole('heading', { level: 2 });
  const label = within(item)
    .getAllByRole('term')
    .find((term) => term.textContent.trim() === column);
  const value = label?.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`Campo ${column} fora do cartão.`);
  return value;
}

function onlySelo(place: HTMLElement): HTMLElement {
  const selos = within(place).getAllByTestId('belt-swatch');
  expect(selos).toHaveLength(1);
  return selos[0]!;
}

beforeAll(loadStyles);

describe.each<ScreenCase>(SCREENS)('mini faixa na tela $name (#166)', (screenCase) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(LAYOUTS)('$layout ($width px)', ({ layout, width }) => {
    it('selo de lista em cada item, antes do nome da faixa escrito, nas cores da faixa', async () => {
      await open(screenCase.route, width, 'dark');
      const items = await itemsOf(layout, screenCase.list);
      expect(items.length).toBeGreaterThan(3);
      const seen = new Set<boolean>();
      for (const item of items) {
        const place = beltPlace(item, layout, screenCase.column);
        const selo = await within(place).findByTestId('belt-swatch');
        expect(onlySelo(place)).toBe(selo);
        expect(selo).toHaveAttribute('aria-hidden', 'true');
        expect(selo).toHaveAttribute('data-size', 'list');
        // The name is written right after the belt, and the place reads only the name.
        const label = selo.nextElementSibling?.textContent.trim() ?? '';
        expect(label).not.toBe('');
        expect(place.textContent.trim()).toBe(label);
        const belt = beltNamed(label.split(' · ')[0] ?? '');
        expect(beltStops(selo)).toEqual(expectedStops(belt));
        seen.add(belt.color_secondary !== null);
      }
      // Both kinds show up: two-color belts with tips and plain ones without.
      expect([...seen].sort()).toEqual([false, true]);
    });
  });

  describe.each<Scheme>(['light', 'dark'])('tema %s', (scheme) => {
    it.each(LAYOUTS)(
      'contorno ≥ 3:1 em repouso e em hover ($layout, $width px)',
      async ({ layout, width }) => {
        await open(screenCase.route, width, scheme);
        const items = await itemsOf(layout, screenCase.list);
        await within(items[0]!).findAllByTestId('belt-swatch');
        for (const item of items) {
          const selo = onlySelo(beltPlace(item, layout, screenCase.column));
          for (const hovered of [false, true]) {
            const styles = await Styles.now(hovered ? { hover: item } : {});
            expectContrast(
              `contorno da faixa em ${screenCase.name}, ${layout}${hovered ? ' em hover' : ''}`,
              styles.borderColor(selo),
              styles.background(selo.parentElement!),
              MIN_INDICATOR,
            );
          }
        }
      },
    );
  });
});

describe('mini faixa no cabeçalho do exame do aluno (§ 6.4, #166)', () => {
  const BELTS_URL = `${TEST_API_URL}/belts`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function headerSelo(): Promise<HTMLElement> {
    const meta = await screen.findByTestId('exam-meta');
    const selos = await within(meta).findAllByTestId('belt-swatch');
    expect(selos).toHaveLength(1);
    return selos[0]!;
  }

  it('exame de faixa: selo maior da faixa-alvo antes de "Faixa Marrom", na mesma linha', async () => {
    await open(examPath(MOCK_EVENT_IDS.open, HELENA), 1280, 'dark');
    const selo = await headerSelo();
    expect(selo).toHaveAttribute('aria-hidden', 'true');
    expect(selo).toHaveAttribute('data-size', 'header');
    expect(beltStops(selo)).toEqual(expectedStops(beltNamed('Marrom')));
    expect(selo.nextElementSibling).toHaveTextContent(/^Faixa Marrom$/);
    // The line reads as before: the belt adds no text.
    expect(screen.getByTestId('exam-meta')).toHaveTextContent(/^15 anos · Faixa Marrom$/);
  });

  it('rn004 exame de grau: selo da faixa do grau, antes de "Grau na faixa Verde"', async () => {
    await open(examPath(MOCK_EVENT_IDS.closed, ELIDA), 390, 'light');
    const selo = await headerSelo();
    expect(selo).toHaveAttribute('data-size', 'header');
    expect(beltStops(selo)).toEqual(expectedStops(beltNamed('Verde')));
    expect(selo.nextElementSibling).toHaveTextContent(/^Grau na faixa Verde \(rumo à Roxa\)$/);
    expect(screen.getByTestId('exam-meta')).toHaveTextContent(
      /^15 anos · Grau na faixa Verde \(rumo à Roxa\)$/,
    );
  });

  it('grau com as faixas carregando: sem selo até o título nomear a faixa', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(BELTS_URL, async () => {
        await gate;
        return undefined;
      }),
    );
    await open(examPath(MOCK_EVENT_IDS.closed, ELIDA), 1280, 'dark');
    const meta = await screen.findByTestId('exam-meta');
    expect(meta).toHaveTextContent(/^15 anos · Grau \(rumo à Roxa\)$/);
    expect(within(meta).queryByTestId('belt-swatch')).toBeNull();
    release();
    const selo = await headerSelo();
    expect(beltStops(selo)).toEqual(expectedStops(beltNamed('Verde')));
  });

  describe.each<Scheme>(['light', 'dark'])('tema %s', (scheme) => {
    it.each([390, 1280])('contorno ≥ 3:1 sobre o fundo da página (%i px)', async (width) => {
      await open(examPath(MOCK_EVENT_IDS.open, HELENA), width, scheme);
      const selo = await headerSelo();
      const styles = await Styles.now();
      expectContrast(
        `contorno da faixa no cabeçalho do exame, tema ${scheme}`,
        styles.borderColor(selo),
        styles.background(selo.parentElement!),
        MIN_INDICATOR,
      );
    });
  });
});
