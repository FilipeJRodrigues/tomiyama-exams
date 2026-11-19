/** Viewport size read by the `matchMedia` stub in `setup.ts`. */
let viewportWidth = 1280;
let viewportHeight = 800;

export function setViewportWidth(width: number): void {
  viewportWidth = width;
}

/** Only queries without a width read it (the short-window rule of the entry screens). */
export function setViewportHeight(height: number): void {
  viewportHeight = height;
}

export function resetViewport(): void {
  viewportWidth = 1280;
  viewportHeight = 800;
}

function toPx(value: string | undefined, unit: string | undefined): number {
  return Number(value) * (unit === 'px' ? 1 : 16);
}

export function mediaMatches(query: string): boolean {
  const max = /max-width:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (max) return viewportWidth <= toPx(max[1], max[2]);
  const min = /min-width:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (min) return viewportWidth >= toPx(min[1], min[2]);
  const maxHeight = /max-height:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (maxHeight) return viewportHeight <= toPx(maxHeight[1], maxHeight[2]);
  const minHeight = /min-height:\s*([\d.]+)(px|em|rem)/.exec(query);
  if (minHeight) return viewportHeight >= toPx(minHeight[1], minHeight[2]);
  return false;
}
