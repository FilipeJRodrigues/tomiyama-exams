import { Title, type TitleProps } from '@mantine/core';
import type { Ref } from 'react';

import { DISPLAY_FONT_WEIGHT } from './theme';

/** A long name or word breaks inside the line at 390 px and at 200% zoom (§ 6.7). */
const WRAP = { overflowWrap: 'anywhere' } as const;

export interface PageTitleProps extends Omit<
  TitleProps,
  'order' | 'ff' | 'fw' | 'tt' | 'lts' | 'lineClamp' | 'style'
> {
  /** `1`: the title of the screen; `2`: the title of a section of the screen. */
  order: 1 | 2;
  ref?: Ref<HTMLHeadingElement>;
}

/**
 * Title of a screen (`h1`) or of one of its sections (`h2`, such as "Resumo" or "Histórico de
 * exames"), in the display font of the theme (`--app-font-display`, Barlow Condensed 600).
 *
 * Only for page titles: the title of a card in a list (the name of a student, an event or a
 * belt, the description of a requirement) is data, often long, and stays a plain `Title` in
 * the system font, like the `h3`–`h6` subtitles and the dialog titles (skill
 * `tomiyama-design`, `typography.md`). Sentence case, no letter spacing, sizes from Mantine's
 * scale, and never cut: the title wraps instead.
 */
export function PageTitle({ order, ref, ...others }: PageTitleProps) {
  return (
    <Title
      {...others}
      ref={ref}
      order={order}
      ff="var(--app-font-display)"
      fw={DISPLAY_FONT_WEIGHT}
      style={WRAP}
    />
  );
}
