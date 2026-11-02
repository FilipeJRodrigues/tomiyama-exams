/**
 * Contraste (§ 6.7: 4,5:1 para texto, 3:1 para indicadores) das combinações que a base usa,
 * medidas com o `variantColorResolver` do Mantine nos dois temas: botões `filled`,
 * `outline` e `subtle` da cor primária (com hover), botão `default`, `dimmed` (também a
 * descrição dos campos), link, avisos `light` vermelho e laranja e o anel de foco.
 * Cores translúcidas (hover do `outline`) são compostas sobre o fundo da página.
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
  'contraste das combinações usadas no tema %s',
  (scheme) => {
    const vars = variables(scheme);
    const r = (value: string) => resolve(value, vars);
    const body = r('var(--mantine-color-body)');
    const field = r('var(--mantine-color-default)');

    it.each(['filled', 'outline', 'subtle'] as const)(
      'botão %s da cor primária, com hover',
      (variant) => {
        const v = appTheme.variantColorResolver({ color: 'blue', theme: appTheme, variant });
        const bg = v.background === 'transparent' ? body : over(r(v.background), body);
        const hover = v.hover === 'transparent' ? body : over(r(v.hover), body);
        expect(contrastRatio(r(v.color), bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(r(v.color), hover)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it('botão default (Sair, tema), com hover', () => {
      const v = appTheme.variantColorResolver({
        color: 'blue',
        theme: appTheme,
        variant: 'default',
      });
      expect(contrastRatio(r(v.color), r(v.background))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r(v.color), r(v.hover))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['red', 'orange'])('aviso light %s (Alert, Badge), com hover', (color) => {
      const v = appTheme.variantColorResolver({ color, theme: appTheme, variant: 'light' });
      expect(contrastRatio(r(v.color), over(r(v.background), body))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(r(v.color), over(r(v.hover), body))).toBeGreaterThanOrEqual(4.5);
    });

    it('dimmed sobre a página e sobre o campo (descrição dos inputs)', () => {
      const dimmed = r('var(--mantine-color-dimmed)');
      expect(contrastRatio(dimmed, body)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dimmed, field)).toBeGreaterThanOrEqual(4.5);
    });

    it('link sobre a página', () => {
      expect(contrastRatio(r('var(--mantine-color-anchor)'), body)).toBeGreaterThanOrEqual(4.5);
    });

    it('anel de foco (contorno afastado do controle) sobre a página', () => {
      const ring = r('var(--mantine-primary-color-filled)');
      expect(contrastRatio(ring, body)).toBeGreaterThanOrEqual(3);
    });
  },
);
