/**
 * Cobertura do #65 (§ 6.7: 3:1 para indicadores): o anel de foco e a borda dos campos têm
 * cor própria (`--app-focus-ring` e `--app-control-border`, do `cssVariablesResolver`), que o
 * `a11y.css` aplica (a borda de controle, nome dado na paleta Tomiyama do #166, vale também
 * para os botões `default`). `theme-contrast-usage.test.ts` mede o anel pela cor primária
 * preenchida, que deixou de ser a cor do anel; aqui a medida é a das variáveis que o app
 * usa de fato, contra cada fundo em que o anel e a borda são desenhados: a página, o
 * cartão, o diálogo, o campo e os avisos coloridos.
 *
 * Os valores medidos em Chromium (2026-11-11), antes da paleta Tomiyama: anel 5,02:1 (claro) e
 * de 5,49:1 a 6,27:1 (escuro); borda em repouso 3,32:1 (claro) e de 3,53:1 a 4,04:1 (escuro).
 * Com a paleta (#166, calculados pelo tema): anel 14,42:1 (claro) e 11,73:1 a 13,93:1
 * (escuro); borda em repouso 4,29:1 (claro) e 4,43:1 a 5,26:1 (escuro).
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { BRAND_COLORS, contrastRatio, cssVariablesResolver, theme } from '../../src/app/theme';
import main from '../../src/main.tsx?raw';

type Scheme = 'light' | 'dark';

const MIN_INDICATOR = 3;
const MIN_TEXT = 4.5;

const appTheme: MantineTheme = mergeMantineTheme(DEFAULT_THEME, theme);

function variables(scheme: Scheme): Record<string, string> {
  const base = defaultCssVariablesResolver(appTheme);
  const app = cssVariablesResolver(appTheme);
  return { ...base.variables, ...base[scheme], ...app.variables, ...app[scheme] };
}

function resolve(value: string, vars: Record<string, string>, depth = 0): string {
  const match = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!match) return value.trim();
  const name = match[1] ?? '';
  const next = vars[name];
  if (next === undefined || depth > 10) throw new Error(`Variável sem valor: ${name}`);
  return resolve(next, vars, depth + 1);
}

function channels(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const d = hex[1] ?? '';
    const full = d.length === 3 ? d.replace(/./g, (c) => c + c) : d;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).concat(1) as [
      number,
      number,
      number,
      number,
    ];
  }
  const fn = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/i.exec(color);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] ? Number(fn[4]) : 1];
  throw new Error(`Cor não reconhecida: ${color}`);
}

/** Composes a possibly translucent color over an opaque background. */
function over(color: string, background: string): string {
  const [r, g, b, a] = channels(color);
  const [br, bg, bb] = channels(background);
  const mix = (top: number, bottom: number) => Math.round(top * a + bottom * (1 - a));
  return `rgb(${String(mix(r, br))}, ${String(mix(g, bg))}, ${String(mix(b, bb))})`;
}

describe.each<Scheme>(['light', 'dark'])(
  '#65 cor própria do anel de foco e da borda dos campos no tema %s (§ 6.7)',
  (scheme) => {
    const vars = variables(scheme);
    const r = (value: string) => resolve(value, vars);
    const body = r('var(--mantine-color-body)');
    // Card, Paper and dialogs: the surface of the theme (#166), white / dark.6.
    const card = r('var(--app-surface)');
    // Default-variant field: `--input-bg` is white / dark.6 (Mantine's CSS).
    const field = r(
      scheme === 'light' ? 'var(--mantine-color-white)' : 'var(--mantine-color-dark-6)',
    );

    /** Where a ring or a field border is drawn in the app. */
    const surfaces: [string, string][] = [
      ['a página', body],
      ['o cartão e o diálogo', card],
    ];

    it('o tema define as duas variáveis', () => {
      expect(vars['--app-focus-ring']).toMatch(/^#[0-9a-f]{6}$/i);
      expect(vars['--app-control-border']).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it.each(surfaces)('anel de foco sobre %s com pelo menos 3:1', (_name, background) => {
      expect(contrastRatio(r('var(--app-focus-ring)'), background)).toBeGreaterThanOrEqual(
        MIN_INDICATOR,
      );
    });

    it.each(['red', 'orange', 'blue', 'green', 'yellow'])(
      'anel de foco dentro de um aviso light %s com pelo menos 3:1',
      (color) => {
        const v = appTheme.variantColorResolver({ color, theme: appTheme, variant: 'light' });
        const alert = over(r(v.background), body);
        expect(contrastRatio(r('var(--app-focus-ring)'), alert)).toBeGreaterThanOrEqual(
          MIN_INDICATOR,
        );
      },
    );

    it.each(surfaces)('borda do campo em repouso sobre %s com pelo menos 3:1', (_name, bg) => {
      expect(contrastRatio(r('var(--app-control-border)'), bg)).toBeGreaterThanOrEqual(
        MIN_INDICATOR,
      );
    });

    it('borda do campo com foco (a cor do anel) sobre o campo e em volta dele', () => {
      const ring = r('var(--app-focus-ring)');
      expect(contrastRatio(ring, field)).toBeGreaterThanOrEqual(MIN_INDICATOR);
      expect(contrastRatio(ring, body)).toBeGreaterThanOrEqual(MIN_INDICATOR);
    });

    it('borda do campo com erro sobre o campo e em volta dele', () => {
      const error = r('var(--mantine-color-error)');
      expect(contrastRatio(error, field)).toBeGreaterThanOrEqual(MIN_INDICATOR);
      expect(contrastRatio(error, body)).toBeGreaterThanOrEqual(MIN_INDICATOR);
    });

    // #166: the filled primary is the color of the logo of each scheme (blue / yellow), with
    // its own text color (white / blue), instead of blue.8 with white text.
    it('a cor primária preenchida é a do logo, com o texto dos botões a 4,5:1', () => {
      const filled = r('var(--mantine-primary-color-filled)');
      const text = r('var(--mantine-color-primary-contrast)');
      expect(filled).toBe(scheme === 'light' ? BRAND_COLORS.blue : BRAND_COLORS.yellow);
      expect(text).toBe(scheme === 'light' ? r('var(--mantine-color-white)') : BRAND_COLORS.blue);
      expect(contrastRatio(text, filled)).toBeGreaterThanOrEqual(MIN_TEXT);
    });
  },
);

// The cascade itself (which rule wins on the focused control and on the field) is measured
// by the 65-* regression tests; here only the import order the cascade depends on.
describe('#65 o CSS do app entra depois do CSS do Mantine', () => {
  it('main.tsx importa o a11y.css depois dos estilos do Mantine', () => {
    const mantine = main.indexOf("'@mantine/core/styles.css'");
    const app = main.indexOf("'./app/a11y.css'");
    expect(mantine).toBeGreaterThanOrEqual(0);
    expect(app).toBeGreaterThan(mantine);
  });
});
