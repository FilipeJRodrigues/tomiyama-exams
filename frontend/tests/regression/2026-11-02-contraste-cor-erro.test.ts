/**
 * Erro: a cor de erro do Mantine (`--mantine-color-error`) fica abaixo de 4,5:1 sobre o
 * fundo da página: `red.6` (#fa5252) sobre branco dá 3,28:1 no tema claro e `red.8`
 * (#e03131) sobre `dark.7` (#242424) dá 3,44:1 no tema escuro. É a cor do asterisco que
 * marca os campos obrigatórios ("E-mail *", "Senha *", "Nova senha *", "Confirme a
 * senha *") e das mensagens de erro de campo (`error` dos inputs), que as próximas telas
 * vão usar. O `cssVariablesResolver` ajustou `dimmed` e os `*-light-color`, mas não esta.
 * Esperado: texto com contraste mínimo de 4,5:1 nos dois temas (§ 6.7; critério 7 do PR).
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

describe.each<Scheme>(['light', 'dark'])('cor de erro no tema %s (§ 6.7)', (scheme) => {
  const vars = variables(scheme);

  it('asterisco de obrigatório e erro de campo sobre o fundo da página', () => {
    const error = resolve('var(--mantine-color-error)', vars);
    const body = resolve('var(--mantine-color-body)', vars);
    expect(contrast(error, body)).toBeGreaterThanOrEqual(4.5);
  });
});
