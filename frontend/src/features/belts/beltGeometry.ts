/**
 * Geometry of the belt drawn in its colors, shared by the mini belt of the lists and of the exam
 * header (`MiniBelt`) and by the drawing of the Belts screen (`BeltDrawing`). The colors come
 * from the API (`color_primary`, `color_secondary`), the only colors written inline in the app.
 */
import type { Belt } from '../../api/types';

/**
 * Width of each tip of a two-color belt, in percent of the belt: the body in the main color and
 * the tips in the second one, as on the certificate (§ 7, item 5).
 */
export const BELT_TIP_PERCENT = 18;

/** The body in the main color; a two-color belt has the tips in the second color. */
export function beltBackground(belt: Pick<Belt, 'color_primary' | 'color_secondary'>): string {
  const body = belt.color_primary;
  const tips = belt.color_secondary;
  if (!tips) return body;
  const start = `${String(BELT_TIP_PERCENT)}%`;
  const end = `${String(100 - BELT_TIP_PERCENT)}%`;
  return `linear-gradient(to right, ${tips} 0 ${start}, ${body} ${start} ${end}, ${tips} ${end} 100%)`;
}
