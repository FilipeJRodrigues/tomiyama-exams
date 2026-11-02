/**
 * Erro: no tema claro, a cor primária usada pelo Mantine é `blue.6` (#228be6). Isso dá
 * 3,56:1 para o texto branco dos botões preenchidos ("Entrar", "Salvar senha e entrar",
 * "Criar conta") e 3,56:1 para os links sobre o fundo branco ("Cadastre-se", "Entrar",
 * "Meus alunos"). O aviso laranja "Dados simulados" (Badge e Alert `light`) fica em
 * 3,62:1 (`orange.9` sobre `orange.1`). O tema só corrigiu a cor `dimmed`.
 * Esperado: texto com contraste mínimo de 4,5:1 nos dois temas (§ 6.7; critério 7 do PR).
 * Issue: -
 *
 * O teste resolve as variáveis CSS do Mantine com o tema e o `cssVariablesResolver` da
 * aplicação, do mesmo jeito que o `MantineProvider` faz.
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

/** Follow `var(--x)` until a color literal. */
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

function variant(color: string, name: 'filled' | 'light') {
  return appTheme.variantColorResolver({ color, theme: appTheme, variant: name });
}

describe.each<Scheme>(['light', 'dark'])('contraste de texto no tema %s (§ 6.7)', (scheme) => {
  const vars = variables(scheme);
  const body = resolve('var(--mantine-color-body)', vars);

  it('botão preenchido da cor primária', () => {
    const filled = variant(appTheme.primaryColor, 'filled');
    const ratio = contrast(resolve(filled.color, vars), resolve(filled.background, vars));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('link sobre o fundo da página', () => {
    const ratio = contrast(resolve('var(--mantine-color-anchor)', vars), body);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('aviso laranja "Dados simulados" (variante light)', () => {
    const light = variant('orange', 'light');
    const ratio = contrast(resolve(light.color, vars), resolve(light.background, vars));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
