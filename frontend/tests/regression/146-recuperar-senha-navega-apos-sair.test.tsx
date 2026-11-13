/**
 * Erro: na etapa do e-mail da recuperação de senha, quem clica em "Enviar código" e, antes da
 * resposta, sai da tela ("Voltar para o login" ou o voltar do navegador) é puxado de volta
 * para "Crie uma nova senha" quando a resposta chega (`onSent` navega com `replace` mesmo com
 * a etapa já desmontada, e ainda apaga a entrada do login no histórico).
 * Esperado: a resposta que chega depois de a pessoa sair da etapa não navega; ela continua
 * onde escolheu ir (§ 6.1, § 6.7).
 * Issue: #146
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import type { AuthService } from '../../src/auth/types';
import { renderApp } from '../render';

function slowResetPassword() {
  const base = createMockAuth(null);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resetPassword = vi.fn<AuthService['resetPassword']>(async (email) => {
    await gate;
    return base.resetPassword(email);
  });
  return { auth: { ...base, resetPassword }, release };
}

async function settle() {
  await new Promise((done) => setTimeout(done, 50));
}

describe('#146: resposta do envio do código depois de sair da etapa do e-mail', () => {
  it('"Voltar para o login" durante o envio: continua no login', async () => {
    const { auth, release } = slowResetPassword();
    const app = await renderApp({ route: '/recuperar-senha', auth });
    await app.user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await app.user.click(screen.getByRole('link', { name: 'Voltar para o login' }));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();

    release();
    await settle();

    expect(app.router.state.location.pathname).toBe('/entrar');
    expect(screen.queryByRole('heading', { name: 'Crie uma nova senha' })).not.toBeInTheDocument();
  });

  it('voltar do navegador durante o envio: continua no login', async () => {
    const { auth, release } = slowResetPassword();
    const app = await renderApp({ route: '/entrar', auth });
    await app.user.click(await screen.findByRole('link', { name: 'Esqueci minha senha' }));
    await app.user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
    await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
    await app.router.navigate(-1);
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();

    release();
    await settle();

    expect(app.router.state.location.pathname).toBe('/entrar');
    expect(screen.queryByRole('heading', { name: 'Crie uma nova senha' })).not.toBeInTheDocument();
  });
});
