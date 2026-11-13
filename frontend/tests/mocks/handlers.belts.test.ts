/** Simulated `PUT /belts/{id}` follows `update_belt` and `apply_belt_update` (RN015). */
import { beforeEach, describe, expect, it } from 'vitest';

import { createApiClient } from '../../src/api/client';
import { listBelts, updateBelt } from '../../src/api/queries';
import type { Belt, BeltInput } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_MASTER_EMAIL } from '../../src/auth/mockConstants';
import type { Role } from '../../src/auth/types';
import { createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const CINZA = mockBelts.find((belt) => belt.name === 'Cinza')!;

let db: MockDb;

/** `master` is the simulated admin master; `examiner` any other examiner (#143). */
async function apiAs(role: Role | 'master' | null) {
  const auth = createMockAuth(null);
  if (role === 'master') {
    await auth.signIn({ email: MOCK_MASTER_EMAIL, password: 'senha-teste', role: 'examiner' });
  } else if (role) {
    await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  }
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

function inputOf(belt: Belt): BeltInput {
  return {
    name: belt.name,
    kyu: belt.kyu,
    sort_order: belt.sort_order,
    level: belt.level,
    min_age_years: belt.min_age_years,
    min_months_previous: belt.min_months_previous,
    color_primary: belt.color_primary,
    color_secondary: belt.color_secondary,
  };
}

type RawBody = Record<string, unknown>;

/**
 * Sends a raw body (fields of any type), like a client the form does not control, as the
 * admin master: the only one who changes every field (#143).
 */
async function putRaw(body: RawBody, id = CINZA.id) {
  const api = await apiAs('master');
  return updateBelt(api, id, body as unknown as BeltInput);
}

const BASE: RawBody = { ...inputOf(CINZA) };

describe('simulated PUT /belts/{id}', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('saves every field, colors in upper case, and the list follows', async () => {
    // A new name: only the admin master changes it (#143).
    const api = await apiAs('master');
    const saved = await updateBelt(api, CINZA.id, {
      ...inputOf(CINZA),
      name: ' Cinza clara ',
      min_age_years: 6,
      color_secondary: '#1e63c6',
    });
    expect(saved).toEqual({
      ...CINZA,
      name: 'Cinza clara',
      min_age_years: 6,
      color_secondary: '#1E63C6',
    });
    const belts = await listBelts(api);
    expect(belts.find((belt) => belt.id === CINZA.id)).toEqual(saved);
  });

  it('refuses guardians (403) and signed-out calls (401)', async () => {
    await expect(
      updateBelt(await apiAs('guardian'), CINZA.id, inputOf(CINZA)),
    ).rejects.toMatchObject({ status: 403, message: 'Esta área é dos examinadores' });
    await expect(updateBelt(await apiAs(null), CINZA.id, inputOf(CINZA))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('answers 404 for a belt that does not exist', async () => {
    await expect(putRaw(BASE, 'nao-existe')).rejects.toMatchObject({
      status: 404,
      message: 'Faixa não encontrada',
    });
  });

  it('rn015 answers the backend messages for invalid fields (400)', async () => {
    const cases: [RawBody, string][] = [
      [{ name: '' }, 'Campo obrigatório: Nome'],
      [{ name: 'x'.repeat(41) }, 'Nome: máximo de 40 caracteres'],
      [{ kyu: 12 }, 'Kyū: deve estar entre 1 e 11'],
      [{ kyu: 1.5 }, 'Kyū: deve ser um número inteiro'],
      [{ sort_order: -1 }, 'Ordem: deve estar entre 0 e 99'],
      [{ sort_order: 100 }, 'Ordem: deve estar entre 0 e 99'],
      [{ sort_order: 1e20 }, 'Ordem: deve estar entre 0 e 99'],
      [{ sort_order: null }, 'Campo obrigatório: Ordem'],
      [{ level: 'ADVANCED' }, 'Nível: valor inválido'],
      [{ min_age_years: -1 }, 'Idade mínima: deve estar entre 0 e 99'],
      [{ min_age_years: 100 }, 'Idade mínima: deve estar entre 0 e 99'],
      [{ min_months_previous: 241 }, 'Carência: deve estar entre 0 e 240'],
      [{ min_months_previous: 1e20 }, 'Carência: deve estar entre 0 e 240'],
      [{ min_months_previous: '3' }, 'Carência: deve ser um número inteiro'],
      [{ color_primary: '' }, 'Campo obrigatório: Cor'],
      [{ color_primary: '#9E9' }, 'Cor: use o formato #RRGGBB'],
      [{ color_secondary: 'azul' }, 'Cor das pontas: use o formato #RRGGBB'],
    ];
    for (const [change, message] of cases) {
      await expect(putRaw({ ...BASE, ...change })).rejects.toMatchObject({ status: 400, message });
    }
    expect(db.belts.find((belt) => belt.id === CINZA.id)).toEqual(CINZA);
  });

  it('rn015 accepts the ceilings of card #47 (order 99, age 99, months 240)', async () => {
    const saved = await putRaw({
      ...BASE,
      sort_order: 99,
      min_age_years: 99,
      min_months_previous: 240,
    });
    expect(saved).toMatchObject({ sort_order: 99, min_age_years: 99, min_months_previous: 240 });
  });

  it('rn015 keeps name (any case) and order unique (409)', async () => {
    await expect(putRaw({ ...BASE, name: 'AZUL' })).rejects.toMatchObject({
      status: 409,
      message: 'Já existe uma faixa com este nome',
    });
    await expect(putRaw({ ...BASE, sort_order: 0 })).rejects.toMatchObject({
      status: 409,
      message: 'Já existe uma faixa com esta ordem',
    });
    // The belt's own name and order are fine.
    await expect(putRaw(BASE)).resolves.toEqual(CINZA);
  });
});

describe('simulated PUT /belts/{id} by profile (#142, #143)', () => {
  const ONLY_MASTER =
    'Somente o administrador master altera nome, kyū, ordem, nível e cores da faixa';

  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn001 rn002 an examiner who is not the master changes the minimum age and months', async () => {
    const api = await apiAs('examiner');
    const saved = await updateBelt(api, CINZA.id, {
      ...inputOf(CINZA),
      min_age_years: 99,
      min_months_previous: 240,
    });
    expect(saved).toEqual({ ...CINZA, min_age_years: 99, min_months_previous: 240 });
    expect(db.belts.find((belt) => belt.id === CINZA.id)).toEqual(saved);
  });

  it('refuses with 403 another name, kyū, order, level or color from him, saving nothing', async () => {
    const api = await apiAs('examiner');
    const changes: Partial<BeltInput>[] = [
      { name: 'Cinza clara' },
      { kyu: 9 },
      { kyu: null },
      { sort_order: 50 },
      { level: 'INTERMEDIATE' },
      { color_primary: '#000000' },
      { color_secondary: '#1E63C6' },
    ];
    for (const change of changes) {
      await expect(
        updateBelt(api, CINZA.id, { ...inputOf(CINZA), min_age_years: 7, ...change }),
      ).rejects.toMatchObject({ status: 403, message: ONLY_MASTER });
    }
    expect(db.belts.find((belt) => belt.id === CINZA.id)).toEqual(CINZA);
  });

  it('still answers the 400 of an age or months out of range to him', async () => {
    const api = await apiAs('examiner');
    await expect(
      updateBelt(api, CINZA.id, { ...inputOf(CINZA), min_age_years: 100 }),
    ).rejects.toMatchObject({ status: 400, message: 'Idade mínima: deve estar entre 0 e 99' });
    await expect(
      updateBelt(api, CINZA.id, { ...inputOf(CINZA), min_months_previous: 241 }),
    ).rejects.toMatchObject({ status: 400, message: 'Carência: deve estar entre 0 e 240' });
  });

  it('the admin master changes every field', async () => {
    const api = await apiAs('master');
    const input: BeltInput = {
      name: 'Cinza clara',
      kyu: 10,
      sort_order: 50,
      level: 'INTERMEDIATE',
      min_age_years: 6,
      min_months_previous: 4,
      color_primary: '#AAAAAA',
      color_secondary: '#1E63C6',
    };
    await expect(updateBelt(api, CINZA.id, input)).resolves.toEqual({ id: CINZA.id, ...input });
  });
});
