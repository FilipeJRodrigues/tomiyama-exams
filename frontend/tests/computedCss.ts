/**
 * Computed colors in jsdom, for the contrast checks of § 6.7.
 *
 * The suite runs with CSS off (`test.css` in `vite.config.ts` lets only `?raw` imports through)
 * and jsdom does not resolve `var()`, so the tests cannot ask `getComputedStyle` for the color
 * of a focus ring or of a border. This reads the same CSS the
 * browser gets (Mantine's `styles.css`, every `.css` under `src/` through the project's
 * PostCSS plugins, and the `<style>` elements on the page, where `MantineProvider` writes the
 * theme variables) and works out the cascade for one element: matching rules (jsdom's
 * `matches`), specificity, order, `!important`, inline styles and custom properties inherited
 * from the ancestors.
 *
 * It measures the result, whatever way the color was set: theme, `cssVariablesResolver`,
 * component `vars`/`styles`, a stylesheet of the app or an inline style.
 *
 * Limits: `@layer` order and `@container` are not evaluated (the app uses neither), `@media`
 * goes through the `matchMedia` stub of `tests/setup.ts` (widths; hover and pointer only on
 * the touch screen of `setTouchScreen` in `tests/viewport.ts`), and only `#hex`,
 * `rgb()/rgba()`, `transparent`, `white` and `black` are read as colors; anything else throws,
 * so a check never passes on a color it could not read.
 *
 * Font size: `fontSizePx(element)` gives the computed size in CSS px (`font-size` or the `font`
 * shorthand, `var()`, `calc()/min()/max()/clamp()`, `px/rem/em/%` and the size keywords,
 * inherited when nothing is declared). A value it cannot read throws, as with colors.
 *
 * Hover: jsdom has no pointer, so `:hover` never matches. `Styles.now({ hover: element })`
 * reads the page as a mouse over that element would leave it: `:hover` matches the element and
 * its ancestors, and `@media (hover: hover)` holds (`(hover: none)` does not). Without it,
 * nothing is hovered, as before.
 *
 * Pseudo-elements: a rule ending in `::before` or `::after` is another box, so it never counts
 * for the element itself; `declared(element, props, { pseudo: '::after' })` reads that box (a
 * stretched link, for instance). Other pseudo-elements (`::placeholder`...) are not read.
 *
 * Order of the `<style>` elements: they come after the CSS files, as the ones `MantineProvider`
 * writes do. A `<style>` with `BEFORE_APP_CSS` comes before them instead, as the `<style>` of
 * `index.html` does in the browser (Vite adds the app's CSS at the end of the `<head>`), so it
 * loses every tie of specificity to the app's CSS.
 *
 * Declarations a browser drops: `declared(element, props, { skip })` reads the cascade without
 * them, as a browser that does not know a unit (`dvh`, for instance) would.
 *
 * `inherit` in a color (`background-color: inherit`) takes the parent's value, as in CSS; on the
 * root, none (transparent).
 */
import postcss, { type AcceptedPlugin, type Container } from 'postcss';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string, options: { recursive: true }): string[];
}

interface UrlLike {
  fileURLToPath(url: string): string;
  pathToFileURL(path: string): { href: string };
}

interface PathLike {
  resolve(...parts: string[]): string;
}

interface Declaration {
  prop: string;
  value: string;
  important: boolean;
}

/** The pseudo-elements `declared` can read (see the top of this file). */
export type PseudoElement = '::before' | '::after';

/** Marks the hovered element and its ancestors while a `Styles` reads them (see `now`). */
const HOVER_ATTRIBUTE = 'data-computed-css-hover';

/**
 * A `<style>` with this attribute comes before the CSS files in the cascade, as the `<style>`
 * of `index.html` does in the browser (see the top of this file).
 */
export const BEFORE_APP_CSS = 'data-computed-css-before-app';

