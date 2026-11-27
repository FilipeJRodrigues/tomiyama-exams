/**
 * Look of the verdict buttons of the exam (skill `tomiyama-design`, "Certo / Errado (§ 6.4)" and
 * "Decisão"), in one place for the three of them: Certo or Errado chosen (`MarkButtons`),
 * Aprovar and Reprovar (`DecideButtons`) and the button that confirms the decision in the dialog.
 *
 * - **Filled**, with white text and icon (`autoContrast` picks white on both): the green
 *   `#237A36` (5.37:1) for Certo and Aprovar, the red of the logo `#D62211` (5.13:1) for Errado
 *   and Reprovar; on hover, tone 9 of each (`#1A5F29` 7.74:1, `#A91709` 7.46:1). These are the
 *   theme colors `green` and `red`, whose filled tone is `FILLED_SHADE` in both schemes
 *   (`theme.ts`), so the colors are the same in the light and dark schemes. No hex here.
 * - **Border of 2 px** in `--app-verdict-border` (`cssVariablesResolver`): transparent in the
 *   light scheme, where the fill paints under it and stands out from the white card by itself;
 *   the main text color `#C9C9C9` in the dark scheme, where the green (2.67:1) and the red
 *   (2.80:1) would not stand out from the card (the border is 8.67:1 there).
 * - **2 px in every state**, chosen or not (`UNCHOSEN_MARK_PROPS`, with the control border) and
 *   disabled too (Mantine draws a disabled button with a 1 px border): a button keeps its size
 *   when it is chosen or turns on, so the list and the dialog never move.
 *
 * The focus ring stays Mantine's, 2 px away from the button: it is drawn on the card, not on the
 * fill (blue 14.43:1 on white, yellow 11.73:1 on the dark card).
 */
import { rem, type ButtonProps, type MantineColor } from '@mantine/core';

/** Positive: Certo, Aprovar. Negative: Errado, Reprovar. */
export type Verdict = 'positive' | 'negative';

/** Theme colors (see the top of this file). */
const VERDICT_COLORS: Record<Verdict, MantineColor> = { positive: 'green', negative: 'red' };

/** Border width of the verdict buttons and of Certo/Errado not chosen. */
const BORDER_WIDTH = rem(2);

/** The props that give a button its look; the caller adds the rest (`style`, handlers...). */
export type ButtonLook = Required<Pick<ButtonProps, 'variant' | 'vars' | 'styles'>> &
  Pick<ButtonProps, 'color'>;

/**
 * A 2 px border in `color`. The variable feeds Mantine's border at rest and on hover; the inline
 * width keeps 2 px where Mantine's own rule draws 1 px (disabled), with its transparent color.
 */
function bordered(color: string): Pick<ButtonLook, 'vars' | 'styles'> {
  return {
    vars: () => ({ root: { '--button-bd': `${BORDER_WIDTH} solid ${color}` } }),
    styles: { root: { borderWidth: BORDER_WIDTH } },
  };
}

const VERDICT_BORDER = bordered('var(--app-verdict-border)');

/** Look of a verdict button: filled green or red, with its 2 px border. */
export function verdictButtonProps(verdict: Verdict): ButtonLook {
  return { variant: 'filled', color: VERDICT_COLORS[verdict], ...VERDICT_BORDER };
}

/**
 * Certo / Errado not chosen: `default`, with the control border at the same 2 px as the chosen
 * one (`--app-control-border`: 4.29:1 on the white card, 4.44:1 on the dark one).
 */
export const UNCHOSEN_MARK_PROPS: ButtonLook = {
  variant: 'default',
  ...bordered('var(--app-control-border)'),
};
