/**
 * Cabeçalho com a marca (#166, etapa 2; skill `tomiyama-design`, `components.md`, "Cabeçalho
 * e menu lateral", e `logo.md`; § 6.7), medido na tela montada (`tests/computedCss.ts`):
 *
 * - da esquerda para a direita: botão do menu (só no celular), logo redondo de 40 px com o
 *   texto alternativo "Academia Tomiyama" (1:1, `object-fit: contain`, arquivo de 96 px de
 *   `src/assets/brand/`), "Tomiyama" na fonte de títulos e "Área de exames" no texto
 *   secundário, que some abaixo do `sm`; depois, o selo "Dados simulados";
 * - nada no cabeçalho é título: o primeiro título da página é o `h1` da tela;
 * - os arquivos do logo: o original e os recortes de 96 e 320 px em WebP com transparência;
 * - o título da aba: "Área de exames · Tomiyama".
 */
import { screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import { paths } from '../../src/app/navigation';
import { COLOR_SCHEME_KEY, DISPLAY_FONT_FAMILY, DISPLAY_FONT_WEIGHT } from '../../src/app/theme';
import { Styles, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

type Scheme = 'light' | 'dark';

/** A property that inherits: the value on the element or on its nearest ancestor. */
function inherited(styles: Styles, target: Element, prop: string): string | null {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  return null;
}

/** `display: none` on the element or on an ancestor (Mantine's `visibleFrom`/`hiddenFrom`). */
function hiddenByCss(styles: Styles, target: Element): boolean {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, ['display']);
    if (winner && styles.resolve(current, winner.value) === 'none') return true;
  }
  return false;
}

/** `a` comes before `b` in the page. */
function before(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

async function banner(): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 1, name: 'Alunos' });
  return screen.getByRole('banner');
}

beforeAll(loadStyles);

