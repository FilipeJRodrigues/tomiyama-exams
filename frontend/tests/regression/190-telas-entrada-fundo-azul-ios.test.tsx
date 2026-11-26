/**
 * Erro: num iPhone 14 com Safari (site do dev, depois da etapa 3 do #166), nas telas de entrada
 * (login, cadastro, esqueci a senha), ao arrastar a página para cima ou para baixo aparece uma
 * área cinza-carvão (o fundo do tema escuro) acima ou abaixo do azul. No login, o azul termina
 * pouco abaixo do cartão e o resto da tela, até a barra do Safari, fica cinza.
 * Esperado: a tela de entrada toda no azul da marca (`--app-brand-bg`, #0A265F), também na
 * rolagem elástica do iOS e atrás das barras do Safari, nos dois temas (§ 6.7; skill
 * `tomiyama-design`, `components.md`, "Telas de entrada" e "Áreas de marca (azul)").
 * Issue: #190
 *
 * Por que o `body`: o WebKit pinta a área além da página (a rolagem elástica) e o fundo da
 * `UIScrollView` do iOS, que aparece atrás das barras do Safari onde a página não chega, com a
 * cor de fundo do documento: a do `html` e, por cima, a do `body`
 * (`LocalFrameView::documentBackgroundColor`; o `underPageBackgroundColor` do `WKWebView` diz
 * "using the background colors of the <html> and <body> elements"). Hoje o `html` já fica azul
 * nas telas de entrada, mas o `body` continua com o fundo opaco do tema que o Mantine põe nele
 * (`--mantine-color-body`), e é essa cor que o Safari mostra.
 *
 * Como o teste mede: em cada tela de entrada real (login; "Defina uma nova senha" do primeiro
 * acesso; cadastro; "Confirme seu e-mail" do cadastro; recuperar senha, nas duas etapas), nos
 * dois temas (o escuro sem escolha salva, como na primeira visita), a cor de fundo calculada do
 * `body` e do `html` (`tests/computedCss.ts`: o CSS do Mantine e de `src/`, os `<style>` da
 * página e o `<style>` do `index.html`, este antes do CSS do app, como no navegador). Vale
 * qualquer jeito de corrigir (seletor, variável, `inherit`, estilo inline): conta a cor
 * resolvida. Medida no iPhone 14 em pé (390×844, tela de toque) e num Mac (1280×800, mouse),
 * que também tem rolagem elástica.
 *
 * Guardas, que já passam hoje: ao entrar (Cognito simulado → Academia), o `body` e o `html`
 * voltam ao fundo do tema (dark.7 / branco); o `main` da tela de entrada continua com altura
 * mínima da janela, com `100vh` de reserva num navegador sem `dvh`. Já cobertos em
 * `tests/app/auth-brand-area.test.tsx`, e não repetidos aqui: `min-height: 100dvh` sem altura
 * fixa no `main`, e o cartão na superfície do tema (branco / #2A2A2A), que mudaria se a correção
 * trocasse o `--mantine-color-body` da página inteira.
 */
import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';
import { screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { BRAND_COLORS, COLOR_SCHEME_KEY, theme } from '../../src/app/theme';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_TEMPORARY_PASSWORD } from '../../src/auth/mockConstants';
import indexHtml from '../../index.html?raw';
import { BEFORE_APP_CSS, Styles, hex, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setTouchScreen, setViewportHeight, setViewportWidth } from '../viewport';

type Scheme = 'dark' | 'light';

const BLUE = BRAND_COLORS.blue.toLowerCase();

const appTheme = mergeMantineTheme(DEFAULT_THEME, theme);

/** The page color of each scheme (`--mantine-color-body`): dark.7 and white. */
const PAGE: Record<Scheme, string> = {
  dark: appTheme.colors.dark[7].toLowerCase(),
  light: '#ffffff',
};

interface Device {
  name: string;
  width: number;
  height: number;
  touch: boolean;
}

/** The phone of the report and a Mac, whose Safari also bounces past the page. */
const DEVICES: readonly Device[] = [
  { name: 'iPhone 14', width: 390, height: 844, touch: true },
  { name: 'Mac', width: 1280, height: 800, touch: false },
];

function setDevice(device: Device): void {
  setTouchScreen(device.touch);
  setViewportWidth(device.width);
  setViewportHeight(device.height);
}

interface EntryScreen {
  name: string;
  title: string;
  reach: () => Promise<unknown>;
}

