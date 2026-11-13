/**
 * Erro: o Dia do exame aberto por um link com `?evento=` de um evento que não existe (apagado
 * antes de o link ser aberto, ou id errado) cai em silêncio para o padrão: com um evento
 * aberto, `selectEvent` escolhe o aberto mais recente, mostra a lista dele e troca o `?evento`
 * por ele; sem evento aberto, mostra só "Nenhum evento aberto." e o id inexistente fica na URL.
 * Esperado (decisão do usuário, opção A: a tela nunca troca de evento sozinha):
 * 1. um aviso `role="alert"` com exatamente "O evento escolhido não foi encontrado. Ele pode ter
 *    sido apagado. Escolha um evento na lista.";
 * 2. o seletor fica em "Nenhum evento escolhido" e nenhuma lista de alunos aparece até o
 *    examinador escolher um evento;
 * 3. o `?evento` sai da URL (replace); recarregar sem ele volta ao padrão (o evento aberto mais
 *    recente);
 * 5. escolher um evento no seletor tira o aviso e mostra a lista dele;
 * 6. sem evento aberto, o aviso aparece no lugar do "Nenhum evento aberto." mudo.
 * Os casos "guarda" passam hoje e não podem quebrar com a correção: sem `?evento` vale o padrão
 * e ele vai para a URL; um `?evento` válido (até de evento encerrado) fica; enquanto os eventos
 * carregam, ou se a carga falha, nada é dado como "não encontrado"; o seletor troca de evento.
 * Issue: #28
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryKeys } from '../../src/api/queries';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { gate } from '../features/events/helpers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp, type RenderAppResult } from '../render';

const OPEN = MOCK_EVENT_IDS.open;
const OPEN_LABEL = 'Exame novembro/2026 · 21/11/2026 · Aberto';
const CLOSED = MOCK_EVENT_IDS.closed;
const CLOSED_LABEL = 'Exame março/2026 · 01/03/2026 · Encerrado';
/** An event id that is not in `GET /events`: deleted before the link was opened. */
const MISSING = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c99';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const NOT_FOUND =
  'O evento escolhido não foi encontrado. Ele pode ter sido apagado. Escolha um evento na lista.';