interface Entry {
  /**
   * Selector given to `matches`, with `:focus-visible` read as `:focus` and `:hover` as the
   * hover mark (same specificity: one pseudo-class, one attribute).
   */
  selector: string;
  requiredClasses: readonly string[];
  specificity: number;
  order: number;
  media: readonly string[];
  declarations: readonly Declaration[];
  /** The box the rule styles: the element (null) or one of its pseudo-elements. */
  pseudo: PseudoElement | null;
}

export type Rgb = readonly [number, number, number];

interface Rgba {
  rgb: Rgb;
  alpha: number;
}

/** Not a literal, so the app's type check (no Node types) and Vite leave the import alone. */
async function load<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

/* ------------------------------------------------------------------ parsing */

function splitTopLevel(text: string, separator: (char: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (depth === 0 && separator(char)) {
      if (current !== '') parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** Index of the `)` that closes the `(` at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/** a*10000 + b*100 + c; `:where()` counts nothing, `:not()/:is()/:has()` their argument. */
export function specificity(selector: string): number {
  let total = 0;
  let i = 0;
  let compoundStart = true;
  while (i < selector.length) {
    const char = selector[i] ?? '';
    if (char === '#') {
      total += 10000;
      compoundStart = false;
    } else if (char === '.') {
      total += 100;
      compoundStart = false;
    } else if (char === '[') {
      total += 100;
      i = selector.indexOf(']', i);
      if (i === -1) break;
      compoundStart = false;
    } else if (char === ':') {
      const pseudoElement = selector[i + 1] === ':';
      const nameMatch = /^:{1,2}([\w-]+)/.exec(selector.slice(i));
      const name = nameMatch?.[1] ?? '';
      i += (nameMatch?.[0].length ?? 1) - 1;
      const hasArguments = selector[i + 1] === '(';
      const end = hasArguments ? closing(selector, i + 1) : i;
      const inner = hasArguments ? selector.slice(i + 2, end) : '';
      if (pseudoElement) total += 1;
      else if (name === 'where') total += 0;
      else if (name === 'not' || name === 'is' || name === 'has') {
        total += Math.max(0, ...splitTopLevel(inner, (c) => c === ',').map(specificity));
      } else total += 100;
      i = end;
      compoundStart = false;
    } else if (/[\s>+~]/.test(char)) {
      compoundStart = true;
    } else if (char === '*') {
      compoundStart = false;
    } else if (compoundStart && /[a-zA-Z]/.test(char)) {
      total += 1;
      compoundStart = false;
    }
    i += 1;
  }
  return total;
}

/** Classes the subject of the selector must have: a cheap filter before `matches`. */
function subjectClasses(selector: string): string[] {
  const compounds = splitTopLevel(selector, (char) => /[\s>+~]/.test(char));
  const subject = compounds[compounds.length - 1] ?? '';
  let plain = '';
  let depth = 0;
  for (const char of subject) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0) plain += char;
  }
  return [...plain.matchAll(/\.([\w-]+)/g)].map((match) => match[1] ?? '');
}

function collect(container: Container, media: readonly string[], out: Entry[]): void {
  container.each((node) => {
    if (node.type === 'atrule') {
      if (node.name === 'media') collect(node, [...media, node.params], out);
      else if (node.name === 'supports' || node.name === 'layer') collect(node, media, out);
      return;
    }
    if (node.type !== 'rule') return;
    const declarations: Declaration[] = [];
    node.each((child) => {
      if (child.type === 'decl') {
        declarations.push({ prop: child.prop, value: child.value, important: child.important });
      }
    });
    if (declarations.length === 0) return;
    for (const raw of node.selectors) {
      // Pseudo-elements are other boxes, not the element: `::before`/`::after` at the end
      // are kept for that box only; any other is not read.
      const ending = /::?(before|after)$/.exec(raw.trim());
      const own = ending ? raw.trim().slice(0, ending.index) : raw;
      if (/::|:(before|after)\b/.test(own)) continue;
      out.push({
        selector: (own === '' ? '*' : own)
          .replaceAll(':focus-visible', ':focus')
          .replaceAll(':hover', `[${HOVER_ATTRIBUTE}]`),
        requiredClasses: subjectClasses(own),
        specificity: specificity(raw),
        order: out.length,
        media,
        declarations,
        pseudo: ending?.[1] === 'before' ? '::before' : ending ? '::after' : null,
      });
    }
  });
}

function parse(css: string, out: Entry[]): void {
  collect(postcss.parse(css), [], out);
}

/* ------------------------------------------------------------- stylesheets */

interface PostcssConfig {
  plugins?: Record<string, unknown>;
}

type PluginFactory = (options?: unknown) => AcceptedPlugin;

async function projectPlugins(configUrl: string): Promise<AcceptedPlugin[]> {
  const config = await load<{ default: PostcssConfig }>(configUrl);
  const plugins: AcceptedPlugin[] = [];
  for (const [name, options] of Object.entries(config.default.plugins ?? {})) {
    const module = await load<{ default: PluginFactory }>(name);
    plugins.push(module.default(options));
  }
  return plugins;
}

/**
 * Vitest gives CSS-module classes as `_name_hash` even with `css: false`; the file read from
 * disk says `.name`. Match the class as written (global classes) or by the name inside it.
 */
function looseModuleClasses(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    rule.selectors = rule.selectors.map((selector) =>
      selector
        .replace(/:global\(([^)]*)\)/g, '$1')
        .replace(/\.([a-zA-Z][\w-]*)/g, ':is(.$1, [class*="_$1_"])'),
    );
  });
  return root.toString();
}

