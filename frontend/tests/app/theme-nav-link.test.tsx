/**
 * Menu lateral (#166, etapa 2; skill `tomiyama-design`, `components.md`, "Cabeçalho e menu
 * lateral"; § 6.7), nos dois temas, medido na tela montada (`tests/computedCss.ts`, com o
 * hover simulado por `Styles.now({ hover })`):
 *
 * - itens com ícone e texto na cor normal do texto; hover em `gray.0` (claro) e `dark.5`
 *   (escuro), diferente do menu (o hover padrão do escuro é `dark.6`, a cor do menu);
 * - item ativo (`aria-current="page"`): texto e ícone na cor principal e em negrito, sem fundo
 *   próprio (em repouso, o menu; no hover, o mesmo hover dos outros itens), com uma barra
 *   vertical de 3 a 4 px na cor principal na borda esquerda, sem deslocar o rótulo;
 * - contraste do ativo sobre o menu e sobre o hover (a skill dá azul 14,4:1 e 13,7:1; amarelo
 *   11,7:1 e 9,2:1), com as cores tiradas do tema;
 * - o anel de foco do ativo fica fora da barra e visível sobre o menu;
 * - a gaveta do celular segue o mesmo visual.
 */
import {
  DEFAULT_THEME,
  mergeMantineTheme,
  type MantineColorsTuple,
  type MantineTheme,
} from '@mantine/core';
import { act, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { BRAND_COLORS, COLOR_SCHEME_KEY, theme } from '../../src/app/theme';
import { Styles, contrast, expectContrast, hex, loadStyles, type Rgb } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

type Scheme = 'light' | 'dark';

const MIN_TEXT = 4.5;
const MIN_INDICATOR = 3;

const appTheme: MantineTheme = mergeMantineTheme(DEFAULT_THEME, theme);

function shades(name: string): MantineColorsTuple {
  const tuple = appTheme.colors[name];
  if (!tuple) throw new Error(`Cor fora do tema: ${name}`);
  return tuple;
}

/** `#fff` and `#FFFFFF` as `#ffffff`, the form `hex()` gives. */
function sixDigits(color: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const full = short
    ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
    : color;
  return full.toLowerCase();
}

/** From the theme: the real primary color, the menu (surface) and the hover of the items. */
const PRIMARY: Record<Scheme, string> = {
  light: sixDigits(BRAND_COLORS.blue),
  dark: sixDigits(BRAND_COLORS.yellow),
};
const MENU: Record<Scheme, string> = {
  light: sixDigits(appTheme.white),
  dark: sixDigits(shades('dark')[6]),
};
const HOVER: Record<Scheme, string> = {
  light: sixDigits(shades('gray')[0]),
  dark: sixDigits(shades('dark')[5]),
};

/** Contrast of the active item in the skill (`components.md`): on the menu, on the hover. */
const SKILL_RATIOS: Record<Scheme, { menu: number; hover: number }> = {
  light: { menu: 14.4, hover: 13.7 },
  dark: { menu: 11.7, hover: 9.2 },
};

function rgbOf(color: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) throw new Error(`Cor não reconhecida: ${color}`);
  const digits = match[1] ?? '';
  const channel = (i: number) => parseInt(digits.slice(i, i + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

/** A property that inherits: the value on the element or on its nearest ancestor. */
function inherited(styles: Styles, target: Element, prop: string): string | null {
  for (let current: Element | null = target; current; current = current.parentElement) {
    const winner = styles.declared(current, [prop]);
    if (winner) return styles.resolve(current, winner.value);
  }
  return null;
}

/** Width (px) and color of the left bar, or null when the item has none. */
function leftBar(styles: Styles, item: Element): { width: number; color: string } | null {
  const winner = styles.declared(item, ['border-inline-start', 'border-left', 'border']);
  if (winner === null) return null;
  const value = styles.resolve(item, winner.value);
  if (/^(0|none)\b/.test(value)) return null;
  const rem = /([\d.]+)rem/.exec(value);
  const px = /([\d.]+)px/.exec(value);
  const color = /#[0-9a-f]{6}\b/i.exec(value);
  if (!color || (!rem && !px)) throw new Error(`Barra não reconhecida: "${value}"`);
  const width = rem ? Number(rem[1]) * 16 : Number(px?.[1]);
  return { width, color: color[0].toLowerCase() };
}

async function menu(): Promise<HTMLElement> {
  return screen.findByRole('navigation', { name: 'Menu principal' });
}

function label(item: HTMLElement): HTMLElement {
  const found = item.querySelector('.mantine-NavLink-label');
  if (!(found instanceof HTMLElement)) throw new Error('O item deveria ter o rótulo.');
  return found;
}

function icon(item: HTMLElement): Element {
  const found = item.querySelector('svg');
  if (!found) throw new Error('O item deveria ter o ícone.');
  return found;
}

beforeAll(loadStyles);

describe.each<Scheme>(['light', 'dark'])('menu lateral no tema %s (#166)', (scheme) => {
  beforeEach(() => {
    installMockApi();
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  async function openAt(route: string) {
    const app = await renderApp({ route, signedInAs: 'examiner' });
    const nav = await menu();
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
    return { app, nav };
  }

  it('itens na cor do texto, sem fundo próprio, sem barra nem negrito', async () => {
    const { nav } = await openAt(paths.belts);
    const item = within(nav).getByRole('link', { name: 'Alunos' });
    expect(item).not.toHaveAttribute('aria-current');
    const styles = await Styles.now();
    const text = hex(styles.textColor(label(item)));
    expect(text).toBe(hex(styles.textColor(nav)));
    expect(hex(styles.textColor(icon(item)))).toBe(text);
    expect(hex(styles.background(item))).toBe(MENU[scheme]);
    expect(leftBar(styles, item)).toBeNull();
    expect(inherited(styles, label(item), 'font-weight')).not.toBe('700');
  });

  it('hover dos itens em gray.0 / dark.5, com o texto legível', async () => {
    const { nav } = await openAt(paths.belts);
    const item = within(nav).getByRole('link', { name: 'Alunos' });
    const styles = await Styles.now({ hover: item });
    const background = styles.background(item);
    expect(hex(background)).toBe(HOVER[scheme]);
    expect(hex(background)).not.toBe(MENU[scheme]);
    expectContrast('texto do item em hover', styles.textColor(label(item)), background, MIN_TEXT);
  });

  it('item ativo: cor principal e negrito, sem fundo próprio, com a barra', async () => {
    const { nav } = await openAt(paths.belts);
    const item = within(nav).getByRole('link', { name: 'Faixas' });
    expect(item).toHaveAttribute('aria-current', 'page');
    const styles = await Styles.now();
    expect(hex(styles.textColor(label(item)))).toBe(PRIMARY[scheme]);
    expect(hex(styles.textColor(icon(item)))).toBe(PRIMARY[scheme]);
    expect(inherited(styles, label(item), 'font-weight')).toBe('700');
    // No background of its own: what shows behind it is the menu.
    expect(styles.backgroundOwner(item)).toBe(nav);
    expect(hex(styles.background(item))).toBe(MENU[scheme]);

    const bar = leftBar(styles, item);
    expect(bar?.color).toBe(PRIMARY[scheme]);
    expect(bar?.width).toBeGreaterThanOrEqual(3);
    expect(bar?.width).toBeLessThanOrEqual(4);
  });

  it('item ativo em hover: o mesmo hover dos outros itens, não o fundo light do Mantine', async () => {
    const { nav } = await openAt(paths.belts);
    const item = within(nav).getByRole('link', { name: 'Faixas' });
    const other = within(nav).getByRole('link', { name: 'Eventos' });
    const otherHover = hex((await Styles.now({ hover: other })).background(other));
    const styles = await Styles.now({ hover: item });
    expect(hex(styles.background(item))).toBe(HOVER[scheme]);
    expect(hex(styles.background(item))).toBe(otherHover);
    expect(hex(styles.textColor(label(item)))).toBe(PRIMARY[scheme]);
    expect(leftBar(styles, item)?.color).toBe(PRIMARY[scheme]);
  });

  it('contraste do ativo sobre o menu e sobre o hover (texto 4,5:1; barra 3:1)', async () => {
    const { nav } = await openAt(paths.belts);
    const item = within(nav).getByRole('link', { name: 'Faixas' });
    const atRest = await Styles.now();
    const text = atRest.textColor(label(item));
    const menuColor = atRest.background(item);
    const hovered = await Styles.now({ hover: item });
    const hoverColor = hovered.background(item);
    expectContrast('texto do ativo sobre o menu', text, menuColor, MIN_TEXT);
    expectContrast('texto do ativo sobre o hover', text, hoverColor, MIN_TEXT);
    const bar = rgbOf(leftBar(hovered, item)?.color ?? '');
    expectContrast('barra do ativo sobre o menu', bar, menuColor, MIN_INDICATOR);
    expectContrast('barra do ativo sobre o hover', bar, hoverColor, MIN_INDICATOR);
    // The values of the skill, worked out from the colors of the theme.
    expect(contrast(rgbOf(PRIMARY[scheme]), rgbOf(MENU[scheme]))).toBeCloseTo(
      SKILL_RATIOS[scheme].menu,
      1,
    );
    expect(contrast(rgbOf(PRIMARY[scheme]), rgbOf(HOVER[scheme]))).toBeCloseTo(
      SKILL_RATIOS[scheme].hover,
      1,
    );
  });

  it('o rótulo do ativo não sai do lugar: a barra toma o lugar do recuo', async () => {
    const { nav } = await openAt(paths.belts);
    const active = within(nav).getByRole('link', { name: 'Faixas' });
    const styles = await Styles.now();
    const bar = styles.declared(active, ['border-inline-start'])?.value ?? '';
    const width = bar.split(/\s+solid\s+/)[0] ?? '';
    const padding = styles.declared(active, ['padding-inline-start'])?.value;
    expect(width).not.toBe('');
    expect(padding).toBe(`calc(var(--mantine-spacing-sm) - ${width})`);
  });

  it('anel de foco do ativo fora da barra, visível sobre o menu', async () => {
    const { nav } = await openAt(paths.belts);
    const item = within(nav).getByRole('link', { name: 'Faixas' });
    act(() => {
      item.focus();
    });
    expect(item).toHaveFocus();
    const styles = await Styles.now();
    const ring = styles.focusRingColor(item);
    expect(hex(ring)).toBe(PRIMARY[scheme]);
    expectContrast('anel de foco do ativo sobre o menu', ring, styles.background(nav), 3);
    const offset = styles.declared(item, ['outline-offset']);
    expect(offset && styles.resolve(item, offset.value)).toMatch(/^calc\(0\.125rem/);
  });

  it('a 390 px, na gaveta: o mesmo visual', async () => {
    setViewportWidth(390);
    const { app, nav } = await openAt(paths.belts);
    await app.user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    expect(nav).not.toHaveAttribute('inert');
    const item = within(nav).getByRole('link', { name: 'Faixas' });
    const other = within(nav).getByRole('link', { name: 'Alunos' });
    let styles = await Styles.now();
    expect(hex(styles.background(nav))).toBe(MENU[scheme]);
    expect(hex(styles.textColor(label(item)))).toBe(PRIMARY[scheme]);
    expect(inherited(styles, label(item), 'font-weight')).toBe('700');
    expect(leftBar(styles, item)?.color).toBe(PRIMARY[scheme]);
    expect(hex(styles.background(item))).toBe(MENU[scheme]);
    styles = await Styles.now({ hover: other });
    expect(hex(styles.background(other))).toBe(HOVER[scheme]);
  });
});