const NO_CHOICE = 'Nenhum evento escolhido';
const NO_OPEN_EVENT = 'Nenhum evento aberto.';
const EVENTS_URL = `${TEST_API_URL}/events`;
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${OPEN}/exams`;

let db: MockDb;

function picker(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Evento' });
}

/** Text of the option the event picker shows. */
function pickerText(): string {
  return picker().selectedOptions[0]?.textContent ?? '';
}

/** Text of each `role="alert"` on the screen, spaces normalized. */
function alertTexts(): string[] {
  return screen
    .queryAllByRole('alert')
    .map((alert) => alert.textContent.replace(/\s+/g, ' ').trim());
}

/** Lists of students on the screen: the table (notebook) or the cards (phone). */
function studentLists(): HTMLElement[] {
  return [
    ...screen.queryAllByRole('table', { name: LIST }),
    ...screen.queryAllByRole('list', { name: LIST }),
  ];
}

/** Counts the GETs to `url`; the simulated API still answers them. */
function countGets(url: string) {
  const calls = { count: 0 };
  server.use(
    http.get(url, () => {
      calls.count += 1;
      return undefined;
    }),
  );
  return calls;
}

/** No event is left open: the open one of the simulated data gets closed. */
function closeOpenEvent() {
  db.events = db.events.map((event) =>
    event.id === OPEN ? { ...event, status: 'CLOSED' as const } : event,
  );
}

/** Lets every read on its way end and React draw what came back. */
async function settle(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Opens the exam day on `?evento=MISSING` and waits until the screen dealt with the loaded
 * events, whatever the code does: the notice, the mute "Nenhum evento aberto." or a list.
 */
async function openOnMissing(): Promise<RenderAppResult> {
  const rendered = await renderApp({ route: `${ROUTE}?evento=${MISSING}`, signedInAs: 'examiner' });
  await waitFor(() => {
    expect(rendered.queryClient.getQueryState(queryKeys.events)?.status).toBe('success');
    const reacted =
      alertTexts().includes(NOT_FOUND) ||
      screen.queryByText(NO_OPEN_EVENT) !== null ||
      studentLists().length > 0;
    expect(reacted, 'a tela ainda não reagiu aos eventos carregados').toBe(true);
  });
  await settle(rendered.queryClient);
  return rendered;
}

describe('Dia do exame: link com ?evento= de um evento que não existe (§ 6.3, #28)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('D. com um evento aberto disponível', () => {
    it('1. mostra o aviso de evento não encontrado, e só ele', async () => {
      await openOnMissing();

      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });
    });

    it('2. o seletor fica em "Nenhum evento escolhido" e não aparece a lista do evento aberto', async () => {
      const openExams = countGets(OPEN_EXAMS_URL);
      await openOnMissing();

      await waitFor(() => {
        expect(pickerText()).toBe(NO_CHOICE);
      });
      expect(picker()).toHaveValue('');
      expect(studentLists()).toEqual([]);
      expect(screen.queryByText('Carregando alunos…')).not.toBeInTheDocument();
      expect(openExams.count, 'a lista do evento aberto foi carregada (GET dos exames dele)').toBe(
        0,
      );
    });

    it('3. o ?evento sai da URL, com replace; recarregar sem ele volta ao evento aberto mais recente', async () => {
      const first = await openOnMissing();
      const { router, queryClient } = first;

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      expect(router.state.location.pathname).toBe(ROUTE);
      expect(router.state.historyAction).toBe('REPLACE');
      await settle(queryClient);
      expect(router.state.location.search).toBe('');
      expect(pickerText()).toBe(NO_CHOICE);

      // Reload: the same address, now without `?evento`.
      const address = `${router.state.location.pathname}${router.state.location.search}`;
      first.unmount();
      const reloaded = await renderApp({ route: address, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      expect(pickerText()).toBe(OPEN_LABEL);
      await waitFor(() => {
        expect(reloaded.router.state.location.search).toBe(`?evento=${OPEN}`);
      });
      expect(alertTexts()).toEqual([]);
    });
  });

  describe('D. sem nenhum evento aberto', () => {
    beforeEach(() => {
      closeOpenEvent();
    });

    it('1. mostra o aviso de evento não encontrado, e só ele', async () => {
      await openOnMissing();

      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });
    });

    it('3. o ?evento inexistente sai da URL, com replace', async () => {
      const { router } = await openOnMissing();

      await waitFor(() => {
        expect(router.state.location.search).toBe('');
      });
      expect(router.state.historyAction).toBe('REPLACE');
    });

    it('6. o aviso fica no lugar do "Nenhum evento aberto." mudo', async () => {
      await openOnMissing();

      expect(screen.queryByText(NO_OPEN_EVENT)).not.toBeInTheDocument();
      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });
      expect(pickerText()).toBe(NO_CHOICE);
      expect(studentLists()).toEqual([]);
    });
  });

  describe('E. depois de D, escolher um evento no seletor', () => {
    it('5. o aviso some e a lista do evento escolhido (encerrado) aparece', async () => {
      const { user, router } = await openOnMissing();
      await waitFor(() => {
        expect(alertTexts()).toEqual([NOT_FOUND]);
      });

      await user.selectOptions(picker(), CLOSED);
      await screen.findByRole('table', { name: LIST });
      expect(alertTexts()).toEqual([]);
      expect(pickerText()).toBe(CLOSED_LABEL);
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
      expect(screen.getByRole('note')).toHaveTextContent('Evento encerrado');
    });
  });

  describe('guardas (passam hoje)', () => {
    it('sem ?evento: o evento aberto mais recente, gravado na URL com replace, sem aviso', async () => {
      const { router, queryClient } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      expect(pickerText()).toBe(OPEN_LABEL);
      await waitFor(() => {
        expect(router.state.location.search).toBe(`?evento=${OPEN}`);
      });
      expect(router.state.historyAction).toBe('REPLACE');
      await settle(queryClient);
      expect(alertTexts()).toEqual([]);
    });

    it('?evento de um evento encerrado: fica na URL e no seletor, sem aviso', async () => {
      const { router, queryClient } = await renderApp({
        route: `${ROUTE}?evento=${CLOSED}`,
        signedInAs: 'examiner',
      });
      await screen.findByRole('table', { name: LIST });
      await settle(queryClient);
      expect(pickerText()).toBe(CLOSED_LABEL);
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
      expect(screen.getByRole('note')).toHaveTextContent('Evento encerrado');
      expect(alertTexts()).toEqual([]);
    });

    it('?evento válido enquanto os eventos carregam: nada de aviso e o parâmetro fica', async () => {
      const held = gate();
      server.use(
        http.get(
          EVENTS_URL,
          async () => {
            await held.wait;
            return undefined;
          },
          { once: true },
        ),
      );
      const { router } = await renderApp({
        route: `${ROUTE}?evento=${OPEN}`,
        signedInAs: 'examiner',
      });
      expect(await screen.findByText('Carregando eventos…')).toBeInTheDocument();
      expect(alertTexts()).toEqual([]);
      expect(router.state.location.search).toBe(`?evento=${OPEN}`);

      held.release();
      await screen.findByRole('table', { name: LIST });
      expect(pickerText()).toBe(OPEN_LABEL);
      expect(router.state.location.search).toBe(`?evento=${OPEN}`);
      expect(alertTexts()).toEqual([]);
    });

    it('?evento válido e a carga dos eventos falha: só o erro da carga, o parâmetro fica e "Tentar de novo" abre o evento', async () => {
      server.use(
        http.get(
          EVENTS_URL,
          () => HttpResponse.json({ message: 'Erro interno. Tente de novo.' }, { status: 500 }),
          { once: true },
        ),
      );
      const { user, router, queryClient } = await renderApp({
        route: `${ROUTE}?evento=${CLOSED}`,
        signedInAs: 'examiner',
      });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Não foi possível carregar os eventos');
      await settle(queryClient);
      expect(alertTexts()).not.toContain(NOT_FOUND);
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);

      await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      await screen.findByRole('table', { name: LIST });
      expect(pickerText()).toBe(CLOSED_LABEL);
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
      expect(alertTexts()).toEqual([]);
    });

    it('trocar de evento no seletor: a lista e a URL acompanham, sem aviso', async () => {
      const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
      await screen.findByRole('table', { name: LIST });
      await waitFor(() => {
        expect(router.state.location.search).toBe(`?evento=${OPEN}`);
      });

      await user.selectOptions(picker(), CLOSED);
      expect(await screen.findByRole('note')).toHaveTextContent('Evento encerrado');
      await screen.findByRole('table', { name: LIST });
      expect(pickerText()).toBe(CLOSED_LABEL);
      expect(router.state.location.search).toBe(`?evento=${CLOSED}`);
      expect(alertTexts()).toEqual([]);

      await user.selectOptions(picker(), OPEN);
      await waitFor(() => {
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
      });
      await screen.findByRole('table', { name: LIST });
      expect(pickerText()).toBe(OPEN_LABEL);
      expect(router.state.location.search).toBe(`?evento=${OPEN}`);
      expect(alertTexts()).toEqual([]);
    });

    it('releitura em segundo plano que ainda traz o evento escolhido: nada muda, sem aviso', async () => {
      const events = countGets(EVENTS_URL);
      const { router, queryClient } = await renderApp({
        route: `${ROUTE}?evento=${OPEN}`,
        signedInAs: 'examiner',
      });
      await screen.findByRole('table', { name: LIST });
      await settle(queryClient);
      const before = events.count;

      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(events.count).toBe(before + 1);
      });
      await settle(queryClient);
      expect(pickerText()).toBe(OPEN_LABEL);
      expect(router.state.location.search).toBe(`?evento=${OPEN}`);
      expect(screen.getByRole('table', { name: LIST })).toBeInTheDocument();
      expect(alertTexts()).toEqual([]);
    });
  });
});
