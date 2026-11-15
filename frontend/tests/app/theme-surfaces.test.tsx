/**
 * Tema Tomiyama (#166, etapa 1a) medido na tela montada: o CSS do Mantine, o `a11y.css` e as
 * variáveis do tema, com a regra que vence a cascata em cada elemento (`tests/computedCss.ts`).
 *
 * - Superfícies: no escuro, `Paper` (inclusive o `AuthCard`), `Modal` e `Drawer` com o
 *   cabeçalho fixo e o cabeçalho e o menu do `AppShell` ficam em #2A2A2A, sobre o fundo da
 *   página #1C1C1C (o `--mantine-color-body` não muda); no claro, tudo branco.
 * - Controles marcados sobre a cor principal: o polegar do `Switch` ligado, o ponto do `Radio`
 *   e o ícone do `Checkbox` são azuis no escuro (sobre o amarelo) e brancos no claro (sobre o
 *   azul); desligado, o polegar do `Switch` continua branco.
 * - Borda de controle (#737B83 / #8F8F8F) nos campos e no `Button` e no `ActionIcon` `default`.
 */
import {
  ActionIcon,
  Button,
  Checkbox,
  Drawer,
  MantineProvider,
  Modal,
  Paper,
  Radio,
  Switch,
  TextInput,
} from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths } from '../../src/app/navigation';
import { BRAND_COLORS, COLOR_SCHEME_KEY, cssVariablesResolver, theme } from '../../src/app/theme';
import { Styles, hex, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';

type Scheme = 'light' | 'dark';

const SURFACE: Record<Scheme, string> = { light: '#ffffff', dark: '#2a2a2a' };
const PAGE: Record<Scheme, string> = { light: '#ffffff', dark: '#1c1c1c' };
const CONTROL_BORDER: Record<Scheme, string> = { light: '#737b83', dark: '#8f8f8f' };
/** Text, dot and thumb on the filled primary: white on the blue, blue on the yellow. */
const ON_PRIMARY: Record<Scheme, string> = {
  light: '#ffffff',
  dark: BRAND_COLORS.blue.toLowerCase(),
};
const PRIMARY: Record<Scheme, string> = {
  light: BRAND_COLORS.blue.toLowerCase(),
  dark: BRAND_COLORS.yellow.toLowerCase(),
};

const noop = () => undefined;

function renderInTheme(scheme: Scheme, children: ReactNode) {
  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme={scheme}
    >
      {children}
    </MantineProvider>,
  );
  expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
}

function element(found: Element | null | undefined, what: string): HTMLElement {
  if (!(found instanceof HTMLElement) && !(found instanceof SVGElement)) {
    throw new Error(`${what} deveria estar na tela.`);
  }
  return found as HTMLElement;
}

beforeAll(loadStyles);

