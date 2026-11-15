/**
 * Paleta Tomiyama (#166, etapa 1a; skill `tomiyama-design`, `colors.md`) e o § 6.7 (4,5:1 para
 * texto, 3:1 para indicadores) nos dois temas: as cores-base do logo no tom cheio, o escuro
 * em carvão, a cor principal virtual (azul no claro, amarelo no escuro) e o texto sobre ela,
 * as variáveis `light` da cor virtual corrigidas pela cor real de cada tema, erro e perigo,
 * sucesso, link, `outline`, borda de controle e anel de foco, medidos sobre a página, o
 * cartão, a linha de tabela em hover e o alerta vermelho `light`.
 *
 * As variáveis são resolvidas com o tema e o `cssVariablesResolver` do app, como faz o
 * `MantineProvider`; o que vence a cascata na tela montada fica em `theme-surfaces.test.tsx`.
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  isVirtualColor,
  luminance,
  mergeMantineTheme,
  type MantineColorsTuple,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { BRAND_COLORS, contrastRatio, cssVariablesResolver, theme } from '../../src/app/theme';

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

function same(a: string, b: string): boolean {
  return channels(a).join() === channels(b).join();
}

function shades(name: string): MantineColorsTuple {
  const tuple = appTheme.colors[name];
  if (!tuple) throw new Error(`Cor fora do tema: ${name}`);
  return tuple;
}

function filledShade(scheme: Scheme): number {
  const shade = appTheme.primaryShade;
  return typeof shade === 'number' ? shade : shade[scheme];
}

/** The real color behind the virtual primary in each scheme. */
const REAL_PRIMARY: Record<Scheme, string> = { light: 'tomiyama-blue', dark: 'tomiyama-yellow' };

describe('cores-base do logo no tom cheio (#166)', () => {
  it.each<[string, string, Scheme[]]>([
    ['tomiyama-blue', BRAND_COLORS.blue, ['light']],
    ['tomiyama-yellow', BRAND_COLORS.yellow, ['dark']],
    ['red', BRAND_COLORS.red, ['light', 'dark']],
    ['green', BRAND_COLORS.green, ['light', 'dark']],
  ])('%s tem %s no tom do botão cheio', (name, base, schemes) => {
    for (const scheme of schemes) {
      expect(shades(name)[filledShade(scheme)]).toBe(base);
      expect(resolve(`var(--mantine-color-${name}-filled)`, variables(scheme))).toBe(base);
    }
  });

  it.each(['tomiyama-blue', 'tomiyama-yellow', 'red', 'green', 'dark'])(
    'a escala %s vai do tom mais claro (0) ao mais escuro (9)',
    (name) => {
      const values = shades(name).map((shade) => luminance(shade));
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i]).toBeLessThan(values[i - 1] ?? Infinity);
      }
    },
  );
});

describe('cor principal virtual (#166)', () => {
  it('é azul no claro e amarelo no escuro', () => {
    const primary = shades(appTheme.primaryColor);
    expect(isVirtualColor(primary)).toBe(true);
    if (!isVirtualColor(primary)) return;
    expect(primary.light).toBe(REAL_PRIMARY.light);
    expect(primary.dark).toBe(REAL_PRIMARY.dark);
  });

  it.each<[Scheme, string]>([
    ['light', BRAND_COLORS.blue],
    ['dark', BRAND_COLORS.yellow],
  ])('tema %s: o tom cheio é a cor-base %s', (scheme, base) => {
    expect(resolve('var(--mantine-primary-color-filled)', variables(scheme))).toBe(base);
  });
});

