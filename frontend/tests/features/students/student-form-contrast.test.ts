/**
 * Contrast (§ 6.7: 4.5:1 for text) of the colors the student form adds, in both themes:
 * the "Excluir" confirmation (`filled` red.9, with hover), "Excluir aluno" (`light` red,
 * with hover) and the saved notice (`light` green Alert).
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { contrastRatio, cssVariablesResolver, theme } from '../../../src/app/theme';

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

function channels(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const short = hex[1] ?? '';
    const d = short.length === 3 ? short.replace(/./g, (c) => c + c) : short;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(d.slice(i, i + 2), 16));
    return [r ?? 0, g ?? 0, b ?? 0, 1];
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

describe.each<Scheme>(['light', 'dark'])('student form contrast, %s theme', (scheme) => {
  const vars = variables(scheme);
  const r = (value: string) => resolve(value, vars);
  const body = r('var(--mantine-color-body)');

  it.each([
    { variant: 'filled', color: 'red.9', where: '"Excluir" in the dialog' },
    { variant: 'light', color: 'red', where: '"Excluir aluno"' },
    { variant: 'light', color: 'green', where: 'saved notice' },
  ] as const)('$variant $color ($where), with hover', ({ variant, color }) => {
    const v = appTheme.variantColorResolver({ color, theme: appTheme, variant });
    expect(contrastRatio(r(v.color), over(r(v.background), body))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(r(v.color), over(r(v.hover), body))).toBeGreaterThanOrEqual(4.5);
  });
});
