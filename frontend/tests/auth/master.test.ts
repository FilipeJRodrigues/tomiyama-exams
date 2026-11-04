/**
 * Admin master (§ 2, `backend/README.md`): an examiner in the groups `master` and `admin`. Only
 * `master`, without `admin`, is neither master nor examiner. The Cognito login reads it from
 * the `cognito:groups` claim; the simulated login has a master e-mail (`MOCK_MASTER_EMAIL`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const amplify = vi.hoisted(() => ({
  configure: vi.fn(),
  fetchAuthSession: vi.fn(),
}));

vi.mock('aws-amplify', () => ({ Amplify: { configure: amplify.configure } }));
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: amplify.fetchAuthSession }));

import { createCognitoAuth } from '../../src/auth/cognitoAuth';
import { MOCK_SESSION_KEY, createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_MASTER_EMAIL, MOCK_MASTER_ID, MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { decodeMockToken } from '../../src/auth/mockToken';
import { isMasterFromGroups } from '../../src/auth/types';

const config = { userPoolId: 'us-east-2_example', clientId: 'client-example' };

describe('isMasterFromGroups', () => {
  it('needs master and admin together', () => {
    expect(isMasterFromGroups(['admin', 'master'])).toBe(true);
    expect(isMasterFromGroups(['master', 'admin', 'responsavel'])).toBe(true);
    expect(isMasterFromGroups(['master'])).toBe(false);
    expect(isMasterFromGroups(['admin'])).toBe(false);
    expect(isMasterFromGroups(['responsavel', 'master'])).toBe(false);
    expect(isMasterFromGroups([])).toBe(false);
  });
});

describe('createCognitoAuth: master from the token', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function sessionWithGroups(groups: unknown) {
    amplify.fetchAuthSession.mockResolvedValue({
      tokens: {
        idToken: {
          payload: { sub: 'sub-1', email: 'prof@example.com', 'cognito:groups': groups },
          toString: () => 'id-token',
        },
      },
    });
  }

  it('is master with the groups master and admin', async () => {
    sessionWithGroups(['admin', 'master']);
    await expect(createCognitoAuth(config).getCurrentUser()).resolves.toEqual({
      id: 'sub-1',
      email: 'prof@example.com',
      role: 'examiner',
      isMaster: true,
    });
  });

  it('only master, without admin, is neither master nor examiner', async () => {
    sessionWithGroups(['master']);
    await expect(createCognitoAuth(config).getCurrentUser()).resolves.toMatchObject({
      role: 'guardian',
      isMaster: false,
    });
  });

  it('a plain examiner, or a claim that is not a list, is not master', async () => {
    sessionWithGroups(['admin']);
    await expect(createCognitoAuth(config).getCurrentUser()).resolves.toMatchObject({
      role: 'examiner',
      isMaster: false,
    });
    sessionWithGroups('admin,master');
    await expect(createCognitoAuth(config).getCurrentUser()).resolves.toMatchObject({
      isMaster: false,
    });
  });
});

describe('createMockAuth: the simulated master', () => {
  it('signs in the master e-mail as examiner master, with both groups in the token', async () => {
    const auth = createMockAuth(null);
    await auth.signIn({ email: ' Master@Example.com ', password: 'x', role: 'examiner' });
    await expect(auth.getCurrentUser()).resolves.toEqual({
      id: MOCK_MASTER_ID,
      email: 'Master@Example.com',
      role: 'examiner',
      isMaster: true,
    });
    const token = await auth.getIdToken();
    expect(token && decodeMockToken(token)).toEqual({
      sub: MOCK_MASTER_ID,
      email: 'Master@Example.com',
      'cognito:groups': ['admin', 'master'],
    });
  });

  it('the master e-mail with the guardian profile is a guardian', async () => {
    const auth = createMockAuth(null);
    await auth.signIn({ email: MOCK_MASTER_EMAIL, password: 'x', role: 'guardian' });
    await expect(auth.getCurrentUser()).resolves.toEqual({
      id: MOCK_USER_IDS.guardian,
      email: MOCK_MASTER_EMAIL,
      role: 'guardian',
      isMaster: false,
    });
  });

  it('other examiners are not master and their token has only admin', async () => {
    const auth = createMockAuth(null);
    await auth.signIn({ email: 'prof@example.com', password: 'x' });
    await expect(auth.getCurrentUser()).resolves.toMatchObject({ isMaster: false });
    const token = await auth.getIdToken();
    expect(token && decodeMockToken(token)?.['cognito:groups']).toEqual(['admin']);
  });

  it('keeps being master after a reload, storing only e-mail and profile', async () => {
    const auth = createMockAuth(window.sessionStorage);
    await auth.signIn({ email: MOCK_MASTER_EMAIL, password: 'x', role: 'examiner' });
    expect(JSON.parse(window.sessionStorage.getItem(MOCK_SESSION_KEY) ?? '')).toEqual({
      email: MOCK_MASTER_EMAIL,
      role: 'examiner',
    });
    await expect(createMockAuth(window.sessionStorage).getCurrentUser()).resolves.toMatchObject({
      id: MOCK_MASTER_ID,
      isMaster: true,
    });
  });
});
