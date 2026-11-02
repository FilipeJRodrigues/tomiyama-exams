import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { COLOR_SCHEME_KEY } from '../../src/app/theme';
import { renderApp } from '../render';
import { setViewportWidth } from '../viewport';

const EXAMINER_MENU = ['Alunos', 'Dia do exame', 'Faixas', 'Requisitos', 'Eventos', 'Academia'];

async function menu() {
  return screen.findByRole('navigation', { name: 'Menu principal' });
}

describe('layout (§ 6.7)', () => {
  it('shows every menu item to examiners', async () => {
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const links = within(await menu()).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(EXAMINER_MENU);
  });

  it('shows only the students item to guardians', async () => {
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const links = within(await menu()).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Alunos']);
  });

  it('marks the current page in the menu', async () => {
    await renderApp({ route: '/faixas', signedInAs: 'examiner' });
    expect(within(await menu()).getByRole('link', { name: 'Faixas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens and closes the drawer with the burger on a phone', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const burger = await screen.findByRole('button', { name: 'Abrir menu' });
    const nav = await menu();
    expect(burger).toHaveAttribute('aria-expanded', 'false');
    // Closed drawer is out of the tab order.
    expect(nav).toHaveAttribute('inert');

    await user.click(burger);
    expect(burger).toHaveAttribute('aria-expanded', 'true');
    expect(burger).toHaveAccessibleName('Fechar menu');
    expect(nav).not.toHaveAttribute('inert');

    await user.click(burger);
    expect(burger).toHaveAttribute('aria-expanded', 'false');
    expect(nav).toHaveAttribute('inert');
  });

  it('closes the drawer with Esc and returns the focus to the burger', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const burger = await screen.findByRole('button', { name: 'Abrir menu' });
    await user.click(burger);
    within(await menu())
      .getByRole('link', { name: 'Faixas' })
      .focus();

    await user.keyboard('{Escape}');
    expect(burger).toHaveAttribute('aria-expanded', 'false');
    expect(burger).toHaveFocus();
  });

  it('closes the drawer after choosing a page', async () => {
    setViewportWidth(390);
    const { user, router } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const burger = await screen.findByRole('button', { name: 'Abrir menu' });
    await user.click(burger);
    await user.click(within(await menu()).getByRole('link', { name: 'Eventos' }));
    expect(router.state.location.pathname).toBe('/eventos');
    expect(burger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps "Sair" in the header on a phone', async () => {
    setViewportWidth(390);
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    expect(await screen.findByRole('button', { name: 'Sair' })).toBeVisible();
  });

  it('keeps the menu open beside the content on a notebook', async () => {
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    expect(await menu()).not.toHaveAttribute('inert');
  });

  it('switches to the dark theme and remembers it', async () => {
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await user.click(await screen.findByRole('button', { name: 'Usar tema escuro' }));
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'dark');
    expect(window.localStorage.getItem(COLOR_SCHEME_KEY)).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'Usar tema claro' }));
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'light');
    expect(window.localStorage.getItem(COLOR_SCHEME_KEY)).toBe('light');
  });

  it('starts with the saved theme', async () => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, 'dark');
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    expect(await screen.findByRole('button', { name: 'Usar tema claro' })).toBeInTheDocument();
  });

  it('signs out and goes back to the login', async () => {
    const { user, router, auth } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await user.click(await screen.findByRole('button', { name: 'Sair' }));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entrar');
    await expect(auth.getCurrentUser()).resolves.toBeNull();
  });
});
