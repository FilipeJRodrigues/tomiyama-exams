/**
 * Erro: logo depois de "Confirmar presença", a recarga de `GET /events/{id}/exams` pode
 * chegar defasada (o DynamoDB lê com consistência eventual) e vir sem o exame recém-criado.
 * A linha de Ana Souza voltava para "Confirmar presença" ao lado do aviso "Presença de Ana
 * Souza confirmada.".
 * Esperado: o exame devolvido pelo 201 do `POST /events/{id}/exams` continua na tela
 * ("Abrir exame", "Presente · Em andamento", filtro Presentes) mesmo que a recarga não o
 * traga (§ 6.3, RN005).
 * Issue: (nenhuma; endurecimento pedido no QA da tela Dia do exame, 2026-11-02)
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb, MOCK_EVENT_IDS } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${MOCK_EVENT_IDS.open}/exams`;

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

describe('exam day: stale reload after a confirmation (§ 6.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn005 keeps the exam of the 201 when the reload comes back without it', async () => {
    let posted = false;
    let staleReloads = 0;
    server.use(
      http.post(OPEN_EXAMS_URL, () => {
        posted = true;
        return undefined;
      }),
      http.get(OPEN_EXAMS_URL, () => {
        if (!posted) return undefined;
        staleReloads += 1;
        return HttpResponse.json([]);
      }),
    );
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });

    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', {
        name: 'Confirmar presença de Ana Souza',
      }),
    );
    await waitFor(() => {
      expect(staleReloads).toBeGreaterThan(0);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const row = rowOf(screen.getByRole('table', { name: LIST }), 'Ana Souza');
    expect(within(row).getByRole('link', { name: 'Abrir exame de Ana Souza' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Confirmar presença/ })).toBeNull();
    expect(row).toHaveTextContent('Presente · Em andamento');
    expect(screen.getByRole('status')).toHaveTextContent('Presença de Ana Souza confirmada.');
    expect(
      within(screen.getByRole('radiogroup', { name: 'Filtrar alunos' })).getByRole('radio', {
        name: /^Presentes \(1\)$/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