describe.each<Scheme>(['dark', 'light'])('marca no cabeçalho, tema %s (#166)', (scheme) => {
  beforeEach(() => {
    installMockApi();
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  it('logo redondo de 40 px com o texto alternativo, 1:1 e sem distorcer', async () => {
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    const logo = within(await banner()).getByRole('img', { name: 'Academia Tomiyama' });
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
    expect(logo.tagName).toBe('IMG');
    expect(logo.getAttribute('src')).toMatch(/tomiyama-logo-96\.webp$/);
    expect(logo).toHaveAttribute('width', '40');
    expect(logo).toHaveAttribute('height', '40');

    const styles = await Styles.now();
    const width = styles.declared(logo, ['width']);
    const height = styles.declared(logo, ['height']);
    expect(width?.value).toBeDefined();
    expect(width?.value).toBe(height?.value);
    const fit = styles.declared(logo, ['object-fit']);
    expect(fit && styles.resolve(logo, fit.value)).toBe('contain');
  });

  it('"Tomiyama" na fonte de títulos e "Área de exames" ao lado, nenhum dos dois título', async () => {
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    const header = await banner();
    expect(within(header).queryAllByRole('heading')).toEqual([]);

    const brand = within(header).getByText('Tomiyama');
    const area = within(header).getByText('Área de exames');
    const styles = await Styles.now();
    expect(inherited(styles, brand, 'font-family')).toBe(DISPLAY_FONT_FAMILY);
    expect(inherited(styles, brand, 'font-weight')).toBe(String(DISPLAY_FONT_WEIGHT));
    expect(inherited(styles, brand, 'text-transform') ?? 'none').toBe('none');
    expect(inherited(styles, area, 'font-family')).not.toBe(DISPLAY_FONT_FAMILY);
    // Secondary text (`dimmed`), not the brand or the primary color.
    const color = styles.declared(area, ['color']);
    expect(color?.value).toBe('var(--mantine-color-dimmed)');
    expect(area).toHaveClass('mantine-visible-from-sm');
    expect(hiddenByCss(styles, area)).toBe(false);
  });

  it('da esquerda para a direita: logo, "Tomiyama", "Área de exames", "Dados simulados"', async () => {
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    const header = await banner();
    const logo = within(header).getByRole('img', { name: 'Academia Tomiyama' });
    const brand = within(header).getByText('Tomiyama');
    const area = within(header).getByText('Área de exames');
    const badge = within(header).getByText('Dados simulados');
    const signOut = within(header).getByRole('button', { name: 'Sair' });
    expect(before(logo, brand)).toBe(true);
    expect(before(brand, area)).toBe(true);
    expect(before(area, badge)).toBe(true);
    expect(before(badge, signOut)).toBe(true);
  });

  it('a 390 px: botão do menu, logo e só "Tomiyama"; "Área de exames" some', async () => {
    setViewportWidth(390);
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    const header = await banner();
    const burger = within(header).getByRole('button', { name: 'Abrir menu' });
    const logo = within(header).getByRole('img', { name: 'Academia Tomiyama' });
    const brand = within(header).getByText('Tomiyama');
    const area = within(header).getByText('Área de exames');
    expect(before(burger, logo)).toBe(true);
    const styles = await Styles.now();
    expect(hiddenByCss(styles, burger)).toBe(false);
    expect(hiddenByCss(styles, logo)).toBe(false);
    expect(hiddenByCss(styles, brand)).toBe(false);
    expect(hiddenByCss(styles, area)).toBe(true);
    expect(within(header).queryAllByRole('heading')).toEqual([]);
  });

  it('o primeiro título da página é o h1 da tela', async () => {
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    await banner();
    const [first] = screen.getAllByRole('heading');
    expect(first).toHaveAccessibleName('Alunos');
    expect(first?.tagName).toBe('H1');
  });
});

/* -------------------------------------------------------------- logo files */

interface FsLike {
  readFileSync(path: string): Uint8Array;
}

interface UrlLike {
  fileURLToPath(url: string): string;
}

interface PathLike {
  resolve(...parts: string[]): string;
}

/** Not a literal, so the app's type check (no Node types) leaves the import alone. */
async function load<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

async function brandFile(name: string): Promise<Uint8Array> {
  const fs = await load<FsLike>('node:fs');
  const url = await load<UrlLike>('node:url');
  const path = await load<PathLike>('node:path');
  const here = url.fileURLToPath(import.meta.url);
  return fs.readFileSync(path.resolve(here, '..', '..', '..', 'src', 'assets', 'brand', name));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function uint24(bytes: Uint8Array, start: number): number {
  return (bytes[start] ?? 0) | ((bytes[start + 1] ?? 0) << 8) | ((bytes[start + 2] ?? 0) << 16);
}

/** Canvas size and alpha flag of an extended WebP (`VP8X`), which a WebP with alpha is. */
function webpInfo(bytes: Uint8Array): { width: number; height: number; alpha: boolean } {
  expect(ascii(bytes, 0, 4)).toBe('RIFF');
  expect(ascii(bytes, 8, 4)).toBe('WEBP');
  expect(ascii(bytes, 12, 4), 'WebP estendido (VP8X), com canal alfa').toBe('VP8X');
  return {
    alpha: ((bytes[20] ?? 0) & 0x10) !== 0,
    width: uint24(bytes, 24) + 1,
    height: uint24(bytes, 27) + 1,
  };
}

/** Size in the start-of-frame segment of a JPEG. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('JPEG sem marcador onde deveria haver um.');
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
      };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG sem o tamanho da imagem.');
}

describe('arquivos do logo (#166, logo.md)', () => {
  it.each([
    ['tomiyama-logo-96.webp', 96],
    ['tomiyama-logo-320.webp', 320],
  ])('%s: quadrado de %i px, com transparência', async (name, size) => {
    expect(webpInfo(await brandFile(name))).toEqual({ width: size, height: size, alpha: true });
  });

  it('o original é o JPEG de 640×640', async () => {
    expect(jpegSize(await brandFile('tomiyama-logo-original.jpeg'))).toEqual({
      width: 640,
      height: 640,
    });
  });
});

describe('título da aba (#166)', () => {
  it('"Área de exames · Tomiyama"', () => {
    const titles = [...indexHtml.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]);
    expect(titles).toEqual(['Área de exames · Tomiyama']);
  });
});
