import { describe, expect, it } from 'vitest';

import { MOCK_SESSION_KEY, createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_TEMPORARY_PASSWORD, MOCK_USER_IDS } from '../../src/auth/mockConstants';
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