describe.each<Scheme>(['light', 'dark'])('superfícies no tema %s (#166)', (scheme) => {
  beforeEach(() => {
    installMockApi();
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  it('cabeçalho e menu do AppShell na superfície, sobre o fundo da página', async () => {
    await renderApp({ route: paths.students, signedInAs: 'examiner' });
    const nav = await screen.findByRole('navigation', { name: 'Menu principal' });
    const header = element(document.querySelector('.mantine-AppShell-header'), 'O cabeçalho');
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
    const styles = await Styles.now();
    expect(hex(styles.background(header))).toBe(SURFACE[scheme]);
    expect(hex(styles.background(nav))).toBe(SURFACE[scheme]);
    expect(hex(styles.background(document.body))).toBe(PAGE[scheme]);
  });

  it('cartão da tela de entrada (AuthCard) na superfície', async () => {
    await renderApp({ route: paths.login });
    const title = await screen.findByRole('heading', { name: 'Entrar', level: 1 });
    const card = element(title.closest('.mantine-Paper-root'), 'O cartão');
    const styles = await Styles.now();
    expect(hex(styles.background(card))).toBe(SURFACE[scheme]);
  });

  it('Paper na superfície', async () => {
    renderInTheme(scheme, <Paper>Cartão</Paper>);
    const paper = element(screen.getByText('Cartão').closest('.mantine-Paper-root'), 'O Paper');
    const styles = await Styles.now();
    expect(hex(styles.background(paper))).toBe(SURFACE[scheme]);
  });

  it('Modal na superfície, com o cabeçalho fixo junto', async () => {
    renderInTheme(
      scheme,
      <Modal opened onClose={noop} title="Novo requisito">
        Conteúdo do diálogo
      </Modal>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
    const header = element(dialog.querySelector('.mantine-Modal-header'), 'O cabeçalho');
    const body = element(within(dialog).getByText('Conteúdo do diálogo'), 'O corpo');
    const styles = await Styles.now();
    expect(hex(styles.background(dialog))).toBe(SURFACE[scheme]);
    expect(hex(styles.background(header))).toBe(SURFACE[scheme]);
    expect(hex(styles.background(body))).toBe(SURFACE[scheme]);
  });

  it('Drawer na superfície, com o cabeçalho fixo junto', async () => {
    renderInTheme(
      scheme,
      <Drawer opened onClose={noop} title="Decidir o exame" position="bottom">
        Conteúdo da gaveta
      </Drawer>,
    );
    const drawer = await screen.findByRole('dialog', { name: 'Decidir o exame' });
    const header = element(drawer.querySelector('.mantine-Drawer-header'), 'O cabeçalho');
    const styles = await Styles.now();
    expect(hex(styles.background(drawer))).toBe(SURFACE[scheme]);
    expect(hex(styles.background(header))).toBe(SURFACE[scheme]);
  });
});

describe.each<Scheme>(['light', 'dark'])(
  'controles marcados sobre a cor principal no tema %s (#166)',
  (scheme) => {
    it('Switch ligado: trilho na cor principal e polegar na cor de contraste', async () => {
      renderInTheme(scheme, <Switch label="Ativo" checked onChange={noop} />);
      const input = screen.getByRole('switch', { name: 'Ativo' });
      const track = element(input.nextElementSibling, 'O trilho');
      const thumb = element(track.querySelector('.mantine-Switch-thumb'), 'O polegar');
      const styles = await Styles.now();
      expect(hex(styles.background(track))).toBe(PRIMARY[scheme]);
      expect(hex(styles.background(thumb))).toBe(ON_PRIMARY[scheme]);
    });

    it('Switch desligado: polegar branco', async () => {
      renderInTheme(scheme, <Switch label="Só não marcados" checked={false} onChange={noop} />);
      const input = screen.getByRole('switch', { name: 'Só não marcados' });
      const thumb = element(
        input.nextElementSibling?.querySelector('.mantine-Switch-thumb'),
        'O polegar',
      );
      const styles = await Styles.now();
      expect(hex(styles.background(thumb))).toBe('#ffffff');
    });

    it('Radio marcado: ponto na cor de contraste sobre a cor principal', async () => {
      renderInTheme(scheme, <Radio label="Examinador" checked onChange={noop} />);
      const input = screen.getByRole('radio', { name: 'Examinador' });
      const dot = element(input.parentElement?.querySelector('.mantine-Radio-icon'), 'O ponto');
      const styles = await Styles.now();
      expect(hex(styles.background(input))).toBe(PRIMARY[scheme]);
      expect(hex(styles.textColor(dot))).toBe(ON_PRIMARY[scheme]);
    });

    it('Checkbox marcado: ícone na cor de contraste sobre a cor principal', async () => {
      renderInTheme(scheme, <Checkbox label="Presente" checked onChange={noop} />);
      const input = screen.getByRole('checkbox', { name: 'Presente' });
      const icon = element(input.parentElement?.querySelector('.mantine-Checkbox-icon'), 'O ícone');
      const styles = await Styles.now();
      expect(hex(styles.background(input))).toBe(PRIMARY[scheme]);
      expect(hex(styles.textColor(icon))).toBe(ON_PRIMARY[scheme]);
    });

    it('texto do botão cheio da cor principal', async () => {
      renderInTheme(scheme, <Button>Salvar</Button>);
      const button = screen.getByRole('button', { name: 'Salvar' });
      const styles = await Styles.now();
      expect(hex(styles.background(button))).toBe(PRIMARY[scheme]);
      expect(hex(styles.textColor(button))).toBe(ON_PRIMARY[scheme]);
    });
  },
);

describe.each<Scheme>(['light', 'dark'])('borda de controle no tema %s (#166)', (scheme) => {
  it('Button default (Sair)', async () => {
    renderInTheme(scheme, <Button variant="default">Sair</Button>);
    const styles = await Styles.now();
    const button = screen.getByRole('button', { name: 'Sair' });
    expect(hex(styles.borderColor(button))).toBe(CONTROL_BORDER[scheme]);
  });

  it('ActionIcon default (Tema)', async () => {
    renderInTheme(
      scheme,
      <ActionIcon variant="default" aria-label="Usar tema claro">
        ☀
      </ActionIcon>,
    );
    const styles = await Styles.now();
    const button = screen.getByRole('button', { name: 'Usar tema claro' });
    expect(hex(styles.borderColor(button))).toBe(CONTROL_BORDER[scheme]);
  });

  it('campo de texto', async () => {
    renderInTheme(scheme, <TextInput label="Nome" />);
    const styles = await Styles.now();
    const field = screen.getByRole('textbox', { name: 'Nome' });
    expect(hex(styles.borderColor(field))).toBe(CONTROL_BORDER[scheme]);
  });

  it('o Button de outra variante não ganha a borda de controle', async () => {
    renderInTheme(scheme, <Button variant="light">Excluir aluno</Button>);
    const styles = await Styles.now();
    const button = screen.getByRole('button', { name: 'Excluir aluno' });
    expect(styles.declared(button, ['--button-bd'])?.value ?? '').not.toContain(
      '--app-control-border',
    );
  });
});
