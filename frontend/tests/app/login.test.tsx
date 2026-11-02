import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MOCK_TEMPORARY_PASSWORD } from '../../src/auth/mockConstants';
import { renderApp } from '../render';

describe('login (§ 6.1)', () => {
  it('has labelled fields and the sign-up link', async () => {
    const { user, router } = await renderApp({ route: '/entrar' });
    expect(await screen.findByLabelText(/E-mail/)).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText(/^Senha/)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Cadastre-se' }));
    expect(router.state.location.pathname).toBe('/cadastro');
    expect(await screen.findByRole('heading', { name: 'Cadastre-se' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Confirme a senha/)).toBeInTheDocument();
  });

  it('signs in any e-mail in simulated mode and goes back to the page asked for', async () => {
    const { user, router } = await renderApp({ route: '/eventos' });
    await user.type(await screen.findByLabelText(/E-mail/), 'prof@example.com');
    await user.type(screen.getByLabelText(/^Senha/), 'qualquer');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: 'Eventos', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/eventos');
    expect(screen.getAllByText('prof@example.com').length).toBeGreaterThan(0);
  });

  it('signs in as guardian when that profile is chosen', async () => {
    const { user } = await renderApp({ route: '/entrar' });
    await user.type(await screen.findByLabelText(/E-mail/), 'mae@example.com');
    await user.type(screen.getByLabelText(/^Senha/), 'qualquer');
    await user.click(screen.getByRole('radio', { name: 'Responsável' }));
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    const menu = await screen.findByRole('navigation', { name: 'Menu principal' });
    expect(menu).toHaveTextContent('Responsável');
    expect(screen.queryByRole('link', { name: 'Faixas' })).not.toBeInTheDocument();
  });

  it('shows the error when e-mail or password is missing', async () => {
    const { user } = await renderApp({ route: '/entrar' });
    await user.click(await screen.findByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o e-mail e a senha.');
  });

  it('asks for a new password on the first login', async () => {
    const { user, router } = await renderApp({ route: '/entrar' });
    await user.type(await screen.findByLabelText(/E-mail/), 'novo@example.com');
    await user.type(screen.getByLabelText(/^Senha/), MOCK_TEMPORARY_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(
      await screen.findByRole('heading', { name: 'Defina uma nova senha' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Nova senha/), 'senha-nova-1');
    await user.type(screen.getByLabelText(/^Confirme a nova senha/), 'outra-senha');
    await user.click(screen.getByRole('button', { name: 'Salvar senha e entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('As senhas não conferem.');

    await user.clear(screen.getByLabelText(/^Confirme a nova senha/));
    await user.type(screen.getByLabelText(/^Confirme a nova senha/), 'senha-nova-1');
    await user.click(screen.getByRole('button', { name: 'Salvar senha e entrar' }));
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/alunos');
  });

  it('skips the login when already signed in', async () => {
    const { router } = await renderApp({ route: '/entrar', signedInAs: 'examiner' });
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/alunos');
  });
});
