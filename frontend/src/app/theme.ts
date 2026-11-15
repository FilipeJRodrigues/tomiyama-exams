import {
  ActionIcon,
  Anchor,
  AppShell,
  Badge,
  Button,
  Checkbox,
  ComboboxChevron,
  Drawer,
  Modal,
  Paper,
  PasswordInput,
  Radio,
  createTheme,
  darken,
  isVirtualColor,
  localStorageColorSchemeManager,
  luminance,
  rem,
  virtualColor,
  type CSSVariablesResolver,
  type MantineColor,
  type MantineColorsTuple,
  type MantineProviderProps,
} from '@mantine/core';

/**
 * Base colors measured on the logo (skill `tomiyama-design`, `colors.md`). Blue is the
 * primary color of the light scheme and yellow the one of the dark scheme; red is only for
 * errors and danger; the green of success is a darker green, so white text on it passes.
 */
export const BRAND_COLORS = {
  blue: '#0A265F',
  yellow: '#FCEC27',
  red: '#D62211',
  green: '#237A36',
} as const;

/**
 * Tone of the filled variant (`primaryShade`) in both schemes. Every brand scale keeps its
 * base color at this index, so a filled button is the color of the logo: blue (light) or
 * yellow (dark) for the primary color, red for danger and green for success.
 */
const FILLED_SHADE = 8;

/*
 * The 10-tone scales Mantine needs, worked out from the base colors by interpolating in
 * OKLCH (same hue): tones 0 to 7 go from an almost white tint to the base color, tone 9 is a
 * darker shade (the hover of the filled variant). Fixed tones, besides the base at 8:
 * - red.4 `#FF8577`: errors and red text or borders in the dark scheme (Mantine reads tone 4
 *   there), 4.73:1 even on a hovered table row; red.1 stays as light as Mantine's red.1, so
 *   the control border keeps 3.56:1 on a red `light` alert;
 * - yellow.9 `#BCA100`: blue text on it (the hover of the yellow button) is 5.65:1, and the
 *   pale yellow of the `light` variant keeps 4.70:1 on it darkened by 30% (Mantine's hover).
 * Measured by `tests/app/theme-palette.test.ts`.
 */
const tomiyamaBlue: MantineColorsTuple = [
  '#F0F5FF',
  '#CCD9F3',
  '#A8BEE7',
  '#86A3DA',
  '#6488CC',
  '#4C6EB0',
  '#355694',
  '#1F3D79',
  BRAND_COLORS.blue,
  '#041741',
];

const tomiyamaYellow: MantineColorsTuple = [
  '#FFFEDB',
  '#FFFBC2',
  '#FEF8A7',
  '#FEF589',
  '#FEF37B',
  '#FDF26C',
  '#FDF05B',
  '#FCEE46',
  BRAND_COLORS.yellow,
  '#BCA100',
];

const red: MantineColorsTuple = [
  '#FFF6F4',
  '#FFE4E1',
  '#FFC5BD',
  '#FFA69A',
  '#FF8577',
  '#F57061',
  '#EB5B4A',
  '#E14232',
  BRAND_COLORS.red,
  '#A91709',
];

const green: MantineColorsTuple = [
  '#E9FBEA',
  '#CAEDCD',
  '#ABDFAF',
  '#8AD192',
  '#68C275',
  '#57AF65',
  '#469D55',
  '#358B45',
  BRAND_COLORS.green,
  '#1A5F29',
];

/**
 * Charcoal dark scheme, neutral and not bluish. The tones Mantine reads: text dark.0
 * (10.3:1 on the page), `dimmed` dark.1, Breadcrumbs separator dark.2 (lighter than
 * Mantine's, 4.5:1 or more on the page and on a card), placeholder dark.3, borders dark.4,
 * hovered rows and items dark.5, cards and inputs dark.6, page dark.7; dark.8 (the track of
 * the segmented control) is darker than the page.
 */
const dark: MantineColorsTuple = [
  '#C9C9C9',
  '#B8B8B8',
  '#9C9C9C',
  '#696969',
  '#424242',
  '#3B3B3B',
  '#2A2A2A',
  '#1C1C1C',
  '#141414',
  '#0D0D0D',
];

/**
 * Border of every control at rest (fields, `default` buttons and action icons) and the arrow
 * of the selects: 3:1 or more on everything around them, also on a hovered table row and on
 * a red `light` alert. Mantine's `--mantine-color-default-border` stays as it is for the
 * other borders.
 */
const CONTROL_BORDER = { light: '#737B83', dark: '#8F8F8F' } as const;

/** Surfaces: cards, dialogs, drawers, header and side menu (white / dark.6). */
const SURFACE = 'var(--app-surface)';