let staticEntries: Promise<Entry[]> | null = null;

async function readStaticEntries(): Promise<Entry[]> {
  // Paths as strings: under jsdom, `URL` is not the class Node's `fs` takes.
  const fs = await load<FsLike>('node:fs');
  const url = await load<UrlLike>('node:url');
  const path = await load<PathLike>('node:path');
  const frontend = path.resolve(url.fileURLToPath(import.meta.url), '..', '..');
  const src = path.resolve(frontend, 'src');
  const entries: Entry[] = [];
  // Same order as the browser: `main.tsx` imports Mantine first, the app's CSS comes after.
  parse(
    fs.readFileSync(path.resolve(frontend, 'node_modules/@mantine/core/styles.css'), 'utf8'),
    entries,
  );
  const files = fs
    .readdirSync(src, { recursive: true })
    .filter((file) => file.endsWith('.css'))
    .sort();
  if (files.length > 0) {
    const config = url.pathToFileURL(path.resolve(frontend, 'postcss.config.cjs')).href;
    const processor = postcss(await projectPlugins(config));
    for (const file of files) {
      const css = fs.readFileSync(path.resolve(src, file), 'utf8');
      const result = await processor.process(css, { from: undefined });
      parse(file.endsWith('.module.css') ? looseModuleClasses(result.css) : result.css, entries);
    }
  }
  return entries;
}

/** Call in `beforeAll`: reads Mantine's CSS and the app's once per test file. */
export async function loadStyles(): Promise<void> {
  staticEntries ??= readStaticEntries();
  await staticEntries;
}

/* ----------------------------------------------------------------- cascade */

interface Winner {
  prop: string;
  value: string;
}

/**
 * The styles as they are now: the CSS files plus the `<style>` elements on the page. Take a
 * new one after anything that changes the page (render, focus, color scheme).
 */
export class Styles {
  private readonly entries: Entry[];
  private readonly hovering: boolean;
  /** Rules that match, per box: the element ('') or a pseudo-element of it. */
  private readonly matched = new Map<string, Map<Element, Entry[]>>();

  private constructor(entries: Entry[], hovering: boolean) {
    this.entries = entries;
    this.hovering = hovering;
  }

