/**
 * Contrast of the exam notice of the student's profile (RN019, § 6.7: 4.5:1 text, 3:1 icons),
 * in both themes: the title, the icon and the detail on the notice, and the loading line on
 * the page.
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';

import { contrastRatio, cssVariablesResolver, theme } from '../../../src/app/theme';
import { NOTICE_COLOR } from '../../../src/features/students/studentNoticeModel';

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

/** What Mantine's `variantColorResolver` gives the Alert: its background and `--alert-color`. */
const notice = appTheme.variantColorResolver({
  color: NOTICE_COLOR,
  theme: appTheme,
  variant: 'light',
});

/** The Alert message color of the `light` variant (Mantine's `Alert.css`). */
const MESSAGE: Record<Scheme, string> = {
  light: 'var(--mantine-color-black)',
  dark: 'var(--mantine-color-white)',
};

describe.each<Scheme>(['light', 'dark'])('exam notice contrast, %s theme', (scheme) => {
  const vars = variables(scheme);
  const background = resolve(notice.background, vars);

  it('the notice has an opaque background of its own', () => {
    // `#rrggbb`, `rgb(…)` or `rgba(…, 1)`: nothing of the page shows through it, so the
    // ratios below are the ones on the screen.
    expect(background).toMatch(/^(#[0-9a-f]{6}|rgb\([^)]*\)|rgba\([^)]*,\s*1\))$/i);
  });

  it('the title "Exame de faixas dia …" on the notice', () => {
    expect(contrastRatio(resolve(notice.color, vars), background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the icon on the notice', () => {
    expect(contrastRatio(resolve(notice.color, vars), background)).toBeGreaterThanOrEqual(3);
  });

  it('the event and the target on the notice', () => {
    expect(contrastRatio(resolve(MESSAGE[scheme], vars), background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the loading line on the page', () => {
    expect(
      contrastRatio(
        resolve('var(--mantine-color-dimmed)', vars),
        resolve('var(--mantine-color-body)', vars),
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
