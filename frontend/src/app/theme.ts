import {
  PasswordInput,
  createTheme,
  darken,
  isVirtualColor,
  localStorageColorSchemeManager,
  luminance,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core';

export const theme = createTheme({
  primaryColor: 'blue',
  // § 6.7 asks for 4.5:1 on text. White on blue.6 (the default light shade) is 3.6:1;
  // on blue.8 it is 5.0:1. The light-scheme links use the same shade.
  primaryShade: { light: 8, dark: 8 },
  // Focus ring on keyboard navigation (§ 6.7: visible focus).
  focusRing: 'auto',
  defaultRadius: 'md',
  components: {
    // § 6.7: every control reachable by Tab, with a pt-BR name. The toggle announces its
    // state through `aria-pressed`, so the name stays the same when the password shows.
    PasswordInput: PasswordInput.extend({
      defaultProps: {
        visibilityToggleFocusable: true,
        visibilityToggleButtonProps: { 'aria-label': 'Mostrar senha' },
      },
    }),
  },
});

/**
 * § 6.7 asks for at least 4.5:1 on text, in every state of the control. The colors are
 * tuned to 4.6:1 so that rounding in the browser never takes them under the minimum.
 */
const MIN_TEXT_CONTRAST = 4.6;

/** WCAG contrast ratio between two colors (hex or rgb). */
export function contrastRatio(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

function readableOn(color: string, backgrounds: readonly string[]): boolean {
  return backgrounds.every((background) => contrastRatio(color, background) >= MIN_TEXT_CONTRAST);
}

/**
 * Text color of the `light` variant (NavLink active, Badge, Alert, ActionIcon) in the light
 * scheme. Mantine draws shade 9 on shade 1, and on shade 2 on hover; for several colors
 * (blue, red, violet, indigo, cyan, teal, green, lime, yellow, orange) that stays under
 * 4.5:1. Darken shade 9 just enough to pass on both backgrounds; colors that already pass
 * keep Mantine's value.
 */
function lightSchemeLightColor(shades: MantineColorsTuple): string | null {
  const text = shades[9];
  const backgrounds = [shades[1], shades[2]];
  if (readableOn(text, backgrounds)) return null;
  for (let amount = 0.05; amount < 1; amount += 0.05) {
    const darker = darken(text, amount);
    if (readableOn(darker, backgrounds)) return darker;
  }
  return '#000000';
}

/**
 * Same for the dark scheme: Mantine draws shade 0 on shade 9 darkened by 50% (30% on
 * hover). Every default color passes; a custom palette that does not falls back to white.
 */
function darkSchemeLightColor(shades: MantineColorsTuple): string | null {
  const backgrounds = [darken(shades[9], 0.5), darken(shades[9], 0.3)];
  if (readableOn(shades[0], backgrounds)) return null;
  return '#ffffff';
}

/**
 * Contrast fixes for § 6.7 (4.5:1 on text), applied on top of Mantine's defaults:
 * - `dimmed`: the default gray is about 3.3:1 on white; gray.7 on white and dark.1 on
 *   dark.7 are about 8:1.
 * - `error` (required-field asterisk and field errors): red.6 on white is 3.3:1 and red.8
 *   on dark.7 is 3.4:1; red.9 on white is 5.4:1 and red.4 on dark.7 is 6.7:1.
 * - `*-light-color`: see `lightSchemeLightColor`, for every color of the theme.
 * The light-scheme link color (`--mantine-color-anchor`) follows `primaryShade.light`.
 */
export const cssVariablesResolver: CSSVariablesResolver = (current) => {
  const light: Record<string, string> = {
    '--mantine-color-dimmed': current.colors.gray[7],
    '--mantine-color-error': current.colors.red[9],
  };
  const dark: Record<string, string> = {
    '--mantine-color-dimmed': current.colors.dark[1],
    '--mantine-color-error': current.colors.red[4],
  };
  for (const [name, shades] of Object.entries(current.colors)) {
    if (isVirtualColor(shades)) continue;
    const lightColor = lightSchemeLightColor(shades);
    if (lightColor) light[`--mantine-color-${name}-light-color`] = lightColor;
    const darkColor = darkSchemeLightColor(shades);
    if (darkColor) dark[`--mantine-color-${name}-light-color`] = darkColor;
  }
  return { variables: {}, light, dark };
};

/** Light/dark preference only; no personal data. */
export const COLOR_SCHEME_KEY = 'tomiyama.color-scheme';

export const colorSchemeManager = localStorageColorSchemeManager({ key: COLOR_SCHEME_KEY });
