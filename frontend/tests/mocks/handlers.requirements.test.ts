/**
 * Simulated `GET/POST/PUT/DELETE /requirements` follow `handlers/requirements.py` and
 * `build_requirement` (RN017): filters, sheet order, default order at the end of the belt,
 * the same messages in the same order, and the 409 of an item with answers.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, createApiClient } from '../../src/api/client';
import {
  createRequirement,
  deleteRequirement,
  listRequirements,
  updateRequirement,
} from '../../src/api/queries';
import type { Requirement, RequirementInput } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { Role } from '../../src/auth/types';
import { createMockDb, mockBelts, mockRequirementId, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const BRANCA_CINZA = mockBelts.find((belt) => belt.name === 'Branca/Cinza')!;
const CINZA = mockBelts.find((belt) => belt.name === 'Cinza')!;
const ROXA = mockBelts.find((belt) => belt.name === 'Roxa')!;
/** Roxa item 1 (practical) has an answer in Élida's exam; Marrom item 3 has none. */
const ANSWERED = mockRequirementId('Roxa', 1);
const FREE = mockRequirementId('Marrom', 3);

let db: MockDb;

async function apiAs(role: Role | null) {
  const auth = createMockAuth(null);
  if (role) await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('a requisição deveria falhar');
}

const NEW_ITEM: RequirementInput = {
  belt_id: CINZA.id,
  kind: 'THEORY',
  category: 'Vocabulário',
  description: 'Parar',
  expected_answer: 'Mate',
};

function inputOf(item: Requirement): RequirementInput {
  return {
    belt_id: item.belt_id,
    kind: item.kind,
    category: item.category,
    description: item.description,
    expected_answer: item.expected_answer,
    sort_order: item.sort_order,
  };
}

function stored(id: string): Requirement {
  const item = db.requirements.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`sem o item ${id}`);
  return item;
}

describe('simulated GET /requirements', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn017 filters by belt and kind, in sheet order', async () => {
    const api = await apiAs('examiner');
    const all = await listRequirements(api, { belt_id: BRANCA_CINZA.id });
    expect(all.map((item) => item.sort_order)).toEqual([1, 2, 3, 4, 5, 6]);
    const theory = await listRequirements(api, { belt_id: BRANCA_CINZA.id, kind: 'THEORY' });
    expect(theory.map((item) => item.description)).toEqual([
      'Professor',
      'Contar até 10 em japonês',
    ]);
  });

  it('rn017 without filter sends every item in belt order, then sheet order', async () => {
    db.requirements.push({ ...stored(FREE), id: 'z-last', belt_id: CINZA.id, sort_order: 1 });
    const api = await apiAs('examiner');
    const all = await listRequirements(api);
    const position = new Map(mockBelts.map((belt) => [belt.id, belt.sort_order]));
    const keys = all.map((item) => [position.get(item.belt_id) ?? 99, item.sort_order]);
    expect(keys).toEqual(
      [...keys].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0)),
    );
    expect(all).toHaveLength(db.requirements.length);
  });

  it('refuses a bad kind (400), an unknown belt (404), guardians (403) and no token (401)', async () => {
    const api = await apiAs('examiner');
    const badKind = await failure(api.get('/requirements', { belt_id: 'nenhuma', kind: 'ORAL' }));
    expect([badKind.status, badKind.message]).toEqual([400, 'Filtro tipo: use THEORY ou PRACTICE']);
    const unknown = await failure(listRequirements(api, { belt_id: 'nenhuma' }));
    expect([unknown.status, unknown.message]).toEqual([404, 'Faixa não encontrada']);
    const guardian = await failure(listRequirements(await apiAs('guardian')));
    expect(guardian.status).toBe(403);
    const anonymous = await failure(listRequirements(await apiAs(null)));
    expect(anonymous.status).toBe(401);
  });
});