  /**
   * `hover`: the element under the mouse (see the top of this file). The mark stays on the
   * page until the next `now()`, which clears it.
   */
  static async now(options: { hover?: Element } = {}): Promise<Styles> {
    if (staticEntries === null) throw new Error('Chame loadStyles() no beforeAll.');
    const styles = [...document.querySelectorAll('style')];
    const before: Entry[] = [];
    for (const style of styles.filter((element) => element.hasAttribute(BEFORE_APP_CSS))) {
      parse(style.textContent, before);
    }
    const files = await staticEntries;
    // Without a `<style>` before the files, the same entries and order as always.
    const entries =
      before.length === 0
        ? [...files]
        : [...before, ...files].map((entry, order) => ({ ...entry, order }));
    for (const style of styles.filter((element) => !element.hasAttribute(BEFORE_APP_CSS))) {
      const page: Entry[] = [];
      parse(style.textContent, page);
      for (const entry of page) entries.push({ ...entry, order: entries.length });
    }
    for (const marked of document.querySelectorAll(`[${HOVER_ATTRIBUTE}]`)) {
      marked.removeAttribute(HOVER_ATTRIBUTE);
    }
    for (let current = options.hover ?? null; current; current = current.parentElement) {
      current.setAttribute(HOVER_ATTRIBUTE, '');
    }
    return new Styles(entries, options.hover !== undefined);
  }

  /** `(hover: hover)` holds while something is hovered; other queries go to `matchMedia`. */
  private mediaMatches(query: string): boolean {
    if (this.hovering && /\(\s*hover\s*:\s*hover\s*\)/.test(query)) return true;
    if (this.hovering && /\(\s*hover\s*:\s*none\s*\)/.test(query)) return false;
    return window.matchMedia(query).matches;
  }

  private matching(element: Element, pseudo: PseudoElement | null = null): Entry[] {
    let byElement = this.matched.get(pseudo ?? '');
    if (!byElement) {
      byElement = new Map();
      this.matched.set(pseudo ?? '', byElement);
    }
    const cached = byElement.get(element);
    if (cached) return cached;
    const found = this.entries.filter((entry) => {
      if (entry.pseudo !== pseudo) return false;
      if (!entry.requiredClasses.every((name) => element.classList.contains(name))) return false;
      if (!entry.media.every((query) => this.mediaMatches(query))) return false;
      try {
        return element.matches(entry.selector);
      } catch {
        return false;
      }
    });
    byElement.set(element, found);
    return found;
  }

  /**
   * The declaration that wins the cascade on the element, among the given properties; with
   * `pseudo`, on that pseudo-element of it (inline styles do not reach a pseudo-element); with
   * `skip`, without the declarations it returns true for (see the top of this file).
   */
  declared(
    element: Element,
    props: readonly string[],
    options: {
      pseudo?: PseudoElement;
      skip?: (declaration: { prop: string; value: string }) => boolean;
    } = {},
  ): Winner | null {
    const pseudo = options.pseudo ?? null;
    let best: (Winner & { rank: readonly [number, number, number, number] }) | null = null;
    const offer = (declaration: Declaration, inline: boolean, spec: number, order: number) => {
      if (!props.includes(declaration.prop)) return;
      if (options.skip?.({ prop: declaration.prop, value: declaration.value })) return;
      const rank = [declaration.important ? 1 : 0, inline ? 1 : 0, spec, order] as const;
      if (best !== null) {
        for (let i = 0; i < rank.length; i += 1) {
          const difference = (rank[i] ?? 0) - (best.rank[i] ?? 0);
          if (difference < 0) return;
          if (difference > 0) break;
        }
      }
      best = { prop: declaration.prop, value: declaration.value, rank };
    };
    for (const entry of this.matching(element, pseudo)) {
      for (const declaration of entry.declarations) {
        offer(declaration, false, entry.specificity, entry.order);
      }
    }
    const inline = pseudo === null ? element.getAttribute('style') : null;
    if (inline) {
      let order = 0;
      postcss.parse(`a{${inline}}`).walkDecls((declaration) => {
        order += 1;
        offer(
          { prop: declaration.prop, value: declaration.value, important: declaration.important },
          true,
          0,
          order,
        );
      });
    }
    return best;
  }

