/**
 * Cobertura do #65 (§ 6.7: 3:1 para indicadores): o anel de foco e a borda dos campos têm
 * cor própria (`--app-focus-ring` e `--app-input-border`, do `cssVariablesResolver`), que o
 * `a11y.css` aplica. `theme-contrast-usage.test.ts` mede o anel pela cor primária
 * preenchida, que deixou de ser a cor do anel; aqui a medida é a das variáveis que o app
 * usa de fato, contra cada fundo em que o anel e a borda são desenhados: a página, o
 * cartão, o diálogo, o campo e os avisos coloridos.
 *
 * Os valores medidos em Chromium (2026-11-11) são os mesmos: anel 5,02:1 (claro) e de
 * 5,49:1 a 6,27:1 (escuro); borda em repouso 3,32:1 (claro) e de 3,53:1 a 4,04:1 (escuro).
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { contrastRatio, cssVariablesResolver, theme } from '../../src/app/theme';
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
    // Card and Paper: white in the light scheme, dark.6 in the dark one (Mantine's CSS).
    const card = scheme === 'light' ? r('var(--mantine-color-white)') : appTheme.colors.dark[6];
    // Default-variant field: `--input-bg` is white / dark.6 (Mantine's CSS).
    const field = card;

    /** Where a ring or a field border is drawn in the app. */
    const surfaces: [string, string][] = [
      ['a página e o diálogo', body],
      ['o cartão', card],
    ];

    it('o tema define as duas variáveis', () => {
      expect(vars['--app-focus-ring']).toMatch(/^#[0-9a-f]{6}$/i);
      expect(vars['--app-input-border']).toMatch(/^#[0-9a-f]{6}$/i);
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
      expect(contrastRatio(r('var(--app-input-border)'), bg)).toBeGreaterThanOrEqual(MIN_INDICATOR);
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

    it('a cor primária preenchida não mudou: texto branco dos botões com 4,5:1', () => {
      expect(r('var(--mantine-primary-color-filled)')).toBe(appTheme.colors.blue[8]);
      expect(
        contrastRatio(r('var(--mantine-color-white)'), r('var(--mantine-primary-color-filled)')),
      ).toBeGreaterThanOrEqual(MIN_TEXT);
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
