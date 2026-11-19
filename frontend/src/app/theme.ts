import {
  ActionIcon,
  Anchor,
  AppShell,
  Badge,
  Button,
  Card,
  Checkbox,
  ComboboxChevron,
  Drawer,
  Modal,
  NavLink,
  Paper,
  PasswordInput,
  Radio,
  SegmentedControl,
  createTheme,
  darken,
  getRadius,
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

/**
 * Secondary text on the brand blue of the entry screens (skill `tomiyama-design`, "Áreas de
 * marca (azul)"), the same in both schemes: a very light blue, 9.2:1 on the blue, apart from
 * the white of the name (14.4:1). Measured by `tests/app/auth-brand-area.test.tsx`.
 */
const ON_BRAND_SECONDARY_TEXT = '#C5CEE6';

/*
 * Shapes (skill `tomiyama-design`, `components.md`): buttons, action icons, badges and
 * segmented controls are pills (a vertical segmented control takes the large radius, see
 * below); cards, dialogs, drawers and panels have the large radius (a drawer only on the side
 * away from the edge of the screen); fields keep `defaultRadius` (`md`), since a pill-shaped
 * text box looks odd. Only the corners change: the height and the touch targets stay, and
 * the focus ring follows the rounded border with Mantine's 2 px offset.
 */
const PILL_RADIUS = 'xl';
const SURFACE_RADIUS = 'lg';

type DrawerPosition = 'top' | 'bottom' | 'left' | 'right';

/**
 * Corners of a drawer (`border-radius`: top-left, top-right, bottom-right, bottom-left). The
 * side held to the edge of the screen stays square, like the summary bar and a full-screen
 * dialog (rounded there, the corners show the overlay behind them, as in Edge); only the
 * corners of the side facing the page take the drawer's radius. That radius is the one
 * Mantine writes on the same element from the `radius` prop (`--paper-radius`, `lg` by
 * default), so an explicit `radius` still wins. Physical corners, since the app is
 * left-to-right only. With an `offset` the drawer floats off the edges: all four stay round.
 */
function drawerCorners(props: {
  position?: DrawerPosition | undefined;
  offset?: number | string | undefined;
}): string | undefined {
  if (props.offset !== undefined && props.offset !== 0 && props.offset !== '0') return undefined;
  const r = 'var(--paper-radius)';
  switch (props.position ?? 'left') {
    case 'bottom':
      return `${r} ${r} 0 0`;
    case 'top':
      return `0 0 ${r} ${r}`;
    case 'left':
      return `0 ${r} ${r} 0`;
    case 'right':
      return `${r} 0 0 ${r}`;
  }
}

/**
 * Font of the page titles (`PageTitle`: the `h1` of a screen and its section `h2`) and of the
 * name "Tomiyama" in the header (`AppLayout`). Barlow Condensed comes from the site itself
 * (`main.tsx` imports only the `latin` subset of weight 600, never Google Fonts); Arial Narrow
 * and sans-serif show while it loads (`font-display: swap`). Written as `--app-font-display`
 * by `cssVariablesResolver`.
 */
export const DISPLAY_FONT_FAMILY = "'Barlow Condensed', 'Arial Narrow', sans-serif";

/** The only weight shipped: asking for 700 would make the browser fake a bolder letter. */
export const DISPLAY_FONT_WEIGHT = 600;

/** Buttons in bold (typography.md); Mantine draws them in 600. */
const BUTTON_FONT_WEIGHT = 700;

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
  // Fields (TextInput, NativeSelect, Select, Textarea, PasswordInput...) and everything not
  // given a shape below.
  defaultRadius: 'md',
  components: {
    // § 6: sentence case everywhere. Mantine draws Badge in uppercase by default; turn it
    // off for every Badge (inline style, so it also wins over the class in the CSS).
    Badge: Badge.extend({
      defaultProps: { radius: PILL_RADIUS },
      styles: { root: { textTransform: 'none' } },
    }),
    // Pill like the buttons. The indicator of the chosen item is #173.
    // § 6.7: a vertical one (the "Filtrar alunos" filter of the Dia do exame under 768 px) is
    // far taller than its items. With the pill, the track's corners are 32 px while an item's
    // shrink to half its height (about 14 px): the arcs stop being concentric and the track,
    // which clips, cuts the focus ring of the first and last items at the corners. It takes
    // `lg`, the radius of the surfaces: 16 px on the track, 16 - 4 = 12 px on the items (the
    // track's padding is 4 px), concentric, with the 2 px ring inside the track. An explicit
    // radius other than the pill stays as given.
    SegmentedControl: SegmentedControl.extend({
      defaultProps: { radius: PILL_RADIUS },
      vars: (_theme, props) => ({
        root:
          props.orientation === 'vertical' && props.radius === PILL_RADIUS
            ? { '--sc-radius': getRadius(SURFACE_RADIUS) }
            : {},
      }),
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
      defaultProps: { radius: SURFACE_RADIUS },
      styles: { root: { backgroundColor: SURFACE } },
    }),
    // Card hands its radius to the Paper it draws.
    Card: Card.extend({
      defaultProps: { radius: SURFACE_RADIUS },
    }),
    // The sticky header of dialogs and drawers paints its own background too. A full-screen
    // dialog (the phone) keeps square corners: Mantine sets them to 0 there. A drawer has no
    // radius at all by default (Mantine passes 0 to its Paper), so it needs its own, and only
    // on the side away from the edge of the screen (see `drawerCorners`).
    Modal: Modal.extend({
      defaultProps: { radius: SURFACE_RADIUS },
      styles: { content: { backgroundColor: SURFACE }, header: { backgroundColor: SURFACE } },
    }),
    Drawer: Drawer.extend({
      defaultProps: { radius: SURFACE_RADIUS },
      styles: (_theme, props) => ({
        content: { backgroundColor: SURFACE, borderRadius: drawerCorners(props) },
        header: { backgroundColor: SURFACE },
      }),
    }),
    AppShell: AppShell.extend({
      styles: { header: { backgroundColor: SURFACE }, navbar: { backgroundColor: SURFACE } },
    }),
    // Side menu (skill `tomiyama-design`, "Cabeçalho e menu lateral"), for every NavLink. The
    // active item has no background of its own: Mantine paints the primary `light` color, and
    // its darker tone on hover. At rest it shows the menu; on hover, the hover of the other
    // items (`--app-nav-hover`). Its text and icon take the real primary color of the scheme
    // (`--app-nav-active`: blue 14.4:1 on white and 13.7:1 on the hover; yellow 11.7:1 on the
    // menu and 9.2:1 on the hover). The bold label, the bar and the hover of the other items
    // are in `a11y.css`. A NavLink given its own `color` or `variant` keeps Mantine's colors.
    NavLink: NavLink.extend({
      vars: (_theme, props) => ({
        root:
          props.color === undefined && props.variant === undefined
            ? {
                '--nl-bg': 'transparent',
                '--nl-hover': 'var(--app-nav-hover)',
                '--nl-color': 'var(--app-nav-active)',
              }
            : {},
        children: {},
      }),
    }),
    // Pill with a bold label. § 6.7: the `default` variant (Sair, Tema, Editar...) draws the
    // control border; the background is the surface and Mantine's border would be 1.5:1.
    Button: Button.extend({
      defaultProps: { radius: PILL_RADIUS },
      styles: { root: { fontWeight: BUTTON_FONT_WEIGHT } },
      vars: (_theme, props) => ({
        root:
          props.variant === 'default'
            ? { '--button-bd': `${rem(1)} solid var(--app-control-border)` }
            : {},
      }),
    }),
    // Round (the Tema button), with the same control border as the `default` buttons.
    ActionIcon: ActionIcon.extend({
      defaultProps: { radius: PILL_RADIUS },
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
 * Text color of the `light` variant (Badge, Alert, ActionIcon, a NavLink with its own color)
 * in the light scheme. Mantine draws shade 9 on shade 1, and on shade 2 on hover; for several
 * colors (blue, red, violet, indigo, cyan, teal, green, lime, yellow, orange) that stays under
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
 * - The virtual primary color: Mantine writes its `light` variables (`light` Badge and Alert,
 *   a NavLink with its own variant) from the scale, without the fixes above; they point to the
 *   real color of each scheme instead. The text on the filled primary is white on the blue
 *   and blue on the yellow (`autoContrast` alone would give black there; without it, white at
 *   1.22:1).
 * The link color (`--mantine-color-anchor`) is primary.8 (blue) in the light scheme and
 * primary.4 (a yellow close to the base) in the dark one.
 *
 * And the app's own variables, used by the theme components and by `a11y.css`:
 * - `--app-surface`: cards, dialogs, drawers, header and side menu (white / dark.6).
 * - `--app-focus-ring`: the real primary color of each scheme (blue 14.4:1 on white;
 *   yellow 13.9:1 on the page and 11.7:1 on a card).
 * - `--app-control-border`: border of the controls at rest (see `CONTROL_BORDER`).
 * - `--app-nav-active`: text, icon and bar of the active item of the side menu, the real
 *   primary color of each scheme, like the focus ring.
 * - `--app-nav-hover`: hover of the side menu items, active or not: gray.0 in the light scheme
 *   and dark.5 in the dark one (Mantine's dark hover is dark.6, the color of the menu itself).
 * - `--app-font-display`: font of the page titles and of the name "Tomiyama", the same in both
 *   schemes (see `DISPLAY_FONT_FAMILY`).
 *
 * The brand blue of the entry screens (login, sign-up, password recovery: `AuthCard`), the same
 * in both schemes; on it there is only white, yellow and the light secondary text, never red
 * (2.8:1: errors go inside the card):
 * - `--app-brand-bg`: the blue of the logo, the background of the whole screen.
 * - `--app-brand-text`: white text on the blue (14.4:1), the name "Tomiyama".
 * - `--app-brand-text-secondary`: "Área de exames" (`ON_BRAND_SECONDARY_TEXT`, 9.2:1).
 * - `--app-brand-focus-ring`: the focus ring on the blue, yellow (11.8:1); the blue ring of
 *   the light scheme would vanish there. Inside the card, `--app-focus-ring` as everywhere.
 * - `--app-brand-card-border`: border of the card on the blue. Mantine's gray.3 in the light
 *   scheme (the white card already stands out, 14.4:1; the border is 11.1:1); in the dark one
 *   the control border (4.46:1), since the charcoal card is 1.01:1 on the blue and Mantine's
 *   dark.4 border 1.44:1.
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
    '--app-nav-active': blue[FILLED_SHADE],
    '--app-nav-hover': current.colors.gray[0],
    '--app-brand-card-border': current.colors.gray[3],
  };
  const dark: Record<string, string> = {
    '--mantine-color-dimmed': current.colors.dark[1],
    '--mantine-color-error': current.colors.red[4],
    '--mantine-color-primary-contrast': blue[FILLED_SHADE],
    '--mantine-primary-color-contrast': blue[FILLED_SHADE],
    '--app-surface': 'var(--mantine-color-dark-6)',
    '--app-focus-ring': yellow[FILLED_SHADE],
    '--app-control-border': CONTROL_BORDER.dark,
    '--app-nav-active': yellow[FILLED_SHADE],
    '--app-nav-hover': current.colors.dark[5],
    '--app-brand-card-border': 'var(--app-control-border)',
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
  const variables: Record<string, string> = {
    '--app-font-display': DISPLAY_FONT_FAMILY,
    '--app-brand-bg': blue[FILLED_SHADE],
    '--app-brand-text': 'var(--mantine-color-white)',
    '--app-brand-text-secondary': ON_BRAND_SECONDARY_TEXT,
    '--app-brand-focus-ring': yellow[FILLED_SHADE],
  };
  return { variables, light, dark };
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