  /** Value of a custom property on the element (they inherit), with its `var()` resolved. */
  private custom(element: Element, name: string, depth: number): string | null {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const winner = this.declared(current, [name]);
      if (winner) return this.resolve(current, winner.value, depth + 1);
    }
    return null;
  }

  /** Replace every `var(--x, fallback)` by its value on the element. */
  resolve(element: Element, value: string, depth = 0): string {
    if (depth > 20) throw new Error(`Variáveis CSS em ciclo: ${value}`);
    let result = value;
    for (;;) {
      const start = result.indexOf('var(');
      if (start === -1) return result.trim();
      const end = closing(result, start + 3);
      const inner = result.slice(start + 4, end);
      const comma = inner.indexOf(',');
      const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma === -1 ? null : inner.slice(comma + 1);
      const found = this.custom(element, name, depth) ?? fallback;
      if (found === null) {
        throw new Error(`Variável CSS sem valor: ${name} (em "${value}")`);
      }
      result = result.slice(0, start) + found + result.slice(end + 1);
    }
  }

  /** Color in a declaration of the element (shorthand or longhand); null when none wins. */
  private color(element: Element, props: readonly string[]): Rgba | null {
    const winner = this.declared(element, props);
    if (winner === null) return null;
    const value = this.resolve(element, winner.value);
    if (value.toLowerCase() === 'inherit') {
      const parent = element.parentElement;
      return parent ? this.color(parent, props) : null;
    }
    const tokens = splitTopLevel(value, (char) => /\s/.test(char));
    for (const token of tokens) {
      const parsed = parseColor(token);
      if (parsed) return parsed;
    }
    if (tokens.some((token) => /^(none|0|initial|unset)$/.test(token))) return null;
    // A shorthand without a color (`border: 1px solid`) draws in `currentColor`; not used
    // by what these tests measure, so say it instead of guessing.
    throw new Error(`Cor não reconhecida em "${winner.prop}: ${value}"`);
  }

  /** Color of the focus ring (`outline`) the element shows; focus it first. */
  focusRingColor(element: Element): Rgb {
    const ring = this.color(element, ['outline', 'outline-color']);
    if (ring === null || ring.alpha === 0) {
      throw new Error('O elemento com foco não tem anel de foco (outline) nas folhas de estilo.');
    }
    return blend(ring, this.background(element.parentElement ?? element));
  }

  /** Border color of the element, over the background around it. */
  borderColor(element: Element): Rgb {
    const border = this.color(element, ['border', 'border-color']);
    if (border === null) throw new Error('O elemento não tem borda nas folhas de estilo.');
    return blend(border, this.background(element.parentElement ?? element));
  }

  /** Text color of the element (`color` inherits; `color: inherit` takes the parent's). */
  textColor(element: Element): Rgb {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (this.declared(current, ['color'])?.value.trim() === 'inherit') continue;
      const color = this.color(current, ['color']);
      if (color) return blend(color, this.background(current));
    }
    throw new Error('Nenhuma cor de texto nas folhas de estilo.');
  }

  /** What is painted behind the element: its background or the nearest ancestor's. */
  background(element: Element): Rgb {
    const own = this.color(element, ['background', 'background-color']);
    if (own?.alpha === 1) return own.rgb;
    const parent = element.parentElement;
    // Nothing painted up to the root: the browser's canvas.
    const behind: Rgb = parent ? this.background(parent) : [255, 255, 255];
    return own ? blend(own, behind) : behind;
  }

  /** The nearest ancestor (or the element) that paints an opaque background. */
  backgroundOwner(element: Element): Element | null {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (this.color(current, ['background', 'background-color'])?.alpha === 1) return current;
    }
    return null;
  }

  /**
   * Computed font size of the element, in CSS px: the declaration that wins (`font-size` or
   * the `font` shorthand), `rem` from the root, `em` and `%` from the parent, the parent's
   * size when nothing is declared. A form control with nothing declared throws: the browser
   * gives it its own size there, not the parent's.
   */
  fontSizePx(element: Element): number {
    const root = element.ownerDocument.documentElement;
    const rootPx = element === root ? MEDIUM_PX : this.fontSizePx(root);
    const parentPx = () =>
      element === root || element.parentElement === null
        ? MEDIUM_PX
        : this.fontSizePx(element.parentElement);
    const winner = this.declared(element, ['font', 'font-size']);
    if (winner === null) {
      if (FORM_CONTROLS.has(element.tagName)) {
        throw new Error(
          `Nenhum font-size nas folhas de estilo para <${element.tagName.toLowerCase()}>: o navegador usaria o tamanho do sistema.`,
        );
      }
      return parentPx();
    }
    const value = this.resolve(element, winner.value);
    const size = winner.prop === 'font' ? fontShorthandSize(value) : value.trim().toLowerCase();
    if (size === 'inherit' || size === 'unset') return parentPx();
    if (size === 'initial') return MEDIUM_PX;
    if (size === 'larger') return parentPx() * 1.2;
    if (size === 'smaller') return parentPx() / 1.2;
    const keyword = FONT_SIZE_KEYWORDS[size];
    if (keyword !== undefined) return keyword;
    const px = lengthPx(size, { rem: rootPx, em: parentPx });
    if (px === null) throw new Error(`font-size não reconhecido: "${winner.prop}: ${value}"`);
    return px;
  }
}

