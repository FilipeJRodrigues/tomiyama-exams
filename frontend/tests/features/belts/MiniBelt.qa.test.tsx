/**
 * Cobertura do qa-frontend no #166, etapa 4 (selo de faixa como mini faixa): casos que os testes
 * do agente não cobriam.
 *
 * - O responsável vê o selo da faixa dos próprios alunos em Alunos (§ 6.2, todos os perfis),
 *   com o nome escrito ao lado e fora da árvore de acessibilidade.
 * - rn004 exame de grau sem a faixa de origem (`source_belt_id` `null`, exame antigo): o selo é
 *   o da faixa anterior à faixa-alvo, a mesma que o título escreve ("Grau na faixa X").
 * - rn004 exame de grau com `GET /belts` falhando: o título fica "Grau (rumo à Y)" e nenhum selo
 *   aparece, nem um selo da faixa-alvo no lugar do da faixa do grau.
 * - Exame de faixa com `GET /belts` ainda carregando: o selo da faixa-alvo vem da própria ficha
 *   (`target_belt`, com as cores) e não troca quando as faixas chegam.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Belt } from '../../../src/api/types';
import { examPath } from '../../../src/app/navigation';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { BELT_TIP_PERCENT } from '../../../src/features/belts/beltGeometry';
import { createMockDb, MOCK_EVENT_IDS, mockBelts, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import { beltStops } from './miniBeltHelpers';

const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const ELIDA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e05';
const BELTS_URL = `${TEST_API_URL}/belts`;

function beltNamed(name: string): Belt {
  const found = mockBelts.find((belt) => belt.name === name);
  if (!found) throw new Error(`Faixa ${name} fora da base simulada.`);
  return found;
}

function expectedStops(belt: Belt): [string, number, number][] {
  const body = belt.color_primary.toLowerCase();
  const tips = belt.color_secondary?.toLowerCase();
  if (!tips) return [[body, 0, 100]];
  return [
    [tips, 0, BELT_TIP_PERCENT],
    [body, BELT_TIP_PERCENT, 100 - BELT_TIP_PERCENT],
    [tips, 100 - BELT_TIP_PERCENT, 100],
  ];
}

let db: MockDb;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
  db = createMockDb({ includeShowcase: true });
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('selo de faixa para o responsável (§ 6.2, #166)', () => {
  it.each([1280, 390])(
    'cada aluno dele com o selo da faixa atual, decorativo (%i px)',
    async (width) => {
      setViewportWidth(width);
      await renderApp({ route: '/alunos', signedInAs: 'guardian' });
      const own = db.students.filter((item) => item.student.owner_id === MOCK_USER_IDS.guardian);
      expect(own.length).toBeGreaterThan(0);
      await waitFor(() => {
        expect(screen.getAllByTestId('belt-swatch')).toHaveLength(own.length);
      });
      for (const selo of screen.getAllByTestId('belt-swatch')) {
        expect(selo).toHaveAttribute('aria-hidden', 'true');
        expect(selo).toHaveAttribute('data-size', 'list');
        const label = selo.nextElementSibling?.textContent.trim() ?? '';
        const belt = beltNamed(label.split(' · ')[0] ?? '');
        expect(beltStops(selo)).toEqual(expectedStops(belt));
      }
    },
  );
});

describe('selo no cabeçalho do exame: casos de borda (§ 6.4, #166)', () => {
  it('rn004 grau sem a faixa de origem: o selo da faixa anterior à faixa-alvo, a do título', async () => {
    // Élida's stripe exam in the closed event, as an older exam without its source belt.
    const exam = db.exams.find(
      (item) => item.student_id === ELIDA && item.event_id === MOCK_EVENT_IDS.closed,
    );
    expect(exam?.kind).toBe('STRIPE');
    exam!.source_belt_id = null;
    setViewportWidth(1280);
    await renderApp({ route: examPath(MOCK_EVENT_IDS.closed, ELIDA), signedInAs: 'examiner' });
    const line = await screen.findByTestId('exam-meta');
    const selo = await within(line).findByTestId('belt-swatch');
    expect(line).toHaveTextContent(/^15 anos · Grau na faixa Verde \(rumo à Roxa\)$/);
    expect(beltStops(selo)).toEqual(expectedStops(beltNamed('Verde')));
    expect(selo.nextElementSibling).toHaveTextContent(/^Grau na faixa Verde/);
  });

  it('rn004 grau com GET /belts falhando: "Grau (rumo à Roxa)" e nenhum selo', async () => {
    let calls = 0;
    server.use(
      http.get(BELTS_URL, () => {
        calls += 1;
        return HttpResponse.json({ message: 'Erro interno' }, { status: 500 });
      }),
    );
    setViewportWidth(1280);
    await renderApp({ route: examPath(MOCK_EVENT_IDS.closed, ELIDA), signedInAs: 'examiner' });
    const line = await screen.findByTestId('exam-meta');
    await waitFor(() => {
      expect(calls).toBeGreaterThan(0);
    });
    // Long enough for the failed request (and a retry, if any) to settle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(line).toHaveTextContent(/^15 anos · Grau \(rumo à Roxa\)$/);
    expect(within(line).queryByTestId('belt-swatch')).toBeNull();
  });

  it('exame de faixa com as faixas carregando: o selo da faixa-alvo já vem da ficha e não troca', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let served = false;
    server.use(
      http.get(BELTS_URL, async () => {
        await gate;
        served = true;
        return undefined;
      }),
    );
    setViewportWidth(1280);
    await renderApp({ route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' });
    const line = await screen.findByTestId('exam-meta');
    const selo = await within(line).findByTestId('belt-swatch');
    const marrom = beltNamed('Marrom');
    expect(served).toBe(false);
    expect(beltStops(selo)).toEqual(expectedStops(marrom));
    expect(line).toHaveTextContent(/^15 anos · Faixa Marrom$/);
    release();
    await waitFor(() => {
      expect(served).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = within(screen.getByTestId('exam-meta')).getAllByTestId('belt-swatch');
    expect(after).toHaveLength(1);
    expect(beltStops(after[0]!)).toEqual(expectedStops(marrom));
    expect(screen.getByTestId('exam-meta')).toHaveTextContent(/^15 anos · Faixa Marrom$/);
  });
});
