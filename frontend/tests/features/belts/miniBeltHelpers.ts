import { expect } from 'vitest';

/** `rgb(158, 158, 158)` (as jsdom writes the inline colors) or `#9E9E9E` as `#9e9e9e`. */
export function hexOf(color: string): string {
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(color.trim());
  if (rgb) {
    return `#${rgb
      .slice(1, 4)
      .map((part) => Number(part).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(color.trim())) return color.trim().toLowerCase();
  throw new Error(`Cor não reconhecida: ${color}`);
}

/**
 * The colors painted along the belt, left to right, as `[color, from %, to %]`: the inline
 * `linear-gradient(to right, ...)` of a two-color belt or `[[color, 0, 100]]` for a plain one.
 */
export function beltStops(element: HTMLElement): [string, number, number][] {
  const background = element.style.background.trim();
  const gradient = /^linear-gradient\(to right,\s*(.*)\)$/.exec(background);
  if (!gradient) return [[hexOf(background), 0, 100]];
  const stops: [string, number, number][] = [];
  const pattern = /(rgb\([^)]*\)|#[0-9a-f]{6})\s+(\d+(?:\.\d+)?)%?\s+(\d+(?:\.\d+)?)%/gi;
  for (const match of (gradient[1] ?? '').matchAll(pattern)) {
    stops.push([hexOf(match[1] ?? ''), Number(match[2]), Number(match[3])]);
  }
  expect(stops.length, `paradas em "${background}"`).toBeGreaterThan(0);
  return stops;
}
