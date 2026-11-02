import {
  DEFAULT_THEME,
  darken,
  defaultCssVariablesResolver,
  isVirtualColor,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { contrastRatio, cssVariablesResolver, theme } from '../../src/app/theme';

type Scheme = 'light' | 'dark';

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

const colorNames = Object.entries(appTheme.colors)
  .filter(([, shades]) => !isVirtualColor(shades))
  .map(([name]) => name);

describe('contraste da variante light em todas as cores (§ 6.7)', () => {
  describe.each(colorNames)('%s', (name) => {
    const shades = appTheme.colors[name];
    if (!shades) throw new Error(name);

    it('tema claro: texto sobre o fundo normal e o de hover', () => {
      const color = resolve(`var(--mantine-color-${name}-light-color)`, variables('light'));
      expect(contrastRatio(color, shades[1])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(color, shades[2])).toBeGreaterThanOrEqual(4.5);
    });

    it('tema escuro: texto sobre o fundo normal e o de hover', () => {
      const color = resolve(`var(--mantine-color-${name}-light-color)`, variables('dark'));
      expect(contrastRatio(color, darken(shades[9], 0.5))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(color, darken(shades[9], 0.3))).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('alert vermelho (§ 6.7)', () => {
  it('não fica abaixo do valor anterior (4,51:1) no tema claro', () => {
    const color = resolve('var(--mantine-color-red-light-color)', variables('light'));
    const background = resolve('var(--mantine-color-red-light)', variables('light'));
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.51);
  });
});

describe('cor de erro sobre os fundos de campo (§ 6.7)', () => {
  it.each<[Scheme, string]>([
    ['light', 'var(--mantine-color-body)'],
    ['dark', 'var(--mantine-color-body)'],
    ['dark', 'var(--mantine-color-default)'],
  ])('tema %s sobre %s', (scheme, background) => {
    const vars = variables(scheme);
    const error = resolve('var(--mantine-color-error)', vars);
    expect(contrastRatio(error, resolve(background, vars))).toBeGreaterThanOrEqual(4.5);
  });
});
