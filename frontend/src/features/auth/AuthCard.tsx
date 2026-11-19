import { Paper, Stack, Text } from '@mantine/core';
import { useEffect, useRef, type ReactNode } from 'react';

import { PageTitle } from '../../app/PageTitle';
import { DISPLAY_FONT_WEIGHT } from '../../app/theme';
import logo from '../../assets/brand/tomiyama-logo-320.webp';
import classes from './AuthCard.module.css';

interface Props {
  title: string;
  /** Move the focus to the title on mount (a new step of the same screen). */
  focusTitle?: boolean;
  children: ReactNode;
}

/** Size the logo is laid out at before the CSS loads; the CSS gives 160 px or 96 px. */
const LOGO_SIZE = 160;

/**
 * Entry screens (login, sign-up, password recovery): the brand blue on the whole screen and,
 * centered, the logo, "Tomiyama" and "Área de exames" above the card (skill
 * `tomiyama-design`, "Telas de entrada"). Neither text is a heading: the `h1` of the screen
 * is the title of the card, a `PageTitle` in the display font like the `h1` of every other
 * screen (`typography.md`), at the size of an `h2`. Everything that takes the focus is inside
 * the card. Layout and colors in `AuthCard.module.css`.
 */
export function AuthCard({ title, focusTitle = false, children }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);

  return (
    <main className={classes.screen}>
      <div className={classes.column}>
        <div className={classes.brand}>
          <img
            className={classes.logo}
            src={logo}
            alt="Academia Tomiyama"
            width={LOGO_SIZE}
            height={LOGO_SIZE}
          />
          <Text className={classes.name} ff="var(--app-font-display)" fw={DISPLAY_FONT_WEIGHT}>
            Tomiyama
          </Text>
          <Text className={classes.area}>Área de exames</Text>
        </div>
        <Paper withBorder shadow="sm" p="xl" className={classes.card}>
          <Stack gap="md">
            <PageTitle order={1} size="h2" ref={titleRef} tabIndex={focusTitle ? -1 : undefined}>
              {title}
            </PageTitle>
            {children}
          </Stack>
        </Paper>
      </div>
    </main>
  );
}
