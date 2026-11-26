/**
 * Cobertura do qa-frontend no #190: o fundo do documento (`html` e `body`) nas trocas entre a
 * área logada e as telas de entrada, nos dois sentidos, que o teste de regressão
 * `tests/regression/190-telas-entrada-fundo-azul-ios.test.tsx` não percorre:
 *
 * - rota protegida sem sessão (`/academia`) → login azul → entrar → fundo do tema → "Sair" →
 *   login azul de novo → entrar outra vez → fundo do tema, sem estilo inline sobrando;
 * - o tema trocado por outra aba (evento `storage`) com o login aberto: `html` e `body` seguem
 *   no azul da marca e o cartão passa para a superfície do novo tema.
 *
 * Mede a cor calculada com o CSS do app, os `<style>` do Mantine e o `<style>` do `index.html`
 * antes do CSS do app, como no navegador (`tests/computedCss.ts`).
 */
import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';
import { screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { BRAND_COLORS, COLOR_SCHEME_KEY, theme } from '../../src/app/theme';
import indexHtml from '../../index.html?raw';
import { BEFORE_APP_CSS, Styles, hex, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp, type RenderAppResult } from '../render';

type Scheme = 'dark' | 'light';

const BLUE = BRAND_COLORS.blue.toLowerCase();
const appTheme = mergeMantineTheme(DEFAULT_THEME, theme);
/** The page color of each scheme (`--mantine-color-body`): dark.7 and white. */
const PAGE: Record<Scheme, string> = {
  dark: appTheme.colors.dark[7].toLowerCase(),
  light: '#ffffff',
};
/** The surface of the card (`--app-surface`): dark.6 and white. */
const SURFACE: Record<Scheme, string> = {
  dark: appTheme.colors.dark[6].toLowerCase(),
  light: '#ffffff',
};

let indexStyles: HTMLStyleElement[] = [];

function addIndexHtmlStyles(): void {
  const page = new DOMParser().parseFromString(indexHtml, 'text/html');
  indexStyles = [...page.querySelectorAll('style')].map((style) => {
    const copy = document.createElement('style');
    copy.setAttribute(BEFORE_APP_CSS, '');
    copy.textContent = style.textContent;
    document.head.append(copy);
    return copy;
  });
  expect(indexStyles.length).toBeGreaterThan(0);
}

async function documentBackground(): Promise<{ html: string; body: string }> {
  const styles = await Styles.now();
  return {
    html: hex(styles.background(document.documentElement)),
    body: hex(styles.background(document.body)),
  };
}

function noInlineBackground(): void {
  for (const element of [document.documentElement, document.body]) {
    expect(element.getAttribute('style') ?? '').not.toMatch(/background/i);
  }
}

async function signIn(user: RenderAppResult['user'], email: string): Promise<void> {
  await user.type(await screen.findByLabelText(/^E-mail/), email);
  await user.type(screen.getByLabelText(/^Senha/), 'senha-teste');
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

beforeAll(loadStyles);

beforeEach(() => {
  installMockApi();
  addIndexHtmlStyles();
});

afterEach(() => {
  for (const style of indexStyles) style.remove();
  indexStyles = [];
});

describe.each<Scheme>(['dark', 'light'])('fundo do documento no tema %s (#190)', (scheme) => {
  beforeEach(() => {
    // Dark is the first visit's default: no saved choice.
    if (scheme === 'light') window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  it('rota protegida → login azul → entrar → tema → Sair → login azul → entrar → tema', async () => {
    const { user } = await renderApp({ route: paths.academy });
    await screen.findByRole('heading', { level: 1, name: 'Entrar' });
    expect(await documentBackground()).toEqual({ html: BLUE, body: BLUE });

    await signIn(user, 'examinador@example.com');
    await screen.findByRole('heading', { level: 1, name: 'Academia' });
    expect(await documentBackground()).toEqual({ html: PAGE[scheme], body: PAGE[scheme] });
    noInlineBackground();

    await user.click(await screen.findByRole('button', { name: 'Sair' }));
    await screen.findByRole('heading', { level: 1, name: 'Entrar' });
    expect(await documentBackground()).toEqual({ html: BLUE, body: BLUE });

    await signIn(user, 'examinador@example.com');
    // Back in the signed-in area (wherever the login sends it).
    await screen.findByRole('button', { name: 'Sair' });
    expect(screen.queryByRole('heading', { level: 1, name: 'Entrar' })).toBeNull();
    expect(await documentBackground()).toEqual({ html: PAGE[scheme], body: PAGE[scheme] });
    noInlineBackground();
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
  });

  it('tema trocado por outra aba com o login aberto: html e body seguem azuis', async () => {
    const other: Scheme = scheme === 'dark' ? 'light' : 'dark';
    await renderApp({ route: paths.login });
    const title = await screen.findByRole('heading', { level: 1, name: 'Entrar' });
    act(() => {
      window.localStorage.setItem(COLOR_SCHEME_KEY, other);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: COLOR_SCHEME_KEY,
          newValue: other,
          storageArea: window.localStorage,
        }),
      );
    });
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', other);

    expect(await documentBackground()).toEqual({ html: BLUE, body: BLUE });
    const card = title.closest('.mantine-Paper-root');
    expect(card).not.toBeNull();
    const styles = await Styles.now();
    expect(hex(styles.background(card as Element))).toBe(SURFACE[other]);
    expect(within(card as HTMLElement).getByRole('button', { name: 'Entrar' })).toBeVisible();
  });
});
