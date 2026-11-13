import { describe, expect, it } from 'vitest';

import { createMockAuth } from '../../src/auth/mockAuth';
import {
  MOCK_EXPIRED_CODE,
  MOCK_RESET_CODE,
  MOCK_RESET_REQUIRED_EMAIL,
} from '../../src/auth/mockConstants';

describe('recuperação de senha simulada', () => {
  it('envia o código a qualquer e-mail válido, sem dizer se a conta existe', async () => {
    const auth = createMockAuth(null);
    await expect(auth.resetPassword('ninguem@example.com')).resolves.toBeUndefined();
    await expect(auth.resetPassword('sem-arroba')).rejects.toThrow('Informe um e-mail válido.');
  });

  it('troca a senha com o código fixo', async () => {
    const auth = createMockAuth(null);
    await expect(
      auth.confirmResetPassword('mae@example.com', ` ${MOCK_RESET_CODE} `, 'senha-nova-1'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['', 'senha-nova-1', 'Informe o código.'],
    ['999999', 'senha-nova-1', 'Código incorreto.'],
    [MOCK_EXPIRED_CODE, 'senha-nova-1', 'Código expirado. Peça um novo.'],
    [MOCK_RESET_CODE, 'curta', 'A senha precisa ter pelo menos 8 caracteres.'],
    [MOCK_RESET_CODE, ' senha-nova', 'A senha não pode começar nem terminar com espaço.'],
    [MOCK_RESET_CODE, '   ', 'Informe a nova senha.'],
  ])('recusa o código %j com a senha %j', async (code, password, message) => {
    const auth = createMockAuth(null);
    await expect(auth.confirmResetPassword('mae@example.com', code, password)).rejects.toThrow(
      message,
    );
  });

  it('bloqueia o login do e-mail com senha redefinida até a nova senha', async () => {
    const auth = createMockAuth(null);
    await expect(
      auth.signIn({ email: MOCK_RESET_REQUIRED_EMAIL, password: 'qualquer' }),
    ).rejects.toMatchObject({ code: 'PASSWORD_RESET_REQUIRED' });

    await auth.confirmResetPassword(MOCK_RESET_REQUIRED_EMAIL, MOCK_RESET_CODE, 'senha-nova-1');
    await expect(
      auth.signIn({ email: MOCK_RESET_REQUIRED_EMAIL, password: 'senha-nova-1' }),
    ).resolves.toBe('DONE');
  });
});