/* --------------------------------------------------------------- font size */

/** The initial font size (`medium`). */
const MEDIUM_PX = 16;

/** Absolute size keywords of `font-size`, in px (CSS Fonts 4). */
const FONT_SIZE_KEYWORDS: Readonly<Record<string, number>> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
};

/** Elements whose font the browser does not inherit by default (its own stylesheet). */
const FORM_CONTROLS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

const SIZE_TOKEN = /^([+-]?(\d+\.?\d*|\.\d+)(px|rem|em|%)|(calc|min|max|clamp)\(.*\))$/;

/** The size inside a `font` shorthand (`700 1rem/1.5 sans-serif`), or its global keyword. */
function fontShorthandSize(value: string): string {
  const text = value.trim().toLowerCase();
  if (/^(inherit|initial|unset)$/.test(text)) return text;
  for (const token of splitTopLevel(text, (char) => /\s/.test(char))) {
    const size = splitTopLevel(token, (char) => char === '/')[0] ?? '';
    if (SIZE_TOKEN.test(size) || size in FONT_SIZE_KEYWORDS || /^(larger|smaller)$/.test(size)) {
      return size;
    }
  }
  throw new Error(`Tamanho não encontrado no atalho "font: ${value}"`);
}

interface Quantity {
  value: number;
  /** A length (px) or a plain number. */
  length: boolean;
}

/**
 * A length in px: `16px`, `1rem`, `calc(0.875rem * 1)`, `max(1rem, 14px)`, `clamp(...)`; `em`
 * and `%` are of the parent's size (the font-size rule). Null when it is not a length.
 */
