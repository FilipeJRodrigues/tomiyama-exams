/**
 * Texts and small helpers of the requirements screen (§ 6.5). They only format what the API
 * sent (RN017 is checked by the backend).
 */
import type { Belt, RequirementKind } from '../../api/types';
import { REQUIREMENT_KIND_LABELS } from '../../lib/labels';
import { sortBelts } from '../belts/beltText';

/** Belt of the filter when the screen opens (§ 6.5): the first one with an exam. */
export const DEFAULT_BELT_NAME = 'Branca/Cinza';

/**
 * Id of the default belt of the filter: the belt named Branca/Cinza. If it was renamed, the
 * second belt in graduation order (the first one is the initial belt, without exam); with a
 * single belt, that one.
 */
export function defaultBeltId(belts: readonly Belt[]): string | undefined {
  const sorted = sortBelts(belts);
  return (sorted.find((belt) => belt.name === DEFAULT_BELT_NAME) ?? sorted[1] ?? sorted[0])?.id;
}

/** `Teórico`, `Prático`. */
export function kindLabel(kind: RequirementKind): string {
  return REQUIREMENT_KIND_LABELS[kind];
}

/** Plural of the kind for the counts: `teóricos`, `práticos`. */
const KIND_PLURALS: Record<RequirementKind, string> = {
  THEORY: 'teóricos',
  PRACTICE: 'práticos',
};

/** `1 item`, `6 itens`. */
export function itemCountLabel(count: number): string {
  return count === 1 ? '1 item' : `${String(count)} itens`;
}

/** `6 itens: 2 teóricos e 4 práticos`, or `2 itens` when the list has a single kind. */
export function countSummary(kinds: readonly RequirementKind[]): string {
  const total = itemCountLabel(kinds.length);
  const theory = kinds.filter((kind) => kind === 'THEORY').length;
  const practice = kinds.length - theory;
  if (theory === 0 || practice === 0) return total;
  const part = (count: number, kind: RequirementKind) =>
    count === 1 ? `1 ${KIND_PLURALS[kind].slice(0, -1)}` : `${String(count)} ${KIND_PLURALS[kind]}`;
  return `${total}: ${part(theory, 'THEORY')} e ${part(practice, 'PRACTICE')}`;
}

/** Empty state of the current filter. */
export function emptyLabel(kind: RequirementKind | null): string {
  if (kind === 'THEORY') return 'Nenhum item teórico nesta faixa.';
  if (kind === 'PRACTICE') return 'Nenhum item prático nesta faixa.';
  return 'Nenhum item nesta faixa.';
}

/** Longest description kept in a button name or a dialog title. */
const SHORT_TEXT_LENGTH = 60;

/**
 * The description cut at a word, for button names and the delete question (the full text
 * stays in the list). Counts code points, like the API.
 */
export function shortText(text: string, max = SHORT_TEXT_LENGTH): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
