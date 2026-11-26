/**
 * The belt drawn in its colors: the mini belt next to the belt name (lists of § 6.2, § 6.3 and
 * § 6.5, header of the exam, § 6.4) and the drawing of the Belts screen. Both come from the
 * same geometry (`beltGeometry.ts`, `BeltShape.module.css`) and are decorative: the name, or the
 * colors in the Belts screen, are always written next to them.
 */
import type { ReactNode } from 'react';

import type { Belt } from '../../api/types';
import classes from './BeltShape.module.css';
import { beltBackground } from './beltGeometry';

/** `list`: 32×12 px in the lists; `header`: 48×16 px in the header of the exam. */
export type MiniBeltSize = 'list' | 'header';

interface MiniBeltProps {
  /** Undefined while the belts load or when they fail: nothing is drawn. */
  belt: Belt | undefined;
  size?: MiniBeltSize;
}

/** The mini belt: the body in the main color, the tips of a two-color belt in the second. */
export function MiniBelt({ belt, size = 'list' }: MiniBeltProps) {
  if (!belt) return null;
  return (
    <span
      aria-hidden
      data-testid="belt-swatch"
      data-size={size}
      className={`${classes.miniBelt} ${classes.beltOutline}`}
      style={{ background: beltBackground(belt) }}
    />
  );
}

interface NamedBeltProps extends MiniBeltProps {
  /** The belt name written next to the mini belt (with the stripes, in the students lists). */
  children: ReactNode;
}

/**
 * The mini belt before the written name, in a row of its own: a name that wraps goes on beside
 * the belt, and the belt stays on its first line (`BeltShape.module.css`).
 */
export function NamedBelt({ belt, size, children }: NamedBeltProps) {
  return (
    <span className={classes.namedBelt}>
      <MiniBelt belt={belt} size={size} />
      <span>{children}</span>
    </span>
  );
}

interface BeltInTextProps extends MiniBeltProps {
  /** The text the mini belt goes before, inside a line of text (`Faixa Marrom`). */
  text: string;
}

/**
 * The mini belt inside a line of text, before `text` (the exam in the header of the exam). The
 * text flows and wraps as it did without the belt, in one element of its own; the belt never
 * stays alone at the end of a line, it goes with the first word (`BeltShape.module.css`).
 */
export function BeltInText({ belt, size = 'header', text }: BeltInTextProps) {
  return (
    <span className={classes.beltInText}>
      <MiniBelt belt={belt} size={size} />
      <span className={classes.textAfterBelt}>{text}</span>
    </span>
  );
}

/** The belt as a bar of up to 240 px, in the read-only data of the edit dialog (#143). */
export function BeltDrawing({ belt }: { belt: Belt }) {
  return (
    <div
      aria-hidden
      data-testid="belt-drawing"
      className={`${classes.beltDrawing} ${classes.beltOutline}`}
      style={{ background: beltBackground(belt) }}
    />
  );
}