function lengthPx(text: string, base: { rem: number; em: () => number }): number | null {
  const tokens = text.match(
    /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|rem|em|%)?|[a-z-]+\(|[()*/,+-]/g,
  );
  if (tokens === null || tokens.join('') !== text.replace(/\s+/g, '')) return null;
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  function factor(): Quantity {
    const token = take();
    if (token === undefined) throw new Error('fim');
    if (token === '(') {
      const inner = sum();
      if (take() !== ')') throw new Error(')');
      return inner;
    }
    const fn = /^([a-z-]+)\($/.exec(token);
    if (fn) {
      const args = [sum()];
      while (peek() === ',') {
        take();
        args.push(sum());
      }
      if (take() !== ')') throw new Error(')');
      const values = args.map((arg) => arg.value);
      const length = args.some((arg) => arg.length);
      if (fn[1] === 'calc' && args.length === 1 && args[0]) return args[0];
      if (fn[1] === 'min') return { value: Math.min(...values), length };
      if (fn[1] === 'max') return { value: Math.max(...values), length };
      if (fn[1] === 'clamp' && values.length === 3) {
        const [low = 0, middle = 0, high = 0] = values;
        return { value: Math.max(low, Math.min(middle, high)), length };
      }
      throw new Error(fn[1]);
    }
    const number = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|rem|em|%)?$/.exec(token);
    if (!number) throw new Error(token);
    const amount = Number(number[1]);
    switch (number[2]) {
      case 'px':
        return { value: amount, length: true };
      case 'rem':
        return { value: amount * base.rem, length: true };
      case 'em':
        return { value: amount * base.em(), length: true };
      case '%':
        return { value: (amount / 100) * base.em(), length: true };
      default:
        return { value: amount, length: false };
    }
  }

  function product(): Quantity {
    let left = factor();
    while (peek() === '*' || peek() === '/') {
      const operator = take();
      const right = factor();
      left =
        operator === '*'
          ? { value: left.value * right.value, length: left.length || right.length }
          : { value: left.value / right.value, length: left.length };
    }
    return left;
  }

  function sum(): Quantity {
    let left = product();
    for (;;) {
      const next = peek();
      // `calc(1rem -0.125rem)` reads as two numbers: a sign glued to the number.
      const glued = next !== undefined && /^[+-]./.test(next) ? next : null;
      if (next !== '+' && next !== '-' && glued === null) return left;
      if (glued === null) take();
      const right = product();
      const sign = glued !== null ? 1 : next === '-' ? -1 : 1;
      left = { value: left.value + sign * right.value, length: left.length || right.length };
    }
  }

  try {
    const result = sum();
    if (position !== tokens.length || !result.length) return null;
    return result.value;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ colors */

function parseColor(token: string): Rgba | null {
  const text = token.trim().toLowerCase();
  if (text === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  if (text === 'white') return { rgb: [255, 255, 255], alpha: 1 };
  if (text === 'black') return { rgb: [0, 0, 0], alpha: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1] ?? '';
    const full =
      digits.length <= 4
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits;
    if (full.length !== 6 && full.length !== 8) return null;
    const channel = (index: number) => parseInt(full.slice(index, index + 2), 16);
    return {
      rgb: [channel(0), channel(2), channel(4)],
      alpha: full.length === 8 ? channel(6) / 255 : 1,
    };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(
    text,
  );
  if (fn) {
    const alphaText = fn[4];
    const alpha =
      alphaText === undefined
        ? 1
        : alphaText.endsWith('%')
          ? Number.parseFloat(alphaText) / 100
          : Number(alphaText);
    return { rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])], alpha };
  }
  return null;
}

function blend(color: Rgba, behind: Rgb): Rgb {
  const mix = (index: 0 | 1 | 2) =>
    Math.round(color.rgb[index] * color.alpha + behind[index] * (1 - color.alpha));
  return [mix(0), mix(1), mix(2)];
}

function luminance(color: Rgb): number {
  const [r, g, b] = color.map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

export function hex(color: Rgb): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** "2,70:1", as the reports of § 6.7 write it. */
export function ratioText(ratio: number): string {
  // Truncated, not rounded: 2.999 must not read "3,00:1".
  return `${(Math.floor(ratio * 100) / 100).toFixed(2).replace('.', ',')}:1`;
}

/**
 * Fails with the measured value in the message, e.g.
 * `anel de foco #1971c2 sobre o cartão #2e2e2e: 2,70:1, abaixo de 3:1`.
 */
export function expectContrast(what: string, a: Rgb, b: Rgb, minimum: number): void {
  const ratio = contrast(a, b);
  if (ratio < minimum) {
    throw new Error(
      `${what}: ${hex(a)} sobre ${hex(b)} dá ${ratioText(ratio)}, abaixo de ${String(minimum).replace('.', ',')}:1 (§ 6.7)`,
    );
  }
}