describe.each<Scheme>(['light', 'dark'])('texto sobre a cor principal no tema %s', (scheme) => {
  const vars = variables(scheme);
  const r = (value: string) => resolve(value, vars);
  const filled = appTheme.variantColorResolver({
    color: appTheme.primaryColor,
    theme: appTheme,
    variant: 'filled',
  });
  // White on the blue; on the yellow, the blue of the logo (not white at 1.22:1 nor black).
  const expected = scheme === 'light' ? r('var(--mantine-color-white)') : BRAND_COLORS.blue;

  it('o botão cheio lê a cor de contraste da cor virtual', () => {
    expect(filled.color).toBe('var(--mantine-color-primary-contrast)');
    expect(r(filled.color)).toBe(expected);
    expect(r('var(--mantine-primary-color-contrast)')).toBe(expected);
  });

  it('texto do botão cheio com pelo menos 4,5:1, também no hover', () => {
    expect(contrastRatio(r(filled.color), r(filled.background))).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(contrastRatio(r(filled.color), r(filled.hover))).toBeGreaterThanOrEqual(MIN_TEXT);
  });

  it('ponto do Radio, ícone do Checkbox e polegar do Switch ligado: a mesma cor', () => {
    // `theme.ts` (Radio, Checkbox) and `a11y.css` (Switch) read this variable.
    expect(r('var(--mantine-color-primary-contrast)')).toBe(expected);
    expect(
      contrastRatio(expected, r('var(--mantine-primary-color-filled)')),
    ).toBeGreaterThanOrEqual(MIN_INDICATOR);
  });
});

describe.each<Scheme>(['light', 'dark'])(
  'variáveis light da cor principal no tema %s (NavLink ativo, Badge e Alert light)',
  (scheme) => {
    const vars = variables(scheme);
    const r = (value: string) => resolve(value, vars);
    const real = REAL_PRIMARY[scheme];

    it.each(['light', 'light-hover', 'light-color'])(
      '--mantine-color-primary-%s vem da cor real do tema, com a correção',
      (variable) => {
        expect(vars[`--mantine-color-primary-${variable}`]).toBe(
          `var(--mantine-color-${real}-${variable})`,
        );
        expect(r(`var(--mantine-color-primary-${variable})`)).toBe(
          r(`var(--mantine-color-${real}-${variable})`),
        );
      },
    );

    it('texto com pelo menos 4,5:1 sobre o fundo e o fundo de hover', () => {
      const color = r('var(--mantine-primary-color-light-color)');
      for (const background of ['light', 'light-hover']) {
        expect(
          contrastRatio(color, r(`var(--mantine-primary-color-${background})`)),
        ).toBeGreaterThanOrEqual(MIN_TEXT);
      }
    });
  },
);

describe('escuro em carvão e superfícies (#166)', () => {
  const dark = variables('dark');
  const light = variables('light');

  it('fundo da página #1C1C1C no escuro e branco no claro', () => {
    expect(resolve('var(--mantine-color-body)', dark)).toBe('#1C1C1C');
    expect(same(resolve('var(--mantine-color-body)', light), '#FFFFFF')).toBe(true);
  });

  it('superfície #2A2A2A (dark.6) no escuro e branca no claro', () => {
    expect(resolve('var(--app-surface)', dark)).toBe('#2A2A2A');
    expect(shades('dark')[6]).toBe('#2A2A2A');
    expect(same(resolve('var(--app-surface)', light), '#FFFFFF')).toBe(true);
  });

  it('hover #3B3B3B (dark.5), texto #C9C9C9 e dimmed #B8B8B8', () => {
    expect(shades('dark')[5]).toBe('#3B3B3B');
    expect(resolve('var(--mantine-color-text)', dark)).toBe('#C9C9C9');
    expect(resolve('var(--mantine-color-dimmed)', dark)).toBe('#B8B8B8');
  });

  it('o trilho dark.8 é mais escuro que o fundo da página', () => {
    expect(luminance(shades('dark')[8])).toBeLessThan(luminance(shades('dark')[7]));
  });
});

describe('cores fixas da skill (#166)', () => {
  it.each<[Scheme, string, string]>([
    ['light', '--mantine-color-error', BRAND_COLORS.red],
    ['dark', '--mantine-color-error', '#FF8577'],
    ['light', '--app-control-border', '#737B83'],
    ['dark', '--app-control-border', '#8F8F8F'],
    ['light', '--app-focus-ring', BRAND_COLORS.blue],
    ['dark', '--app-focus-ring', BRAND_COLORS.yellow],
  ])('tema %s: %s é %s', (scheme, variable, color) => {
    expect(resolve(`var(${variable})`, variables(scheme))).toBe(color);
  });

  it('o --app-input-border saiu (virou --app-control-border)', () => {
    expect(variables('light')['--app-input-border']).toBeUndefined();
    expect(variables('dark')['--app-input-border']).toBeUndefined();
  });
});

