/** Viewport width read by the `matchMedia` stub in `setup.ts`. */
let viewportWidth = 1280;

export function setViewportWidth(width: number): void {
  viewportWidth = width;
}

export function resetViewport(): void {
  viewportWidth = 1280;
}

function toPx(value: string | undefined, unit: string | undefined): number {
  return Number(value) * (unit === 'px' ? 1 : 16);
}

export function mediaMatches(query: string): boolean {
  const max = /max-width:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (max) return viewportWidth <= toPx(max[1], max[2]);
  const min = /min-width:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (min) return viewportWidth >= toPx(min[1], min[2]);
  return false;
}
