import { describe, expect, it } from 'vitest';

import { MOCK_SESSION_KEY, createMockAuth } from '../../src/auth/mockAuth';
import {
  MOCK_EXISTING_EMAIL,
  MOCK_EXPIRED_CODE,
  MOCK_SIGN_UP_CODE,
  MOCK_TEMPORARY_PASSWORD,
  MOCK_USER_IDS,
} from '../../src/auth/mockConstants';
import { decodeMockToken } from '../../src/auth/mockToken';
import { AuthError, roleFromGroups } from '../../src/auth/types';

describe('createMockAuth', () => {
  it('signs in any e-mail as examiner by default', async () => {
    const auth = createMockAuth(null);
    await expect(auth.signIn({ email: 'qualquer@example.com', password: 'x' })).resolves.toBe(
      'DONE',
    );
    await expect(auth.getCurrentUser()).resolves.toEqual({
      id: MOCK_USER_IDS.examiner,
      email: 'qualquer@example.com',
      role: 'examiner',
      isMaster: false,
    });
  });

  it('issues a token with the Cognito group of the profile', async () => {
    const auth = createMockAuth(null);
    await auth.signIn({ email: 'mae@example.com', password: 'x', role: 'guardian' });
    const token = await auth.getIdToken();
    expect(token && decodeMockToken(token)).toEqual({
      sub: MOCK_USER_IDS.guardian,
      email: 'mae@example.com',
      'cognito:groups': ['responsavel'],
    });
  });

  it('asks for a new password with the temporary password', async () => {
    const auth = createMockAuth(null);
    await expect(
      auth.signIn({ email: 'novo@example.com', password: MOCK_TEMPORARY_PASSWORD }),
    ).resolves.toBe('NEW_PASSWORD_REQUIRED');
    await expect(auth.getCurrentUser()).resolves.toBeNull();
    await expect(auth.confirmNewPassword('curta')).rejects.toThrow(
      'A senha precisa ter pelo menos 8 caracteres.',
    );
    await expect(auth.confirmNewPassword('senha-nova-123')).resolves.toBe('DONE');
    await expect(auth.getCurrentUser()).resolves.toMatchObject({ email: 'novo@example.com' });
  });

  it('rejects an empty e-mail or password', async () => {
    const auth = createMockAuth(null);
    await expect(auth.signIn({ email: ' ', password: 'x' })).rejects.toBeInstanceOf(AuthError);
  });

  it('keeps only e-mail and profile in sessionStorage and clears them on sign-out', async () => {
    const auth = createMockAuth(window.sessionStorage);
    await auth.signIn({ email: 'prof@example.com', password: 'x' });
    expect(JSON.parse(window.sessionStorage.getItem(MOCK_SESSION_KEY) ?? '')).toEqual({
      email: 'prof@example.com',
      role: 'examiner',
    });
    await expect(createMockAuth(window.sessionStorage).getCurrentUser()).resolves.toMatchObject({
      email: 'prof@example.com',
    });
    await auth.signOut();
    expect(window.sessionStorage.getItem(MOCK_SESSION_KEY)).toBeNull();
    await expect(auth.getIdToken()).resolves.toBeNull();
  });
});

describe('roleFromGroups', () => {
  it('maps the Cognito group admin to examiner', () => {
    expect(roleFromGroups(['admin'])).toBe('examiner');
    expect(roleFromGroups(['responsavel'])).toBe('guardian');
    expect(roleFromGroups([])).toBe('guardian');
  });
});

describe('createMockAuth: cadastro simulado', () => {
  it('cria a conta, confirma com o código fixo e entra como responsável', async () => {
    const auth = createMockAuth(null);
    await auth.signUp(' Nova@Example.com ', 'senha-forte-1');
    await expect(auth.getCurrentUser()).resolves.toBeNull();
    await expect(auth.confirmSignUp('nova@example.com', MOCK_SIGN_UP_CODE)).resolves.toBe(
      'SIGNED_IN',
    );
    await expect(auth.getCurrentUser()).resolves.toEqual({
      id: MOCK_USER_IDS.guardian,
      email: 'nova@example.com',
      role: 'guardian',
      isMaster: false,
    });
    const token = await auth.getIdToken();
    expect(token && decodeMockToken(token)?.['cognito:groups']).toEqual(['responsavel']);
  });

  it('recusa e-mail já usado, inclusive o da conta criada', async () => {
    const auth = createMockAuth(null);
    await expect(auth.signUp(MOCK_EXISTING_EMAIL, 'senha-forte-1')).rejects.toThrow(
      'Já existe uma conta com este e-mail.',
    );
    await auth.signUp('nova@example.com', 'senha-forte-1');
    await expect(auth.signUp('NOVA@example.com', 'outra-senha-1')).rejects.toThrow(
      'Já existe uma conta com este e-mail.',
    );
  });

  it('valida e-mail e senha como o Cognito', async () => {
    const auth = createMockAuth(null);
    await expect(auth.signUp('sem-arroba', 'senha-forte-1')).rejects.toThrow(
      'Informe um e-mail válido.',
    );
    await expect(auth.signUp('a@example.com', 'curta')).rejects.toThrow(
      'A senha precisa ter pelo menos 8 caracteres.',
    );
    await expect(auth.signUp('a@example.com', '        ')).rejects.toThrow('Informe a senha.');
    await expect(auth.signUp('a@example.com', ' senha-forte')).rejects.toThrow(
      'A senha não pode começar nem terminar com espaço.',
    );
  });

  it('recusa código errado, expirado ou de conta desconhecida', async () => {
    const auth = createMockAuth(null);
    await auth.signUp('nova@example.com', 'senha-forte-1');
    await expect(auth.confirmSignUp('nova@example.com', '999999')).rejects.toThrow(
      'Código incorreto.',
    );
    await expect(auth.confirmSignUp('nova@example.com', MOCK_EXPIRED_CODE)).rejects.toThrow(
      'Código expirado. Peça um novo.',
    );
    await expect(auth.confirmSignUp('outra@example.com', MOCK_SIGN_UP_CODE)).rejects.toThrow(
      'Código incorreto.',
    );
    await expect(auth.resendSignUpCode('nova@example.com')).resolves.toBeUndefined();
  });

  it('não deixa entrar antes de confirmar o e-mail', async () => {
    const auth = createMockAuth(null);
    await auth.signUp('nova@example.com', 'senha-forte-1');
    await expect(
      auth.signIn({ email: 'nova@example.com', password: 'senha-forte-1' }),
    ).rejects.toMatchObject({
      message: 'Confirme o e-mail antes de entrar.',
      code: 'USER_NOT_CONFIRMED',
    });
  });

  it('não guarda nada do cadastro no storage antes de confirmar', async () => {
    const auth = createMockAuth(window.sessionStorage);
    await auth.signUp('nova@example.com', 'senha-forte-1');
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});
