/**
 * Cobertura do #166 (paleta Tomiyama; § 6.7): link e anel de foco dentro dos alertas `light`
 * das cores que o app usa (vermelho, laranja, verde, cinza e a cor principal), nos dois temas.
 * O `theme-palette.test.ts` mede o título e a mensagem dos alertas; aqui, o que fica dentro
 * deles: o link "Abrir configurações da academia" no aviso de sensei (laranja) e o anel de foco
 * de links e botões ("Tentar de novo"), sobre o fundo do alerta.
 *
 * Medidas com as escalas de 2026-11-15: link de 9,61:1 a 16,24:1 e anel de 6,47:1 a 15,22:1 no
 * escuro (o menor, sobre o fundo oliva do amarelo); no claro, ambos de 10,16:1 a 12,97:1.
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { contrastRatio, cssVariablesResolver, theme } from '../../src/app/theme';

type Scheme = 'light' | 'dark';

const MIN_TEXT = 4.5;
const MIN_INDICATOR = 3;

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

/** The `light` alert colors used by the screens. */
const ALERT_COLORS = ['red', 'orange', 'green', 'gray', 'primary'] as const;

describe.each<Scheme>(['light', 'dark'])('dentro dos alertas light no tema %s (#166)', (scheme) => {
  const vars = variables(scheme);
  const r = (value: string) => resolve(value, vars);

  it.each(ALERT_COLORS)('alerta %s: link com 4,5:1 e anel de foco com 3:1', (color) => {
    const { background } = appTheme.variantColorResolver({
      color,
      theme: appTheme,
      variant: 'light',
    });
    // Solid in both schemes (shade 1, or shade 9 darkened by 50%): the page does not show.
    const bg = r(background);
    expect(bg).toMatch(/^(#[0-9a-f]{6}|rgba?\([\d\s.,]+\))$/i);
    expect(contrastRatio(r('var(--mantine-color-anchor)'), bg)).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(contrastRatio(r('var(--app-focus-ring)'), bg)).toBeGreaterThanOrEqual(MIN_INDICATOR);
  });
});
