import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import type { AuthService, SignInStep } from '../../src/auth/types';
import { renderApp } from '../render';

describe('login: envio duplo', () => {
  it('chama o login uma vez só com cliques repetidos e Enter durante o envio', async () => {
    const base = createMockAuth(window.sessionStorage);
    let finish: () => void = () => undefined;
    const signIn = vi.fn<AuthService['signIn']>(
      (input) =>
        new Promise<SignInStep>((resolve) => {
          finish = () => {
            void base.signIn(input).then(resolve);
          };
        }),
    );
    const auth: AuthService = { ...base, signIn };
    const { user } = await renderApp({ route: '/entrar', auth });

    await user.type(await screen.findByLabelText(/E-mail/), 'prof@example.com');
    await user.type(screen.getByLabelText(/^Senha/), 'qualquer');
    const button = screen.getByRole('button', { name: 'Entrar' });
    await user.click(button);
    await user.click(button);
    await user.type(screen.getByLabelText(/^Senha/), '{Enter}');

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    finish();
    expect(await screen.findByRole('heading', { name: 'Alunos', level: 1 })).toBeInTheDocument();
  });
});
