/**
 * Erro: na tela "Defina uma nova senha" (primeiro acesso), uma senha só com espaços
 * ("        ", 8 espaços) passa pela validação do formulário, que só confere o
 * comprimento, e o acesso é concluído. O Cognito recusa senha que começa ou termina com
 * espaço, então no ambiente real o usuário recebe um erro genérico depois do envio.
 * Esperado: o formulário recusa a senha vazia ou só com espaços, mostra o erro e continua
 * na tela de nova senha (§ 6.1; § 2: senha com no mínimo 8 caracteres).
 * Issue: -
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MOCK_TEMPORARY_PASSWORD } from '../../src/auth/mockConstants';
import { renderApp } from '../render';

describe('nova senha no primeiro acesso', () => {
  it('não aceita senha só com espaços', async () => {
    const { user, router } = await renderApp({ route: '/entrar' });
    await user.type(await screen.findByLabelText(/E-mail/), 'novo@example.com');
    await user.type(screen.getByLabelText(/^Senha/), MOCK_TEMPORARY_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(
      await screen.findByRole('heading', { name: 'Defina uma nova senha' }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Nova senha/), '        ');
    await user.type(screen.getByLabelText(/^Confirme a nova senha/), '        ');
    await user.click(screen.getByRole('button', { name: 'Salvar senha e entrar' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Defina uma nova senha' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entrar');
  });
});
