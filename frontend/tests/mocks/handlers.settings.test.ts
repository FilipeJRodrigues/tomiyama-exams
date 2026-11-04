/**
 * The simulated `PUT /settings` follows `backend/README.md` (§ "Configurações da academia"):
 * the three fields replaced, the length and type messages, only the admin master (groups
 * `master` and `admin`) changes the sensei, who must be an active examiner, and the other
 * examiners resend the stored one (even an inactive one).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, createApiClient, type ApiClient } from '../../src/api/client';
import { updateSettings } from '../../src/api/queries';
import type { AcademySettingsInput } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_MASTER_EMAIL, MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

type Profile = 'examiner' | 'guardian' | 'master';

let db: MockDb;

async function apiAs(profile: Profile): Promise<ApiClient> {
  const auth = createMockAuth(null);
  await auth.signIn({
    email: profile === 'master' ? MOCK_MASTER_EMAIL : 'pessoa@example.com',
    password: 'senha-teste',
    role: profile === 'guardian' ? 'guardian' : 'examiner',
  });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

async function failure(call: Promise<unknown>): Promise<[number, string]> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) return [error.status, error.message];
  }
  throw new Error('a chamada deveria falhar');
}

function body(fields: Partial<Record<keyof AcademySettingsInput, unknown>> = {}) {
  return {
    academy_name: 'Academia',
    sensei_user_id: 'mock-examiner-2',
    certificate_city: 'Araraquara',
    ...fields,
  } as AcademySettingsInput;
}

describe('simulated PUT /settings', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('the master replaces the three fields, trimmed; blank becomes null', async () => {
    const saved = await updateSettings(
      await apiAs('master'),
      body({
        academy_name: '  Associação  ',
        sensei_user_id: MOCK_USER_IDS.examiner,
        certificate_city: '   ',
      }),
    );
    expect(saved).toMatchObject({
      academy_name: 'Associação',
      sensei_user_id: MOCK_USER_IDS.examiner,
      certificate_city: null,
      sensei: {
        id: MOCK_USER_IDS.examiner,
        email: 'examinador@example.com',
        name: 'Sensei Simulado',
        active: true,
      },
    });
    expect(db.settings.created_at).toBe('2026-10-01T12:00:00+00:00');
    expect(db.settings.updated_at).not.toBe('2026-10-01T12:00:00+00:00');
  });

  it('the master removes the sensei with null or a blank id', async () => {
    const api = await apiAs('master');
    expect((await updateSettings(api, body({ sensei_user_id: null }))).sensei).toBeNull();
    db.settings.sensei_user_id = 'mock-examiner-2';
    expect((await updateSettings(api, body({ sensei_user_id: ' ' }))).sensei_user_id).toBeNull();
  });

  it('refuses the master an inactive sensei, even the stored one', async () => {
    const api = await apiAs('master');
    expect(await failure(updateSettings(api, body({ sensei_user_id: 'conta-removida' })))).toEqual([
      400,
      'O sensei precisa ser um examinador ativo',
    ]);
    db.settings.sensei_user_id = 'conta-removida';
    expect(await failure(updateSettings(api, body({ sensei_user_id: 'conta-removida' })))).toEqual([
      400,
      'O sensei precisa ser um examinador ativo',
    ]);
    expect(db.settings.academy_name).toBe('Academia Simulada de Judô');
  });

  it('another examiner saves resending the stored sensei, even inactive', async () => {
    const api = await apiAs('examiner');
    await expect(updateSettings(api, body())).resolves.toMatchObject({
      sensei_user_id: 'mock-examiner-2',
    });
    db.settings.sensei_user_id = 'conta-removida';
    await expect(
      updateSettings(api, body({ sensei_user_id: 'conta-removida', academy_name: 'Nova' })),
    ).resolves.toMatchObject({
      academy_name: 'Nova',
      sensei: { id: 'conta-removida', active: false },
    });
  });

  it('refuses another examiner any other sensei (choose, change or remove): 403', async () => {
    const api = await apiAs('examiner');
    for (const sensei of [MOCK_USER_IDS.examiner, null, 'inexistente']) {
      expect(await failure(updateSettings(api, body({ sensei_user_id: sensei })))).toEqual([
        403,
        'Somente o administrador master escolhe o sensei',
      ]);
    }
    db.settings.sensei_user_id = null;
    expect(await failure(updateSettings(api, body()))).toEqual([
      403,
      'Somente o administrador master escolhe o sensei',
    ]);
    expect(db.settings.academy_name).toBe('Academia Simulada de Judô');
  });

  it('checks the fields with the API messages', async () => {
    const api = await apiAs('master');
    const cases: [Partial<Record<keyof AcademySettingsInput, unknown>>, string][] = [
      [{ academy_name: '  ' }, 'Campo obrigatório: Nome da academia'],
      [{ academy_name: 'x'.repeat(256) }, 'Nome da academia: máximo de 255 caracteres'],
      [{ certificate_city: 'x'.repeat(81) }, 'Cidade do certificado: máximo de 80 caracteres'],
      [{ sensei_user_id: 'x'.repeat(129) }, 'Sensei: máximo de 128 caracteres'],
      [{ academy_name: 12 }, 'Nome da academia: valor inválido'],
    ];
    for (const [fields, message] of cases) {
      expect(await failure(updateSettings(api, body(fields)))).toEqual([400, message]);
    }
    // Code points, like Python: 255 emoji (510 UTF-16 units) pass.
    await expect(
      updateSettings(api, body({ academy_name: '🥋'.repeat(255) })),
    ).resolves.toBeTruthy();
  });

  it('is for examiners only', async () => {
    expect(await failure(updateSettings(await apiAs('guardian'), body()))).toEqual([
      403,
      'Esta área é dos examinadores',
    ]);
  });
});
