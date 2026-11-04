/**
 * Events screen (§ 6.5), the list: most recent first (`exam_date`, then the newest created),
 * date in pt-BR and status written out (never only by color, § 6.7), the screen states
 * (loading, empty, error with "Tentar de novo", no permission), examiners only (RN016) and
 * the way in from the exam day ("Criar evento", § 6.3).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import {
  EVENTS_URL,
  ROUTE,
  gate,
  makeEvent,
  openEvents,
  recordRequests,
  rowNames,
  tableRows,
} from './helpers';

let db: MockDb;

describe('events screen, list (§ 6.5)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('shows name, date in pt-BR and status in words, with a heading for the page', async () => {
    await openEvents();
    expect(screen.getByRole('heading', { level: 1, name: 'Eventos' })).toBeInTheDocument();
    expect(tableRows()).toEqual([
      ['Exame novembro/2026', '21/11/2026', 'Aberto', 'EditarExcluir'],
      ['Exame março/2026', '01/03/2026', 'Encerrado', 'EditarExcluir'],
    ]);
  });

  it('orders from the most recent exam date to the oldest; a tie goes to the newest created', async () => {
    // Out of order on purpose: the screen keeps the order of the API (`sort_events`).
    server.use(
      http.get(EVENTS_URL, () =>
        HttpResponse.json([
          makeEvent('a', { name: 'Antigo', exam_date: '2025-06-01' }),
          makeEvent('b', {
            name: 'Mesmo dia, cadastrado antes',
            created_at: '2026-10-01T12:00:00+00:00',
          }),
          makeEvent('c', { name: 'Mais recente', exam_date: '2027-12-01' }),
          makeEvent('d', {
            name: 'Mesmo dia, cadastrado depois',
            created_at: '2026-10-02T12:00:00+00:00',
          }),
        ]),
      ),
    );
    await openEvents();
    expect(rowNames()).toEqual([
      'Mais recente',
      'Mesmo dia, cadastrado depois',
      'Mesmo dia, cadastrado antes',
      'Antigo',
    ]);
  });

  it('says "Carregando eventos…" while the list is on its way', async () => {
    const held = gate();
    server.use(
      http.get(EVENTS_URL, async () => {
        await held.wait;
        return undefined;
      }),
    );
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando eventos…');
    held.release();
    expect(await screen.findByRole('table', { name: 'Eventos' })).toBeInTheDocument();
  });

  it('says there is no event and still offers "Novo evento"', async () => {
    db.events = [];
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    expect(await screen.findByText('Nenhum evento cadastrado.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Novo evento' })).toBeEnabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the load error with "Tentar de novo", which loads the list', async () => {
    let fail = true;
    server.use(
      http.get(EVENTS_URL, () =>
        fail ? HttpResponse.json({ message: 'Falha simulada' }, { status: 500 }) : undefined,
      ),
    );
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar os eventos');
    expect(alert).toHaveTextContent('Falha simulada');

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('table', { name: 'Eventos' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rn016 a 403 of the API says "Sem permissão", with no retry', async () => {
    server.use(
      http.get(EVENTS_URL, () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('rn016 keeps guardians out without asking the API', async () => {
    const requests = recordRequests();
    await renderApp({ route: ROUTE, signedInAs: 'guardian' });
    expect(
      await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Novo evento' })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('on the phone the events are cards with the same data and actions', async () => {
    setViewportWidth(390);
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const list = await screen.findByRole('list', { name: 'Eventos' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    const [open, closed] = cards as [HTMLElement, HTMLElement];
    expect(within(open).getByRole('heading', { name: 'Exame novembro/2026' })).toBeInTheDocument();
    expect(open).toHaveTextContent('Data do exame21/11/2026');
    expect(open).toHaveTextContent('SituaçãoAberto');
    expect(closed).toHaveTextContent('SituaçãoEncerrado');
    expect(
      within(closed).getByRole('button', { name: 'Editar evento Exame março/2026' }),
    ).toBeInTheDocument();
    expect(
      within(closed).getByRole('button', { name: 'Excluir evento Exame março/2026' }),
    ).toBeInTheDocument();
  });

  it('at 768 px the table scrolls inside its own region, reachable by Tab', async () => {
    setViewportWidth(768);
    await openEvents();
    const region = screen.getByRole('region', { name: 'Lista de eventos' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table', { name: 'Eventos' })).toBeInTheDocument();
  });

  it('Tab reaches "Novo evento" and every row button', async () => {
    const { user } = await openEvents();
    const expected = [
      screen.getByRole('button', { name: 'Novo evento' }),
      screen.getByRole('region', { name: 'Lista de eventos' }),
      screen.getByRole('button', { name: 'Editar evento Exame novembro/2026' }),
      screen.getByRole('button', { name: 'Excluir evento Exame novembro/2026' }),
      screen.getByRole('button', { name: 'Editar evento Exame março/2026' }),
      screen.getByRole('button', { name: 'Excluir evento Exame março/2026' }),
    ];
    expected[0]?.focus();
    for (const element of expected.slice(1)) {
      await user.tab();
      expect(element).toHaveFocus();
    }
  });
});

describe('events screen, from the exam day (§ 6.3)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('"Criar evento" opens this screen, and the event created is the one the exam day picks', async () => {
    db.events = [];
    const { user, router } = await renderApp({ route: '/dia-do-exame', signedInAs: 'examiner' });
    await user.click(await screen.findByRole('link', { name: 'Criar evento' }));

    expect(router.state.location.pathname).toBe(ROUTE);
    expect(await screen.findByRole('heading', { level: 1, name: 'Eventos' })).toBeInTheDocument();
    expect(await screen.findByText('Nenhum evento cadastrado.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Novo evento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo evento' });
    await user.type(within(dialog).getByLabelText(/^Nome/), 'Exame dezembro/2026');
    await user.type(within(dialog).getByLabelText(/^Data do exame/), '2026-12-12');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('table', { name: 'Eventos' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Dia do exame' }));
    const picker = await screen.findByRole('combobox', { name: 'Evento' });
    await waitFor(() => {
      expect(picker).toHaveDisplayValue('Exame dezembro/2026 · 12/12/2026 · Aberto');
    });
    expect(screen.queryByText('Nenhum evento cadastrado.')).not.toBeInTheDocument();
  });
});
