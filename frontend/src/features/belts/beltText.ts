/**
 * Texts of the belts list (§ 6.5). They only format what the API sent (RN015 is checked
 * by the backend).
 */
import type { Belt } from '../../api/types';
import { BELT_LEVEL_LABELS } from '../../lib/labels';

/** `11`, or `—` for the belt without kyū (Branca). */
export function kyuLabel(kyu: number | null): string {
  return kyu === null ? '—' : String(kyu);
}

/** `Básico`, `Intermediário`. */
export function levelLabel(belt: Pick<Belt, 'level'>): string {
  return BELT_LEVEL_LABELS[belt.level];
}

/** `Sem mínimo`, `1 ano`, `14 anos`. */
export function minAgeLabel(years: number): string {
  if (years <= 0) return 'Sem mínimo';
  return years === 1 ? '1 ano' : `${years} anos`;
}

/** `Sem carência`, `1 mês`, `12 meses`. */
export function minMonthsLabel(months: number): string {
  if (months <= 0) return 'Sem carência';
  return months === 1 ? '1 mês' : `${months} meses`;
}

/** `#9E9E9E`, or `#9E9E9E, pontas #1E63C6` for the two-color belts. */
export function colorsLabel(belt: Pick<Belt, 'color_primary' | 'color_secondary'>): string {
  return belt.color_secondary
    ? `${belt.color_primary}, pontas ${belt.color_secondary}`
    : belt.color_primary;
}

/** Belts in graduation order (the API already sends them so; this keeps it after an edit). */
export function sortBelts(belts: readonly Belt[]): Belt[] {
  return [...belts].sort((a, b) => a.sort_order - b.sort_order);
}
