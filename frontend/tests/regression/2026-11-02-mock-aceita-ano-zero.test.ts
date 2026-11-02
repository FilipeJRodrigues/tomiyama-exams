/**
 * Erro: o mock de `POST /students` e `PUT /students/{id}` aceita `birth_date` e
 * `current_belt_since` com o ano 0000 (`"0000-01-01"`) e grava o aluno (201). A API real
 * recusa com 400: `date.fromisoformat` do Python só aceita anos de 1 a 9999
 * (`parse_date` em `backend/src/domain/validation.py`), e a mensagem é
 * "Nascimento: data inválida (use AAAA-MM-DD)". O modo simulado precisa responder como o
 * backend.
 * Esperado: 400 com a mensagem do backend, e nada gravado.
 * Issue: -
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApiUrl } from '../../src/api/client';
import { encodeMockToken } from '../../src/auth/mockToken';
import { createMockDb, mockBelts, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';

/** Guardian's student without exams. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';

let db: MockDb;

function body(overrides: Record<string, unknown>) {
  return {
    full_name: 'Ana Souza',
    birth_date: '2018-05-10',
    current_belt_id: mockBelts[0]?.id ?? '',
    current_belt_since: '2024-03-01',
    stripes: 0,
    federation_id: null,
    active: true,
    ...overrides,
  };
}

async function send(method: 'POST' | 'PUT', path: string, payload: unknown) {
  const examiner = encodeMockToken({
    sub: 'examiner-sub',
    email: 'examiner@example.com',
    'cognito:groups': ['admin'],
  });
  const response = await fetch(buildApiUrl(TEST_API_URL, path), {
    method,
    headers: { Authorization: `Bearer ${examiner}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, json: (await response.json()) as { message?: string } };
}

describe('mock de alunos e o ano 0000 (contrato com a API)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('POST recusa nascimento no ano 0000 como o backend', async () => {
    const before = db.students.length;
    const result = await send('POST', '/students', body({ birth_date: '0000-01-01' }));
    expect(result.status).toBe(400);
    expect(result.json.message).toBe('Nascimento: data inválida (use AAAA-MM-DD)');
    expect(db.students).toHaveLength(before);
  });

  it('PUT recusa "na faixa desde" no ano 0000 como o backend', async () => {
    const result = await send(
      'PUT',
      `/students/${ANA}`,
      body({ birth_date: '0000-01-01', current_belt_since: '0000-06-01' }),
    );
    expect(result.status).toBe(400);
    expect(result.json.message).toBe('Nascimento: data inválida (use AAAA-MM-DD)');
  });
});