/** [what, foreground, background, minimum]; colors as CSS values of the scheme. */
type Pair = [string, string, string, number];

const PAIRS: Record<Scheme, Pair[]> = {
  light: [
    ['texto secundário', 'var(--mantine-color-dimmed)', 'var(--mantine-color-body)', MIN_TEXT],
    ['texto secundário', 'var(--mantine-color-dimmed)', 'var(--mantine-color-gray-1)', MIN_TEXT],
    ['erro', 'var(--mantine-color-error)', 'var(--mantine-color-body)', MIN_TEXT],
    ['erro', 'var(--mantine-color-error)', 'var(--mantine-color-gray-1)', MIN_TEXT],
    ['link', 'var(--mantine-color-anchor)', 'var(--mantine-color-body)', MIN_TEXT],
    ['link', 'var(--mantine-color-anchor)', 'var(--mantine-color-gray-0)', MIN_TEXT],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-red-filled)', MIN_TEXT],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-red-filled-hover)', 4.5],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-green-filled)', 4.5],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-green-filled-hover)', 4.5],
    ['borda de controle', 'var(--app-control-border)', 'var(--app-surface)', MIN_INDICATOR],
    ['borda de controle', 'var(--app-control-border)', 'var(--mantine-color-gray-1)', 3],
    ['borda de controle', 'var(--app-control-border)', 'var(--mantine-color-red-light)', 3],
    ['anel de foco', 'var(--app-focus-ring)', 'var(--mantine-color-body)', MIN_INDICATOR],
    ['anel de foco', 'var(--app-focus-ring)', 'var(--mantine-color-gray-1)', MIN_INDICATOR],
    ['anel de foco', 'var(--app-focus-ring)', 'var(--mantine-color-red-light)', MIN_INDICATOR],
  ],
  dark: [
    ['texto', 'var(--mantine-color-text)', 'var(--mantine-color-body)', MIN_TEXT],
    ['texto', 'var(--mantine-color-text)', 'var(--app-surface)', MIN_TEXT],
    ['texto', 'var(--mantine-color-text)', 'var(--mantine-color-dark-5)', MIN_TEXT],
    ['texto secundário', 'var(--mantine-color-dimmed)', 'var(--mantine-color-body)', MIN_TEXT],
    ['texto secundário', 'var(--mantine-color-dimmed)', 'var(--app-surface)', MIN_TEXT],
    ['texto secundário', 'var(--mantine-color-dimmed)', 'var(--mantine-color-dark-5)', 4.5],
    ['erro', 'var(--mantine-color-error)', 'var(--mantine-color-body)', MIN_TEXT],
    ['erro', 'var(--mantine-color-error)', 'var(--app-surface)', MIN_TEXT],
    ['erro', 'var(--mantine-color-error)', 'var(--mantine-color-dark-5)', MIN_TEXT],
    ['link', 'var(--mantine-color-anchor)', 'var(--mantine-color-body)', MIN_TEXT],
    ['link', 'var(--mantine-color-anchor)', 'var(--app-surface)', MIN_TEXT],
    ['amarelo', 'var(--mantine-primary-color-filled)', 'var(--mantine-color-dark-5)', MIN_TEXT],
    ['separador do Breadcrumbs', 'var(--mantine-color-dark-2)', 'var(--mantine-color-body)', 4.5],
    ['separador do Breadcrumbs', 'var(--mantine-color-dark-2)', 'var(--app-surface)', 4.5],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-red-filled)', MIN_TEXT],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-red-filled-hover)', 4.5],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-green-filled)', 4.5],
    ['texto branco', 'var(--mantine-color-white)', 'var(--mantine-color-green-filled-hover)', 4.5],
    ['borda de controle', 'var(--app-control-border)', 'var(--app-surface)', MIN_INDICATOR],
    ['borda de controle', 'var(--app-control-border)', 'var(--mantine-color-body)', 3],
    ['borda de controle', 'var(--app-control-border)', 'var(--mantine-color-dark-5)', 3],
    ['borda de controle', 'var(--app-control-border)', 'var(--mantine-color-red-light)', 3],
    ['anel de foco', 'var(--app-focus-ring)', 'var(--mantine-color-body)', MIN_INDICATOR],
    ['anel de foco', 'var(--app-focus-ring)', 'var(--app-surface)', MIN_INDICATOR],
    ['anel de foco', 'var(--app-focus-ring)', 'var(--mantine-color-dark-5)', MIN_INDICATOR],
  ],
};

