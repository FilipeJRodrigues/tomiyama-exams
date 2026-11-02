/**
 * Erro: no tema claro, o item ativo do menu lateral (NavLink com `aria-current="page"`,
 * variante `light` da cor primária) fica com texto `blue.9` (#1864ab) sobre `blue.2`
 * (#a5d8ff) quando o mouse passa por cima: 4,02:1. Sem hover é 4,93:1. O
 * `cssVariablesResolver` só escureceu o `*-light-color` de teal, green, lime, yellow e
 * orange; o azul primário ficou de fora, e a troca para `primaryShade` 8 não muda essa
 * cor (a variante `light` usa sempre o tom 9).
 * Esperado: texto com contraste mínimo de 4,5:1 em todos os estados do controle,
 * inclusive hover, nos dois temas (§ 6.7; critério 7 do PR da base).
 * Issue: -
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { cssVariablesResolver, theme } from '../../src/app/theme';

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

function rgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const digits = hex[1] ?? '';
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  }
  const fn = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(color);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  throw new Error(`Cor não reconhecida: ${color}`);
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

describe.each<Scheme>(['light', 'dark'])('item ativo do menu no tema %s (§ 6.7)', (scheme) => {
  const vars = variables(scheme);
  // NavLink.module.css: `--nl-color` on `--nl-bg`, and `--nl-hover` on hover.
  const color = resolve('var(--mantine-primary-color-light-color)', vars);

  it('sem hover', () => {
    const background = resolve('var(--mantine-primary-color-light)', vars);
    expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('com hover', () => {
    const background = resolve('var(--mantine-primary-color-light-hover)', vars);
    expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
  });
});
