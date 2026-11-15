/**
 * Tema antes do React (#166): o `index.html` traz o atributo `data-mantine-color-scheme` e um
 * script que lê a escolha salva (`COLOR_SCHEME_KEY`, a chave do `colorSchemeManager`) antes
 * do React, como o `ColorSchemeScript` do Mantine com `defaultColorScheme="dark"`: sem escolha
 * ou com valor inválido, escuro; `auto`, pela preferência do sistema. Assim a página escura
 * não pisca em branco até o React montar. O fundo do `html` antes do CSS do Mantine segue as
 * mesmas cores da página no tema (`dark.7` e branco).
 *
 * O script roda no jsdom do Vitest, que executa scripts da página (`runScripts`), com o
 * `localStorage` e o `matchMedia` da janela.
 */
import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COLOR_SCHEME_KEY, theme } from '../../src/app/theme';
import indexHtml from '../../index.html?raw';

const page = new DOMParser().parseFromString(indexHtml, 'text/html');

/** The inline script (the only `<script>` without `src`). */
function bootScript(): HTMLScriptElement {
  const scripts = [...page.querySelectorAll('script')].filter((script) => !script.src);
  expect(scripts).toHaveLength(1);
  const [script] = scripts;
  if (!script) throw new Error('O index.html deveria ter o script do tema.');
  return script;
}

/**
 * Runs code as a script of the page. jsdom runs it in the page's own window, not in the
 * globals Vitest copied from it: the storage is shared, but the `matchMedia` stub of
 * `tests/setup.ts` is not there.
 */
function runInPage(code: string): void {
  const script = document.createElement('script');
  script.textContent = code;
  document.head.append(script);
  script.remove();
}

/** Runs the script of `index.html`, as the browser does before React. */
function runBootScript(): string | null {
  document.documentElement.removeAttribute('data-mantine-color-scheme');
  runInPage(bootScript().textContent);
  return document.documentElement.getAttribute('data-mantine-color-scheme');
}

/** The system preference the `auto` choice reads, in the page's window. */
function prefersDark(dark: boolean): void {
  runInPage(
    `window.matchMedia = function (query) {
      return { matches: query === '(prefers-color-scheme: dark)' && ${String(dark)}, media: query };
    };`,
  );
}

afterEach(() => {
  runInPage('delete window.matchMedia;');
  vi.restoreAllMocks();
});

describe('tema antes do React (index.html, #166)', () => {
  it('o html já começa escuro, antes de qualquer script', () => {
    expect(page.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark');
  });

  it('o script vem antes do React e do CSS', () => {
    const script = bootScript();
    const app = page.querySelector('script[type="module"]');
    expect(app).not.toBeNull();
    expect(script.parentElement).toBe(page.head);
    expect(
      script.compareDocumentPosition(app as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const stylesheet of page.querySelectorAll('link[rel="stylesheet"]')) {
      expect(
        script.compareDocumentPosition(stylesheet) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('sem escolha salva: escuro', () => {
    expect(runBootScript()).toBe('dark');
  });

  it('escolha salva "light": claro', () => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, 'light');
    expect(runBootScript()).toBe('light');
  });

  it('escolha salva "dark": escuro', () => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, 'dark');
    expect(runBootScript()).toBe('dark');
  });

  it.each([
    [true, 'dark'],
    [false, 'light'],
  ])('escolha salva "auto" com o sistema escuro = %s: %s', (dark, expected) => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, 'auto');
    prefersDark(dark);
    expect(runBootScript()).toBe(expected);
  });

  it.each(['', 'Light', 'azul', 'null'])('valor inválido "%s": escuro', (value) => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, value);
    expect(runBootScript()).toBe('dark');
  });

  it('armazenamento bloqueado: escuro', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    expect(runBootScript()).toBe('dark');
  });

  it('lê a mesma chave do colorSchemeManager', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    runBootScript();
    expect(getItem).toHaveBeenCalledWith(COLOR_SCHEME_KEY);
  });
});

describe('fundo do html antes do CSS do Mantine (index.html, #166)', () => {
  const appTheme = mergeMantineTheme(DEFAULT_THEME, theme);
  const css = [...page.querySelectorAll('style')].map((style) => style.textContent).join('\n');

  /** The fallback of `var(--mantine-color-body, …)` in the rule of the selector. */
  function fallback(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    const color = /background-color:\s*var\(--mantine-color-body,\s*(#[0-9a-f]{6})\)/i.exec(
      rule?.[1] ?? '',
    );
    if (!color?.[1]) throw new Error(`Sem fundo de reserva em ${selector}`);
    return color[1].toLowerCase();
  }

  it('escuro: dark.7 do tema, com color-scheme escuro', () => {
    expect(fallback(':root')).toBe(appTheme.colors.dark[7].toLowerCase());
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/);
  });

  it('claro: branco, com color-scheme claro', () => {
    expect(fallback(":root[data-mantine-color-scheme='light']")).toBe('#ffffff');
    expect(css).toMatch(
      /:root\[data-mantine-color-scheme='light'\]\s*\{[^}]*color-scheme:\s*light/,
    );
  });
});
