/**
 * Contrast of the list colors (§ 6.7: 4.5:1 text, 3:1 indicators) on every background the
 * list sits on: the page, the hovered table row and the card, in both themes.
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

/** Backgrounds from Mantine's CSS: Table hover (`--table-hover-color`) and Card. */
const BACKGROUNDS: Record<Scheme, Record<string, string>> = {
  light: {
    page: 'var(--mantine-color-body)',
    'hovered row': 'var(--mantine-color-gray-1)',
    card: 'var(--mantine-color-white)',
  },
  dark: {
    page: 'var(--mantine-color-body)',
    'hovered row': 'var(--mantine-color-dark-5)',
    card: 'var(--mantine-color-dark-6)',
  },
};

const FOREGROUNDS = [
  ['blocked text', 'var(--mantine-color-error)', 4.5],
  ['inactive text and card labels', 'var(--mantine-color-dimmed)', 4.5],
  ['eligible icon', 'var(--mantine-color-green-light-color)', 3],
] as const;

describe.each<Scheme>(['light', 'dark'])('students list contrast, %s theme', (scheme) => {
  const vars = variables(scheme);
  const cases = FOREGROUNDS.flatMap(([name, color, min]) =>
    Object.entries(BACKGROUNDS[scheme]).map(([where, background]) => ({
      name,
      color,
      min,
      where,
      background,
    })),
  );

  it.each(cases)('$name on the $where', ({ color, min, background }) => {
    expect(contrastRatio(resolve(color, vars), resolve(background, vars))).toBeGreaterThanOrEqual(
      min,
    );
  });
});