const SCREENS: readonly EntryScreen[] = [
  {
    name: 'login',
    title: 'Entrar',
    reach: () => renderApp({ route: paths.login }),
  },
  {
    name: 'primeiro acesso (nova senha)',
    title: 'Defina uma nova senha',
    reach: async () => {
      const { user } = await renderApp({ route: paths.login });
      await user.type(await screen.findByLabelText(/^E-mail/), 'novo@example.com');
      await user.type(screen.getByLabelText(/^Senha/), MOCK_TEMPORARY_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Entrar' }));
    },
  },
  {
    name: 'cadastro',
    title: 'Cadastre-se',
    reach: () => renderApp({ route: paths.signUp }),
  },
  {
    name: 'código do cadastro',
    title: 'Confirme seu e-mail',
    reach: async () => {
      const { user } = await renderApp({ route: paths.signUp, auth: createMockAuth(null) });
      await user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
      await user.type(screen.getByLabelText(/^Senha/), 'senha-forte-1');
      await user.type(screen.getByLabelText(/^Confirme a senha/), 'senha-forte-1');
      await user.click(screen.getByRole('button', { name: 'Criar conta' }));
    },
  },
  {
    name: 'recuperar senha',
    title: 'Recuperar senha',
    reach: () => renderApp({ route: paths.forgotPassword }),
  },
  {
    name: 'nova senha da recuperação',
    title: 'Crie uma nova senha',
    reach: async () => {
      const { user } = await renderApp({ route: paths.forgotPassword });
      await user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
      await user.click(screen.getByRole('button', { name: 'Enviar código' }));
    },
  },
];

/** The `<style>` of `index.html`, which the page has before the app's CSS. */
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

/** Background of the `body` and of the `html` on each device: `{ 'iPhone 14 · body': … }`. */
async function backgrounds(): Promise<Record<string, string>> {
  const measured: Record<string, string> = {};
  for (const device of DEVICES) {
    setDevice(device);
    const styles = await Styles.now();
    measured[`${device.name} · body`] = hex(styles.background(document.body));
    measured[`${device.name} · html`] = hex(styles.background(document.documentElement));
  }
  return measured;
}

function everywhere(color: string): Record<string, string> {
  const expected: Record<string, string> = {};
  for (const device of DEVICES) {
    expected[`${device.name} · body`] = color;
    expected[`${device.name} · html`] = color;
  }
  return expected;
}

beforeAll(loadStyles);

beforeEach(() => {
  installMockApi();
  addIndexHtmlStyles();
  const [phone] = DEVICES;
  if (phone) setDevice(phone);
});

afterEach(() => {
  for (const style of indexStyles) style.remove();
  indexStyles = [];
});

describe.each<Scheme>(['dark', 'light'])('telas de entrada no tema %s (#190)', (scheme) => {
  beforeEach(() => {
    // Dark is the first visit's default: no saved choice.
    if (scheme === 'light') window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  it.each(SCREENS)(
    '$name: body e html no azul da marca (rolagem elástica e barras do Safari)',
    async (entry) => {
      await entry.reach();
      await screen.findByRole('heading', { level: 1, name: entry.title });
      expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);

      expect(await backgrounds()).toEqual(everywhere(BLUE));
    },
  );

  it('guarda: ao entrar (Cognito simulado → Academia), body e html voltam ao fundo do tema', async () => {
    const { user } = await renderApp({ route: paths.academy });
    await user.type(await screen.findByLabelText(/^E-mail/), 'examinador@example.com');
    await user.type(screen.getByLabelText(/^Senha/), 'senha-teste');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await screen.findByRole('heading', { level: 1, name: 'Academia' });
    expect(screen.queryByRole('heading', { level: 1, name: 'Entrar' })).toBeNull();
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);

    expect(await backgrounds()).toEqual(everywhere(PAGE[scheme]));
  });
});

describe('guarda: altura da tela de entrada (#190)', () => {
  it('num navegador sem dvh, o main ainda cobre a janela: min-height 100vh', async () => {
    await renderApp({ route: paths.login });
    await screen.findByRole('heading', { level: 1, name: 'Entrar' });
    const main = screen.getByRole('main');
    const styles = await Styles.now();
    const withoutDvh = styles.declared(main, ['min-height'], {
      skip: ({ value }) => /dvh/i.test(value),
    });
    expect(withoutDvh && styles.resolve(main, withoutDvh.value)).toBe('100vh');
  });
});
