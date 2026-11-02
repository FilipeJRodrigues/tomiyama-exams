/**
 * Edge cases of the students list (§ 6.2) found by the frontend QA: odd API payloads,
 * network errors, the belts request failing, the drawer menu on the list and no data of
 * the previous user after signing out (LGPD).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StudentView } from '../../../src/api/types';
import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const STUDENTS_URL = `${TEST_API_URL}/students`;

/** A student whose belt no longer exists: the API sends no belt name and one reason. */
function orphanView(overrides: Partial<StudentView> = {}): StudentView {
  return {
    id: 'aluno-orfao',
    owner_id: 'mock-guardian',
    full_name: 'João Ávila',
    birth_date: '2025-03-01',
    current_belt_id: 'faixa-apagada',
    current_belt_since: '2026-03-01',
    stripes: 0,
    federation_id: null,
    active: true,
    created_at: '2026-03-01T12:00:00+00:00',
    updated_at: null,
    current_belt_name: null,
    age: 1,
    eligibility: {
      eligible: false,
      kind: null,
      target_belt_id: null,
      target_belt_name: null,
      reasons: ['Faixa atual não encontrada'],
    },
    ...overrides,
  };
}

function cellTexts(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll('tbody th, tbody td')).map((cell) =>
    cell.textContent.trim(),
  );
}

describe('students list edge cases (§ 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn003 shows a dash for a missing belt name and the API reason, with "1 ano"', async () => {
    server.use(http.get(STUDENTS_URL, () => HttpResponse.json([orphanView()])));
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(cellTexts(table)).toEqual([
      'João Ávila',
      '—',
      '1 ano',
      '01/03/2026',
      '—',
      'Bloqueado: Faixa atual não encontrada',
    ]);
  });

  it('shows "Inativo" over the blocking reasons, and "Bloqueado" with no reason', async () => {
    server.use(
      http.get(STUDENTS_URL, () =>
        HttpResponse.json([
          orphanView({ active: false }),
          orphanView({
            id: 'aluno-2',
            full_name: 'Bia Lopes',
            current_belt_name: 'Cinza',
            eligibility: {
              eligible: false,
              kind: 'BELT',
              target_belt_id: 'x',
              target_belt_name: 'Cinza/Azul',
              reasons: [],
            },
          }),
        ]),
      ),
    );
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(within(first!).getAllByRole('cell').at(-1)).toHaveTextContent(/^Inativo$/);
    expect(within(second!).getAllByRole('cell').at(-2)).toHaveTextContent('Faixa Cinza/Azul');
    expect(within(second!).getAllByRole('cell').at(-1)).toHaveTextContent(/^Bloqueado$/);
  });

  it('shows the pt-BR network message with "Tentar de novo"', async () => {
    server.use(http.get(STUDENTS_URL, () => HttpResponse.error()));
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível falar com o servidor');
    expect(within(alert).getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
  });

  it('shows the backend message on 403', async () => {
    server.use(
      http.get(STUDENTS_URL, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    await renderApp({ route: '/alunos', signedInAs: 'guardian' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
  });

  it('still lists the students when GET /belts fails (the swatch is decorative)', async () => {
    server.use(
      http.get(`${TEST_API_URL}/belts`, () =>
        HttpResponse.json({ message: 'Erro no servidor. Tente de novo.' }, { status: 500 }),
      ),
    );
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: 'Alunos' });
    expect(within(table).getAllByRole('rowheader')).toHaveLength(8);
    expect(within(table).queryAllByTestId('belt-swatch')).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 401 on the list ends the session', async () => {
    server.use(
      http.get(STUDENTS_URL, () => HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })),
    );
    await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the drawer menu working on the list at 390 px', async () => {
    setViewportWidth(390);
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByRole('list', { name: 'Alunos' });
    const burger = screen.getByRole('button', { name: /menu/i });
    await user.click(burger);
    expect(burger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('link', { name: 'Faixas' }));
    expect(burger).toHaveAttribute('aria-expanded', 'false');
  });

  it('never shows the examiner list to the guardian who signs in next (LGPD)', async () => {
    const { user } = await renderApp({ route: '/alunos', signedInAs: 'examiner' });
    await screen.findByRole('table', { name: 'Alunos' });
    await user.click(screen.getByRole('button', { name: 'Sair' }));

    await user.type(await screen.findByLabelText(/E-mail/), 'guardian@example.com');
    await user.type(screen.getByLabelText(/^Senha/), 'senha-teste');
    await user.click(screen.getByRole('radio', { name: 'Responsável' }));

    let sawExaminerStudent = false;
    const observer = new MutationObserver(() => {
      if (document.body.textContent.includes('Fábio Lima')) sawExaminerStudent = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    const table = await screen.findByRole('table', { name: 'Alunos' });
    await waitFor(() => {
      expect(
        within(table)
          .getAllByRole('rowheader')
          .map((cell) => cell.textContent),
      ).toEqual(['Ana Souza', 'Bruno Souza', 'Gabriel Costa']);
    });
    observer.disconnect();
    expect(sawExaminerStudent).toBe(false);
  });
});
