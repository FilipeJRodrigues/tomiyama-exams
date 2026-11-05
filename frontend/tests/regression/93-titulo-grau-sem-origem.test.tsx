/**
 * Erro: no "Histórico de exames" do Editar aluno, um exame de grau sem a faixa de origem
 * (`source` `null`, exame confirmado antes de ela ser guardada) ou com a faixa de origem
 * apagada (`source.belt_name` `null`) aparece como "Grau (rumo à Verde)", enquanto a tela do
 * mesmo exame (§ 6.4, `examTitle`) mostra "Grau na faixa Laranja (rumo à Verde)": sem a
 * origem, `examTitle` usa a faixa anterior à faixa-alvo pela `sort_order` (`stripeBelt`).
 * Esperado: o mesmo texto da tela do exame, com os mesmos fallbacks do `examTitle` (pedido
 * do card). As faixas já estão carregadas no Editar aluno (`useBelts`) e o item traz
 * `target_belt_id`.
 * Issue: #93
 */
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';

import type { ExamSheet, StudentHistoryEntry } from '../../src/api/types';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { examTitle } from '../../src/features/exam/examModel';
import { createMockDb, mockBelts } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

/** Examiner's inactive student with exams. */
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const VERDE = mockBelts.find((belt) => belt.name === 'Verde')!;

function stripeEntry(
  eventId: string,
  eventName: string,
  source: StudentHistoryEntry['source'],
): StudentHistoryEntry {
  return {
    event_id: eventId,
    event_name: eventName,
    exam_date: '2026-06-20',
    target_belt_id: VERDE.id,
    target_belt_name: VERDE.name,
    kind: 'STRIPE',
    status: 'APPROVED',
    decided_by_id: MOCK_USER_IDS.examiner,
    decided_at: '2026-06-20T15:00:00+00:00',
    notes: null,
    created_at: '2026-06-20T12:00:00+00:00',
    source,
  };
}

beforeEach(() => {
  server.use(
    ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
  );
  // A later `server.use` goes in front: this history answers before the simulated API.
  server.use(
    http.get(`${TEST_API_URL}/students/:id/exams`, () =>
      HttpResponse.json([
        stripeEntry('sem-origem', 'Exame junho/2026', null),
        stripeEntry('origem-apagada', 'Exame maio/2026', {
          belt_id: 'faixa-apagada',
          belt_name: null,
          belt_since: '2025-06-30',
          stripes: 1,
        }),
      ]),
    ),
  );
});

it('names a stripe exam without its source belt as the exam screen does', async () => {
  const sheet = {
    exam: { kind: 'STRIPE', source_belt_id: null },
    target_belt: VERDE,
  } as unknown as Pick<ExamSheet, 'exam' | 'target_belt'>;
  const examScreenText = examTitle(sheet, mockBelts);
  expect(examScreenText).toBe('Grau na faixa Laranja (rumo à Verde)');

  await renderApp({ route: `/alunos/${ELIDA}`, signedInAs: 'examiner' });
  const section = await screen.findByRole('region', { name: 'Histórico de exames' });
  const table = await within(section).findByRole('table', { name: 'Histórico de exames' });
  for (const eventName of ['Exame junho/2026', 'Exame maio/2026']) {
    const row = within(table).getByRole('rowheader', { name: eventName }).closest('tr')!;
    expect(within(row).getByText(examScreenText)).toBeInTheDocument();
  }
});
