/**
 * Viewport size, motion preference and input device read by the `matchMedia` stub in
 * `setup.ts` (and by `tests/computedCss.ts`, which asks the stub for every `@media`).
 */
let viewportWidth = 1280;
let viewportHeight = 800;
let reducedMotion = false;
let touchScreen = false;

/** What a phone or tablet answers to the input-device queries (Media Queries 4). */
const TOUCH_FEATURES: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  hover: { none: true, hover: false },
  'any-hover': { none: true, hover: false },
  pointer: { coarse: true, fine: false, none: false },
  'any-pointer': { coarse: true, fine: false, none: false },
};

/** `navigator.maxTouchPoints` of a touch screen (an iPhone reports 5); jsdom has none. */
const TOUCH_POINTS = 5;

export function setViewportWidth(width: number): void {
  viewportWidth = width;
}

/** Only queries without a width read it (the short-window rule of the entry screens). */
export function setViewportHeight(height: number): void {
  viewportHeight = height;
}

/** `prefers-reduced-motion: reduce` matches from now on (until the test ends). */
export function setReducedMotion(reduce: boolean): void {
  reducedMotion = reduce;
}

/**
 * A touch screen (phone or tablet) from now on, until the test ends: `(hover: none)`,
 * `(any-hover: none)`, `(pointer: coarse)` and `(any-pointer: coarse)` match, `(hover: hover)`,
 * `(pointer: fine)` and their `any-` forms do not, and `navigator.maxTouchPoints` is 5. The
 * whole query is evaluated (`,`, `and`, `not`, `only`, media types), widths included.
 *
 * Without it (the default), nothing changes: no hover or pointer query matches, and a query
 * is read by its first width, height or motion feature, as before.
 */
export function setTouchScreen(touch: boolean): void {
  touchScreen = touch;
  if (touch) {
    Object.defineProperty(window.navigator, 'maxTouchPoints', {
      configurable: true,
      get: () => TOUCH_POINTS,
    });
  } else {
    Reflect.deleteProperty(window.navigator, 'maxTouchPoints');
  }
}

export function resetViewport(): void {
  viewportWidth = 1280;
  viewportHeight = 800;
  reducedMotion = false;
  if (touchScreen) setTouchScreen(false);
}

function toPx(value: string | undefined, unit: string | undefined): number {
  return Number(value) * (unit === 'px' ? 1 : 16);
}

/** One condition of a touch-screen query: a media type or a `(feature: value)`. */
function touchConditionMatches(condition: string): boolean {
  if (/^(all|screen)$/.test(condition)) return true;
  if (/^(print|speech)$/.test(condition)) return false;
  const feature = /^\(\s*([\w-]+)\s*(?::\s*([\w-]+)\s*)?\)$/.exec(condition);
  const values = feature ? TOUCH_FEATURES[feature[1] ?? ''] : undefined;
  if (feature && values) {
    const value = feature[2];
    // Boolean context: `(hover)` is false on a touch screen, `(pointer)` is true.
    if (value === undefined) return Object.entries(values).some(([v, on]) => on && v !== 'none');
    return values[value] ?? false;
  }
  return legacyMediaMatches(condition);
}

/** A whole media query on a touch screen (see `setTouchScreen`). */
function touchMediaMatches(query: string): boolean {
  return query.split(',').some((part) => {
    const text = part.trim().toLowerCase();
    const negated = /^not\s/.test(text);
    const conditions = text.replace(/^(not|only)\s+/, '').split(/\s+and\s+/);
    const all = conditions.every((condition) => touchConditionMatches(condition.trim()));
    return negated ? !all : all;
  });
}

export function mediaMatches(query: string): boolean {
  return touchScreen ? touchMediaMatches(query) : legacyMediaMatches(query);
}

/** The reading of a query when no touch screen is set: unchanged since before #191. */
function legacyMediaMatches(query: string): boolean {
  if (/prefers-reduced-motion:\s*reduce/.test(query)) return reducedMotion;
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
