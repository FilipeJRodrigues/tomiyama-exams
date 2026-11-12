/**
 * Computed colors in jsdom, for the contrast checks of § 6.7.
 *
 * The suite runs with `css: false` and jsdom does not resolve `var()`, so the tests cannot ask
 * `getComputedStyle` for the color of a focus ring or of a border. This reads the same CSS the
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
 * goes through the `matchMedia` stub of `tests/setup.ts` (widths only), and only `#hex`,
 * `rgb()/rgba()`, `transparent`, `white` and `black` are read as colors; anything else throws,
 * so a check never passes on a color it could not read.
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

interface Entry {
  /** Selector given to `matches`, with `:focus-visible` read as `:focus`. */
  selector: string;
  requiredClasses: readonly string[];
  specificity: number;
  order: number;
  media: readonly string[];
  declarations: readonly Declaration[];
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
      // Pseudo-elements are other boxes, not the element.
      if (/::|:(before|after)\b/.test(raw)) continue;
      out.push({
        selector: raw.replaceAll(':focus-visible', ':focus'),
        requiredClasses: subjectClasses(raw),
        specificity: specificity(raw),
        order: out.length,
        media,
        declarations,
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
  private readonly matched = new Map<Element, Entry[]>();

  private constructor(entries: Entry[]) {
    this.entries = entries;
  }

  static async now(): Promise<Styles> {
    if (staticEntries === null) throw new Error('Chame loadStyles() no beforeAll.');
    const entries = [...(await staticEntries)];
    for (const style of document.querySelectorAll('style')) {
      const page: Entry[] = [];
      parse(style.textContent, page);
      for (const entry of page) entries.push({ ...entry, order: entries.length });
    }
    return new Styles(entries);
  }

  private matching(element: Element): Entry[] {
    const cached = this.matched.get(element);
    if (cached) return cached;
    const found = this.entries.filter((entry) => {
      if (!entry.requiredClasses.every((name) => element.classList.contains(name))) return false;
      if (!entry.media.every((query) => window.matchMedia(query).matches)) return false;
      try {
        return element.matches(entry.selector);
      } catch {
        return false;
      }
    });
    this.matched.set(element, found);
    return found;
  }

  /** The declaration that wins the cascade on the element, among the given properties. */
  declared(element: Element, props: readonly string[]): Winner | null {
    let best: (Winner & { rank: readonly [number, number, number, number] }) | null = null;
    const offer = (declaration: Declaration, inline: boolean, spec: number, order: number) => {
      if (!props.includes(declaration.prop)) return;
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
    for (const entry of this.matching(element)) {
      for (const declaration of entry.declarations) {
        offer(declaration, false, entry.specificity, entry.order);
      }
    }
    const inline = element.getAttribute('style');
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

  /** Text color of the element (`color` inherits). */
  textColor(element: Element): Rgb {
    for (let current: Element | null = element; current; current = current.parentElement) {
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
