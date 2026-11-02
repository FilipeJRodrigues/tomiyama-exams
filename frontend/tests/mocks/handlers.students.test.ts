/**
 * The simulated `POST/GET/PUT/DELETE /students/{id}` follow the backend
 * (`handlers/students.py`, `domain/students.py`): same status codes and pt-BR messages.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import { createApiClient, type ApiClient } from '../../src/api/client';
import {
  createStudent,
  deleteStudent,
  getStudent,
  listStudents,
  updateStudent,
} from '../../src/api/queries';
import type { StudentInput } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { Role } from '../../src/auth/types';
import { createMockDb, mockBelts } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const CARLA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e03';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const GABRIEL = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e07';
const CINZA = mockBelts.find((belt) => belt.name === 'Cinza')!.id;

const NEW_STUDENT: StudentInput = {
  full_name: ' Lia Tanaka ',
  birth_date: '2013-04-20',
  current_belt_id: CINZA,
  current_belt_since: '2025-12-01',
  stripes: 0,
  federation_id: '  ',
  active: true,
};

async function apiAs(role: Role): Promise<ApiClient> {
  const auth = createMockAuth(null);
  await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

async function inputOf(api: ApiClient, id: string): Promise<StudentInput> {
  const student = await getStudent(api, id);
  return {
    full_name: student.full_name,
    birth_date: student.birth_date,
    current_belt_id: student.current_belt_id,
    current_belt_since: student.current_belt_since,
    stripes: student.stripes,
    federation_id: student.federation_id,
    active: student.active,
  };
}

describe('simulated student API', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a student owned by the caller, trimmed, with null federation id', async () => {
    const api = await apiAs('guardian');
    const created = await createStudent(api, { ...NEW_STUDENT, owner_id: 'outro' } as StudentInput);
    expect(created).toMatchObject({
      owner_id: 'mock-guardian',
      full_name: 'Lia Tanaka',
      federation_id: null,
      current_belt_name: 'Cinza',
      age: 13,
    });
    const names = (await listStudents(api)).map((student) => student.full_name);
    expect(names).toContain('Lia Tanaka');
  });

  it.each([
    [{ full_name: '  ' }, 'Campo obrigatório: Nome'],
    [{ full_name: 'a'.repeat(121) }, 'Nome: máximo de 120 caracteres'],
    [{ birth_date: '' }, 'Campo obrigatório: Nascimento'],
    [{ birth_date: '10/05/2018' }, 'Nascimento: data inválida (use AAAA-MM-DD)'],
    [{ current_belt_id: 'nao-existe' }, 'Faixa atual: faixa não encontrada'],
    [{ stripes: 5 }, 'Graus: deve estar entre 0 e 4'],
    [{ federation_id: 'x'.repeat(31) }, 'Registro na federação: máximo de 30 caracteres'],
    [{ active: 'sim' }, 'Ativo: valor inválido'],
  ])('refuses %j with the backend message', async (change, message) => {
    const api = await apiAs('guardian');
    await expect(
      createStudent(api, { ...NEW_STUDENT, ...change } as StudentInput),
    ).rejects.toMatchObject({ status: 400, message });
  });

  it.each([
    ['a future birth date', { birth_date: '2026-11-03', current_belt_since: '2026-11-03' }],
    ['a future belt date', { current_belt_since: '2026-11-03' }],
    ['a belt date before birth', { current_belt_since: '2013-04-19' }],
  ])('rn014 refuses %s', async (_, change) => {
    const api = await apiAs('examiner');
    await expect(createStudent(api, { ...NEW_STUDENT, ...change })).rejects.toMatchObject({
      status: 400,
      message: 'Datas inválidas: verifique nascimento e data da faixa atual',
    });
  });

  it("rn013 hides another owner's student as not found (GET, PUT, DELETE)", async () => {
    const api = await apiAs('guardian');
    const notFound = { status: 404, message: 'Aluno não encontrado' };
    await expect(getStudent(api, CARLA)).rejects.toMatchObject(notFound);
    await expect(updateStudent(api, CARLA, NEW_STUDENT)).rejects.toMatchObject(notFound);
    await expect(deleteStudent(api, CARLA)).rejects.toMatchObject(notFound);
  });

  it('rn013 refuses a guardian changing the graduation of a student with exams', async () => {
    const api = await apiAs('guardian');
    const current = await inputOf(api, GABRIEL);
    for (const change of [
      { stripes: 3 },
      { current_belt_since: '2026-04-01' },
      { current_belt_id: CINZA },
    ]) {
      await expect(updateStudent(api, GABRIEL, { ...current, ...change })).rejects.toMatchObject({
        status: 403,
        message: 'Somente examinadores alteram a graduação após o primeiro exame',
      });
    }
    // Resending the same graduation is accepted.
    const saved = await updateStudent(api, GABRIEL, { ...current, federation_id: 'FPJ-1' });
    expect(saved.federation_id).toBe('FPJ-1');
  });

  it('rn013 lets a guardian change the graduation before the first exam', async () => {
    const api = await apiAs('guardian');
    const saved = await updateStudent(api, ANA, { ...(await inputOf(api, ANA)), stripes: 1 });
    expect(saved.stripes).toBe(1);
  });

  it('rn013 lets an examiner change the graduation after exams', async () => {
    const api = await apiAs('examiner');
    const saved = await updateStudent(api, GABRIEL, {
      ...(await inputOf(api, GABRIEL)),
      stripes: 3,
    });
    expect(saved.stripes).toBe(3);
  });

  it('rn018 refuses deleting a student with exams with 409', async () => {
    const api = await apiAs('examiner');
    await expect(deleteStudent(api, ELIDA)).rejects.toMatchObject({
      status: 409,
      message: 'Aluno possui exames registrados',
    });
    expect((await getStudent(api, ELIDA)).full_name).toBe('Élida Ramos');
  });

  it('rn018 deletes a student without exams (204), then answers 404', async () => {
    const api = await apiAs('guardian');
    await expect(deleteStudent(api, ANA)).resolves.toBeUndefined();
    await expect(getStudent(api, ANA)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a body that is not a JSON object', async () => {
    const auth = createMockAuth(null);
    await auth.signIn({ email: 'p@example.com', password: 'senha-teste', role: 'guardian' });
    const response = await fetch(`${TEST_API_URL}/students`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${(await auth.getIdToken())!}` },
      body: '[1]',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: 'Corpo da requisição inválido: envie um objeto JSON',
    });
  });
});