describe('simulated POST /requirements', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn017 without an order goes to the end of the belt (1 on an empty belt)', async () => {
    const api = await apiAs('examiner');
    const first = await createRequirement(api, { ...NEW_ITEM, category: ' Vocabulário ' });
    expect(first).toMatchObject({ ...NEW_ITEM, sort_order: 1 });
    const second = await createRequirement(api, { ...NEW_ITEM, expected_answer: '  ' });
    expect(second).toMatchObject({ sort_order: 2, expected_answer: null });
    expect(db.requirements.filter((item) => item.belt_id === CINZA.id)).toHaveLength(2);
  });

  it('keeps an explicit order, also a repeated one', async () => {
    const api = await apiAs('examiner');
    const saved = await createRequirement(api, {
      ...NEW_ITEM,
      belt_id: BRANCA_CINZA.id,
      sort_order: 3,
    });
    expect(saved.sort_order).toBe(3);
  });

  it('rn015 a belt with an item at 9999 needs the order of the new one', async () => {
    db.requirements.push({ ...stored(FREE), id: 'full', belt_id: CINZA.id, sort_order: 9999 });
    const api = await apiAs('examiner');
    const refused = await failure(createRequirement(api, NEW_ITEM));
    expect([refused.status, refused.message]).toEqual([
      400,
      'Ordem: a faixa já tem um item na ordem 9999; informe a ordem do novo item',
    ]);
    expect(db.requirements.filter((item) => item.belt_id === CINZA.id)).toHaveLength(1);
    const saved = await createRequirement(api, { ...NEW_ITEM, sort_order: 10 });
    expect(saved.sort_order).toBe(10);
  });

  it('checks the fields in the order of build_requirement', async () => {
    const api = await apiAs('examiner');
    const cases: [Record<string, unknown>, string][] = [
      [{ ...NEW_ITEM, belt_id: '', kind: 'X' }, 'Campo obrigatório: Faixa'],
      [{ ...NEW_ITEM, belt_id: 'nenhuma', kind: 'X' }, 'Faixa: faixa não encontrada'],
      [{ ...NEW_ITEM, kind: undefined, category: '' }, 'Campo obrigatório: Tipo'],
      [{ ...NEW_ITEM, kind: 'ORAL', category: '' }, 'Tipo: valor inválido'],
      [{ ...NEW_ITEM, category: ' ', description: '' }, 'Campo obrigatório: Categoria'],
      [{ ...NEW_ITEM, category: 'x'.repeat(61) }, 'Categoria: máximo de 60 caracteres'],
      [{ ...NEW_ITEM, description: '' }, 'Campo obrigatório: Descrição'],
      [{ ...NEW_ITEM, description: 'x'.repeat(2001) }, 'Descrição: máximo de 2000 caracteres'],
      [
        { ...NEW_ITEM, expected_answer: 'x'.repeat(2001), sort_order: -1 },
        'Resposta esperada: máximo de 2000 caracteres',
      ],
      [{ ...NEW_ITEM, sort_order: 10000 }, 'Ordem: deve estar entre 0 e 9999'],
      [{ ...NEW_ITEM, sort_order: '3' }, 'Ordem: deve ser um número inteiro'],
      [{ ...NEW_ITEM, sort_order: 1.5 }, 'Ordem: deve ser um número inteiro'],
    ];
    for (const [body, message] of cases) {
      const error = await failure(createRequirement(api, body as unknown as RequirementInput));
      expect([error.status, error.message]).toEqual([400, message]);
    }
    // Code points, like Python: 60 emoji fit.
    const emoji = await createRequirement(api, { ...NEW_ITEM, category: '🥋'.repeat(60) });
    expect(Array.from(emoji.category)).toHaveLength(60);
  });

  it('refuses guardians (403)', async () => {
    const error = await failure(createRequirement(await apiAs('guardian'), NEW_ITEM));
    expect(error.status).toBe(403);
  });
});

describe('simulated PUT and DELETE /requirements/{id}', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('edits every field of an item without answers, also its belt and kind', async () => {
    const api = await apiAs('examiner');
    const saved = await updateRequirement(api, FREE, {
      ...inputOf(stored(FREE)),
      belt_id: CINZA.id,
      kind: 'THEORY',
      description: 'Deashi harai',
      sort_order: 7,
    });
    expect(saved).toMatchObject({ id: FREE, belt_id: CINZA.id, kind: 'THEORY', sort_order: 7 });
    expect(stored(FREE)).toEqual(saved);
  });

  it('without an order the item keeps its own', async () => {
    const api = await apiAs('examiner');
    const saved = await updateRequirement(api, FREE, {
      ...inputOf(stored(FREE)),
      sort_order: undefined,
    });
    expect(saved.sort_order).toBe(3);
  });

  it('rn017 an item with answers keeps its belt and kind (409); resending them is accepted', async () => {
    const api = await apiAs('examiner');
    const before = { ...stored(ANSWERED) };
    for (const change of [{ belt_id: CINZA.id }, { kind: 'THEORY' as const }]) {
      const error = await failure(
        updateRequirement(api, ANSWERED, { ...inputOf(before), ...change }),
      );
      expect([error.status, error.message]).toEqual([
        409,
        'Não é possível trocar a faixa ou o tipo de um requisito com respostas registradas',
      ]);
    }
    expect(stored(ANSWERED)).toEqual(before);
    const saved = await updateRequirement(api, ANSWERED, {
      ...inputOf(before),
      description: 'Saudação em pé',
      sort_order: 20,
    });
    expect(saved).toMatchObject({ belt_id: ROXA.id, kind: 'PRACTICE', sort_order: 20 });
  });

  it('a validation error comes before the 409, and the 404 before both', async () => {
    const api = await apiAs('examiner');
    const invalid = await failure(
      updateRequirement(api, ANSWERED, {
        ...inputOf(stored(ANSWERED)),
        kind: 'THEORY',
        category: '',
      }),
    );
    expect([invalid.status, invalid.message]).toEqual([400, 'Campo obrigatório: Categoria']);
    const missing = await failure(updateRequirement(api, 'nenhum', NEW_ITEM));
    expect([missing.status, missing.message]).toEqual([404, 'Requisito não encontrado']);
  });

  it('rn017 deletes an item without answers and refuses one with answers (409)', async () => {
    const api = await apiAs('examiner');
    await deleteRequirement(api, FREE);
    expect(db.requirements.some((item) => item.id === FREE)).toBe(false);
    const again = await failure(deleteRequirement(api, FREE));
    expect([again.status, again.message]).toEqual([404, 'Requisito não encontrado']);
    const refused = await failure(deleteRequirement(api, ANSWERED));
    expect([refused.status, refused.message]).toEqual([
      409,
      'Requisito possui respostas registradas',
    ]);
    expect(db.requirements.some((item) => item.id === ANSWERED)).toBe(true);
  });

  it('refuses guardians (403) on both', async () => {
    const api = await apiAs('guardian');
    expect((await failure(updateRequirement(api, FREE, NEW_ITEM))).status).toBe(403);
    expect((await failure(deleteRequirement(api, FREE))).status).toBe(403);
  });
});
