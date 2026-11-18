/**
 * Cobertura do qa-frontend no reteste da etapa 1b do #166 (skill `tomiyama-design`,
 * `components.md`; § 6.4, § 6.7), além de `theme-shape.test.tsx`:
 *
 * Lá, a gaveta "Decidir o exame" é uma cópia com os `styles` do `ExamSummary`. Aqui é a gaveta
 * real, aberta pelo "Decidir" da barra do resumo, no celular (390 px) e no zoom de 200% de
 * um notebook (640 px), nos dois temas: os cantos de cima com o raio `lg` e os de baixo, presos
 * à borda da tela, retos. Se a tela um dia passar um `radius` ou um `borderRadius` próprio, ou
 * mudar a posição da gaveta, este teste avisa. No Edge, a 390, 640 e 768 px e a 640 x 422 e
 * 320 x 568, foi o que se viu: os cantos de baixo na cor da gaveta, sem a camada escura.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath } from '../../src/app/navigation';
import { COLOR_SCHEME_KEY } from '../../src/app/theme';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { Styles, loadStyles } from '../computedCss';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

/** Present at the open event, exam in progress. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

/** Logical longhand of each corner, in a left-to-right page. */
const LOGICAL: Record<(typeof CORNERS)[number], string> = {
  'top-left': 'border-start-start-radius',
  'top-right': 'border-start-end-radius',
  'bottom-right': 'border-end-end-radius',
  'bottom-left': 'border-end-start-radius',
};

/** `calc(1rem * 1)`, `16px` or `0` in px. */
function toPx(value: string): number {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '0') return 0;
  const px = /^(-?[\d.]+)px$/.exec(text);
  if (px) return Number(px[1]);
  const rem = /^(-?[\d.]+)rem$/.exec(text);
  if (rem) return Number(rem[1]) * 16;
  const scaled = /^calc\((-?[\d.]+)rem \* ([\d.]+)\)$/.exec(text);
  if (scaled) return Number(scaled[1]) * 16 * Number(scaled[2]);
  throw new Error(`Raio não reconhecido: "${value}"`);
}

/** Split at spaces outside parentheses. */
function tokens(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value.trim()) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && /\s/.test(char)) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Horizontal radius of each corner (top-left, top-right, bottom-right, bottom-left), in px. */
function cornersOf(styles: Styles, target: Element): number[] {
  return CORNERS.map((corner, index) => {
    const winner = styles.declared(target, [
      'border-radius',
      `border-${corner}-radius`,
      LOGICAL[corner],
    ]);
    if (winner === null) return 0;
    const values = tokens(styles.resolve(target, winner.value));
    if (winner.prop !== 'border-radius') return toPx(values[0] ?? '');
    const slash = values.indexOf('/');
    const [a = '', b = a, c = a, d = b] = slash === -1 ? values : values.slice(0, slash);
    return toPx([a, b, c, d][index] ?? '');
  });
}

beforeAll(loadStyles);

describe.each(['dark', 'light'] as const)(
  'gaveta "Decidir o exame" real no tema %s (#166, § 6.4, § 6.7, qa)',
  (scheme) => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
      const db = createMockDb({ includeShowcase: true });
      db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
      server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
      window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
    });

    afterEach(() => {
      vi.useRealTimers();
      window.localStorage.removeItem(COLOR_SCHEME_KEY);
    });

    it.each([390, 640])(
      'a %i px: cantos de cima lg e os de baixo, presos à borda da tela, retos',
      async (width) => {
        setViewportWidth(width);
        const { user } = await renderApp({
          route: examPath(MOCK_EVENT_IDS.open, HELENA),
          signedInAs: 'examiner',
        });
        await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
        const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
        await user.click(await within(summary).findByRole('button', { name: 'Decidir' }));
        const drawer = await screen.findByRole('dialog', { name: 'Decidir o exame' });
        // The footer is still there, inside the drawer.
        expect(within(drawer).getByRole('button', { name: 'Aprovar' })).toBeInTheDocument();
        expect(within(drawer).getByRole('button', { name: 'Reprovar' })).toBeInTheDocument();

        const styles = await Styles.now();
        const lg = toPx(styles.resolve(drawer, 'var(--mantine-radius-lg)'));
        expect(lg).toBe(16);
        expect(cornersOf(styles, drawer)).toEqual([lg, lg, 0, 0]);
      },
    );
  },
);
