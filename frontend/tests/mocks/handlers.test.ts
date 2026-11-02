import { beforeEach, describe, expect, it } from 'vitest';

import { createApiClient } from '../../src/api/client';
import { listBelts, listStudents } from '../../src/api/queries';
import { createMockAuth } from '../../src/auth/mockAuth';
import type { Role } from '../../src/auth/types';
import { installMockApi, TEST_API_URL } from '../msw-server';

async function apiAs(role: Role | null) {
  const auth = createMockAuth(null);
  if (role) await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

describe('simulated API', () => {
  beforeEach(() => {
    installMockApi();
  });

  it('lists the belts in graduation order', async () => {
    const belts = await listBelts(await apiAs('guardian'));
    expect(belts).toHaveLength(12);
    expect(belts.map((belt) => belt.name).slice(0, 3)).toEqual(['Branca', 'Branca/Cinza', 'Cinza']);
  });

  it('answers 401 without a token, like the JWT authorizer', async () => {
    await expect(listBelts(await apiAs(null))).rejects.toMatchObject({ status: 401 });
  });

  it('shows every student to examiners, in alphabetical order', async () => {
    const students = await listStudents(await apiAs('examiner'));
    expect(students.map((student) => student.full_name)).toEqual([
      'Ana Souza',
      'Bruno Souza',
      'Carla Mendes',
      'Davi Oliveira',
      'Élida Ramos',
    ]);
  });

  it('shows guardians only their own students', async () => {
    const students = await listStudents(await apiAs('guardian'));
    expect(students.map((student) => student.full_name)).toEqual(['Ana Souza', 'Bruno Souza']);
  });

  it('applies the active filter and the reference date of the age', async () => {
    const api = await apiAs('examiner');
    const inactive = await listStudents(api, { active: false });
    expect(inactive.map((student) => student.full_name)).toEqual(['Élida Ramos']);

    const [ana] = await listStudents(api, { reference_date: '2027-03-13' });
    expect(ana).toMatchObject({ full_name: 'Ana Souza', age: 8, current_belt_name: 'Cinza' });
  });

  it('refuses an invalid reference date with the backend message', async () => {
    await expect(
      listStudents(await apiAs('examiner'), { reference_date: '13/03/2027' }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Data de referência: data inválida (use AAAA-MM-DD)',
    });
  });
});
