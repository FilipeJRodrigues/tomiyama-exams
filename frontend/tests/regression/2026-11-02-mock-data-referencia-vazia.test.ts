/**
 * Erro: no modo simulado, `GET /students?reference_date=` (parâmetro vazio) responde 400
 * "Data de referência: data inválida (use AAAA-MM-DD)". O backend trata o parâmetro vazio
 * como ausente e usa a data de hoje (`_reference_date` em
 * `backend/src/handlers/students.py`: `parse_date(raw, ...) if raw else dates.today()`).
 * Esperado: o mock segue o contrato do backend e devolve 200 com a idade calculada hoje
 * (critério 3 do PR da base: mocks seguem `backend/README.md`).
 * Issue: -
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { StudentView } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import { installMockApi, TEST_API_URL } from '../msw-server';

async function examinerToken(): Promise<string> {
  const auth = createMockAuth(null);
  await auth.signIn({ email: 'prof@example.com', password: 'senha-teste', role: 'examiner' });
  const token = await auth.getIdToken();
  if (!token) throw new Error('sem token simulado');
  return token;
}

describe('API simulada: reference_date vazio', () => {
  beforeEach(() => {
    installMockApi();
  });

  it('usa a data de hoje, como o backend', async () => {
    // The API client drops empty values, so call fetch directly, like any other client would.
    const response = await fetch(`${TEST_API_URL}/students?reference_date=`, {
      headers: { Authorization: `Bearer ${await examinerToken()}` },
    });
    expect(response.status).toBe(200);
    const students = (await response.json()) as StudentView[];
    expect(students).toHaveLength(5);
  });
});