describe.each<Scheme>(['light', 'dark'])('pares de colors.md no tema %s (§ 6.7)', (scheme) => {
  const vars = variables(scheme);
  const r = (value: string) => resolve(value, vars);

  it.each(PAIRS[scheme])('%s (%s) sobre %s', (_what, foreground, background, minimum) => {
    expect(contrastRatio(r(foreground), r(background))).toBeGreaterThanOrEqual(minimum);
  });
});

describe.each<Scheme>(['light', 'dark'])(
  'riscos medidos com as escalas reais, tema %s',
  (scheme) => {
    const vars = variables(scheme);
    const r = (value: string) => resolve(value, vars);
    const body = r('var(--mantine-color-body)');
    // Where an outline button sits: the page, a card and a hovered table row ("Abrir exame").
    const hoveredRow = r(
      scheme === 'light' ? 'var(--mantine-color-gray-1)' : 'var(--mantine-color-dark-5)',
    );
    const backgrounds = [body, r('var(--app-surface)'), hoveredRow];

    it('outline da cor principal, também no hover e sobre a linha em hover', () => {
      const v = appTheme.variantColorResolver({
        color: appTheme.primaryColor,
        theme: appTheme,
        variant: 'outline',
      });
      for (const background of backgrounds) {
        expect(contrastRatio(r(v.color), background)).toBeGreaterThanOrEqual(MIN_TEXT);
        expect(contrastRatio(r(v.color), over(r(v.hover), background))).toBeGreaterThanOrEqual(
          MIN_TEXT,
        );
      }
    });

    it.each(['red', 'green', 'primary', 'orange', 'gray'])(
      'alerta light %s: título e mensagem, também no hover',
      (color) => {
        const v = appTheme.variantColorResolver({ color, theme: appTheme, variant: 'light' });
        // Alert.css: the message is black (light) or white (dark).
        const message = r(
          scheme === 'light' ? 'var(--mantine-color-black)' : 'var(--mantine-color-white)',
        );
        for (const background of [over(r(v.background), body), over(r(v.hover), body)]) {
          expect(contrastRatio(r(v.color), background)).toBeGreaterThanOrEqual(MIN_TEXT);
          expect(contrastRatio(message, background)).toBeGreaterThanOrEqual(MIN_TEXT);
        }
      },
    );

    it('outline vermelho sobre a página e o cartão, também no hover', () => {
      const v = appTheme.variantColorResolver({
        color: 'red',
        theme: appTheme,
        variant: 'outline',
      });
      for (const background of [body, r('var(--app-surface)')]) {
        expect(contrastRatio(r(v.color), background)).toBeGreaterThanOrEqual(MIN_TEXT);
        expect(contrastRatio(r(v.color), over(r(v.hover), background))).toBeGreaterThanOrEqual(
          MIN_TEXT,
        );
      }
    });

    it('Text c="gray" sobre a página, o cartão e a linha em hover', () => {
      const gray = r('var(--mantine-color-gray-text)');
      for (const background of backgrounds) {
        expect(contrastRatio(gray, background)).toBeGreaterThanOrEqual(MIN_TEXT);
      }
    });
  },
);

describe('nenhum azul fixo nas telas (#166: informação usa a cor principal)', () => {
  const SOURCES = import.meta.glob<string>('../../src/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('nenhum color="blue" nem cor \'blue\' no código', () => {
    const found: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      source.split(/\r?\n/).forEach((line, index) => {
        if (/\b(?:color|c)=["']blue|:\s*["']blue["']|=\s*["']blue["']/.test(line)) {
          found.push(`${path}:${String(index + 1)}  ${line.trim()}`);
        }
      });
    }
    expect(found).toEqual([]);
  });
});
