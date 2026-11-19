/** Viewport width and motion preference read by the `matchMedia` stub in `setup.ts`. */
let viewportWidth = 1280;
let reducedMotion = false;

export function setViewportWidth(width: number): void {
  viewportWidth = width;
}

/** `prefers-reduced-motion: reduce` matches from now on (until the test ends). */
export function setReducedMotion(reduce: boolean): void {
  reducedMotion = reduce;
}

export function resetViewport(): void {
  viewportWidth = 1280;
  reducedMotion = false;
}

function toPx(value: string | undefined, unit: string | undefined): number {
  return Number(value) * (unit === 'px' ? 1 : 16);
}

export function mediaMatches(query: string): boolean {
  if (/prefers-reduced-motion:\s*reduce/.test(query)) return reducedMotion;
  const max = /max-width:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (max) return viewportWidth <= toPx(max[1], max[2]);
  const min = /min-width:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (min) return viewportWidth >= toPx(min[1], min[2]);
  return false;
}
