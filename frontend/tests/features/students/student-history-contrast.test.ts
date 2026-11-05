/**
 * Contrast of the status colors of the exam history (§ 6.7: 4.5:1 text, 3:1 icons) on every
 * background the history sits on: the page, the hovered table row and the card, in both themes.
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { contrastRatio, cssVariablesResolver, theme } from '../../../src/app/theme';
import { HISTORY_STATUS_COLORS } from '../../../src/features/students/studentHistoryModel';

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

/** Every color the status uses, with its minimum: 4.5:1 for the text, 3:1 for the icon. */
const FOREGROUNDS = Object.entries(HISTORY_STATUS_COLORS).flatMap(([status, colors]) => [
  ...(colors.text ? [{ name: `${status} text`, color: colors.text, min: 4.5 }] : []),
  ...(colors.icon ? [{ name: `${status} icon`, color: colors.icon, min: 3 }] : []),
]);

describe.each<Scheme>(['light', 'dark'])('exam history contrast, %s theme', (scheme) => {
  const vars = variables(scheme);
  const cases = FOREGROUNDS.flatMap((foreground) =>
    Object.entries(BACKGROUNDS[scheme]).map(([where, background]) => ({
      ...foreground,
      where,
      background,
    })),
  );

  it('checks every colored status', () => {
    expect(cases.map((item) => item.name)).toEqual(
      expect.arrayContaining(['APPROVED icon', 'FAILED icon', 'FAILED text']),
    );
  });

  it.each(cases)('$name on the $where', ({ color, min, background }) => {
    expect(contrastRatio(resolve(color, vars), resolve(background, vars))).toBeGreaterThanOrEqual(
      min,
    );
  });
});