/** The primary color in its filled variant (the default of the controls). */
function onFilledPrimary(props: {
  color?: MantineColor | undefined;
  variant?: string | undefined;
  iconColor?: MantineColor | undefined;
}): boolean {
  const primary = props.color === undefined || props.color === 'primary';
  const filled = props.variant === undefined || props.variant === 'filled';
  return primary && filled && props.iconColor === undefined;
}

export const theme = createTheme({
  colors: {
    'tomiyama-blue': tomiyamaBlue,
    'tomiyama-yellow': tomiyamaYellow,
    red,
    green,
    dark,
    // § 6.7: blue on the charcoal page is 1.18:1, so the primary color turns yellow there.
    primary: virtualColor({ name: 'primary', light: 'tomiyama-blue', dark: 'tomiyama-yellow' }),
  },
  primaryColor: 'primary',
  primaryShade: { light: FILLED_SHADE, dark: FILLED_SHADE },
  // Text on a filled color follows the color: on the yellow it comes from
  // `--mantine-color-primary-contrast` (blue, see `cssVariablesResolver`), never white.
  autoContrast: true,
  // Focus ring on keyboard navigation (§ 6.7: visible focus).
  focusRing: 'auto',
  defaultRadius: 'md',
  components: {
    // § 6: sentence case everywhere. Mantine draws Badge in uppercase by default; turn it
    // off for every Badge (inline style, so it also wins over the class in the CSS).
    Badge: Badge.extend({
      styles: { root: { textTransform: 'none' } },
    }),
    // § 6.7: every control reachable by Tab, with a pt-BR name. The toggle announces its
    // state through `aria-pressed`, so the name stays the same when the password shows.
    PasswordInput: PasswordInput.extend({
      defaultProps: {
        visibilityToggleFocusable: true,
        visibilityToggleButtonProps: { 'aria-label': 'Mostrar senha' },
      },
    }),
    // Surfaces in the dark scheme are dark.6, not the page (`--mantine-color-body`, which
    // Mantine also gives these components). Card and Popover already use dark.6.
    Paper: Paper.extend({
      styles: { root: { backgroundColor: SURFACE } },
    }),
    // The sticky header of dialogs and drawers paints its own background too.
    Modal: Modal.extend({
      styles: { content: { backgroundColor: SURFACE }, header: { backgroundColor: SURFACE } },
    }),
    Drawer: Drawer.extend({
      styles: { content: { backgroundColor: SURFACE }, header: { backgroundColor: SURFACE } },
    }),
    AppShell: AppShell.extend({
      styles: { header: { backgroundColor: SURFACE }, navbar: { backgroundColor: SURFACE } },
    }),
    // § 6.7: the `default` variant (Sair, Tema, Editar...) draws the control border; the
    // background is the surface and Mantine's border would be 1.5:1.
    Button: Button.extend({
      vars: (_theme, props) => ({
        root:
          props.variant === 'default'
            ? { '--button-bd': `${rem(1)} solid var(--app-control-border)` }
            : {},
      }),
    }),
    ActionIcon: ActionIcon.extend({
      vars: (_theme, props) => ({
        root:
          props.variant === 'default'
            ? { '--ai-bd': `${rem(1)} solid var(--app-control-border)` }
            : {},
      }),
    }),
    // § 6.7: the arrow of every select (NativeSelect, Select, MultiSelect) is part of the
    // control, so it takes the control border (4.43:1 on a dark field, 4.29:1 on white).
    // Mantine draws it in dark.3, the placeholder tone (2.61:1 on a dark field). With an
    // error, or a color of its own, Mantine's color stays: the error red or that color.
    ComboboxChevron: ComboboxChevron.extend({
      vars: (_theme, props) => ({
        chevron:
          props.color === undefined && !props.error
            ? { '--combobox-chevron-color': 'var(--app-control-border)' }
            : {},
      }),
    }),
    // § 6.7, state never by color alone: in a sentence the link color is close to the text
    // around it (1.46:1 in the light scheme, 1.44:1 in the dark one), so every link is
    // underlined at rest, not only on hover. The side menu is NavLink, not Anchor.
    Anchor: Anchor.extend({
      defaultProps: { underline: 'always' },
    }),
    // The dot and the check mark on the primary color: Mantine works their color out in JS
    // and gets white on the yellow too (1.22:1). The contrast color of the primary is white
    // in the light scheme and blue in the dark one.
    Radio: Radio.extend({
      vars: (_theme, props) => ({
        root: onFilledPrimary(props)
          ? { '--radio-icon-color': 'var(--mantine-color-primary-contrast)' }
          : {},
      }),
    }),
    Checkbox: Checkbox.extend({
      vars: (_theme, props) => ({
        root: onFilledPrimary(props)
          ? { '--checkbox-icon-color': 'var(--mantine-color-primary-contrast)' }
          : {},
      }),
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
 * hover). Every color of the theme passes; a custom palette that does not falls back to
 * white.
 */
function darkSchemeLightColor(shades: MantineColorsTuple): string | null {
  const backgrounds = [darken(shades[9], 0.5), darken(shades[9], 0.3)];
  if (readableOn(shades[0], backgrounds)) return null;
  return '#ffffff';
}

/** Variables of a virtual color that Mantine takes straight from the scale. */
const VIRTUAL_LIGHT_VARIABLES = ['light', 'light-hover', 'light-color'] as const;

/**
 * Contrast fixes for § 6.7 (4.5:1 on text), applied on top of Mantine's defaults:
 * - `dimmed`: the default gray is about 3.3:1 on white; gray.7 on white and dark.1 on the
 *   charcoal page are about 8:1.
 * - `error` (required-field asterisk, field errors, "Bloqueado"): the red of the logo on
 *   white (5.1:1); on the charcoal it is 3.3:1, so the dark scheme uses red.4 (`#FF8577`,
 *   7.2:1 on the page and 4.7:1 on a hovered row).
 * - `*-light-color`: see `lightSchemeLightColor`, for every color of the theme.
 * - The virtual primary color: Mantine writes its `light` variables (active NavLink, `light`
 *   Badge and Alert) from the scale, without the fixes above; they point to the real color
 *   of each scheme instead. The text on the filled primary is white on the blue and blue on
 *   the yellow (`autoContrast` alone would give black there; without it, white at 1.22:1).
 * The link color (`--mantine-color-anchor`) is primary.8 (blue) in the light scheme and
 * primary.4 (a yellow close to the base) in the dark one.
 *
 * And the app's own variables, used by the theme components and by `a11y.css`:
 * - `--app-surface`: cards, dialogs, drawers, header and side menu (white / dark.6).
 * - `--app-focus-ring`: the real primary color of each scheme (blue 14.4:1 on white;
 *   yellow 13.9:1 on the page and 11.7:1 on a card).
 * - `--app-control-border`: border of the controls at rest (see `CONTROL_BORDER`).
 */
export const cssVariablesResolver: CSSVariablesResolver = (current) => {
  const blue = current.colors['tomiyama-blue'] ?? tomiyamaBlue;
  const yellow = current.colors['tomiyama-yellow'] ?? tomiyamaYellow;
  const light: Record<string, string> = {
    '--mantine-color-dimmed': current.colors.gray[7],
    '--mantine-color-error': current.colors.red[FILLED_SHADE],
    '--mantine-color-primary-contrast': 'var(--mantine-color-white)',
    '--mantine-primary-color-contrast': 'var(--mantine-color-white)',
    '--app-surface': 'var(--mantine-color-white)',
    '--app-focus-ring': blue[FILLED_SHADE],
    '--app-control-border': CONTROL_BORDER.light,
  };
  const dark: Record<string, string> = {
    '--mantine-color-dimmed': current.colors.dark[1],
    '--mantine-color-error': current.colors.red[4],
    '--mantine-color-primary-contrast': blue[FILLED_SHADE],
    '--mantine-primary-color-contrast': blue[FILLED_SHADE],
    '--app-surface': 'var(--mantine-color-dark-6)',
    '--app-focus-ring': yellow[FILLED_SHADE],
    '--app-control-border': CONTROL_BORDER.dark,
  };
  for (const [name, shades] of Object.entries(current.colors)) {
    if (isVirtualColor(shades)) {
      for (const variable of VIRTUAL_LIGHT_VARIABLES) {
        light[`--mantine-color-${name}-${variable}`] =
          `var(--mantine-color-${shades.light}-${variable})`;
        dark[`--mantine-color-${name}-${variable}`] =
          `var(--mantine-color-${shades.dark}-${variable})`;
      }
      continue;
    }
    const lightColor = lightSchemeLightColor(shades);
    if (lightColor) light[`--mantine-color-${name}-light-color`] = lightColor;
    const darkColor = darkSchemeLightColor(shades);
    if (darkColor) dark[`--mantine-color-${name}-light-color`] = darkColor;
  }
  return { variables: {}, light, dark };
};

/** Light/dark preference only; no personal data. Also read by the script in `index.html`. */
export const COLOR_SCHEME_KEY = 'tomiyama.color-scheme';

export const colorSchemeManager = localStorageColorSchemeManager({ key: COLOR_SCHEME_KEY });

/**
 * Everything a `MantineProvider` of the app takes, in one place: `AppProviders` and the
 * startup error screen (`ConfigErrorScreen`) spread it, so both show the same theme. Dark on
 * the first visit and a saved choice wins, as the script of `index.html` sets the page before
 * React (`tests/app/color-scheme-boot.test.ts`).
 */
export const mantineProviderProps: Required<
  Pick<
    MantineProviderProps,
    'theme' | 'colorSchemeManager' | 'cssVariablesResolver' | 'defaultColorScheme'
  >
> = {
  theme,
  colorSchemeManager,
  cssVariablesResolver,
  defaultColorScheme: 'dark',
};
