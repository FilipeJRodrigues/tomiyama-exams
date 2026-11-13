/**
 * Exam day (§ 6.3, #28): the chosen event is not in the list (deleted meanwhile, or a link to
 * one that is gone). The screen says so in a notice and waits for the examiner to pick an event:
 * it never moves to another one on its own, where "Confirmar presença" would create the exam
 * (RN005). These cases complete the regressions of #28: the phone (cards, 360 px, § 6.7), the
 * "Encerrar evento" dialog of a deleted event, and the choices left to the screen (the menu link
 * to the same screen, the focus on a link to a missing event, no event at all).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import { dialogGone, makeEvent } from '../events/helpers';

const OPEN = MOCK_EVENT_IDS.open;
const OPEN_NAME = 'Exame novembro/2026';
/** Open and the most recent one (the default), with no exams: it can be deleted (RN016). */
const GONE = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c0d';
const GONE_NAME = 'Exame dezembro/2026';
const MISSING = '5e1b7c2a-3d4f-4a6b-8c9d-0e1f2a3b4c99';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const TITLE = 'Dia do exame';
const NOT_FOUND =
  'O evento escolhido não foi encontrado. Ele pode ter sido apagado. Escolha um evento na lista.';
const NO_CHOICE = 'Nenhum evento escolhido';

let db: MockDb;

function picker(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Evento' });
}

function pickerText(): string {
  return picker().selectedOptions[0]?.textContent ?? '';
}

function alertTexts(): string[] {
  return screen
    .queryAllByRole('alert')
    .map((alert) => alert.textContent.replace(/\s+/g, ' ').trim());
}

function studentLists(): HTMLElement[] {
  return [
    ...screen.queryAllByRole('table', { name: LIST }),
    ...screen.queryAllByRole('list', { name: LIST }),
  ];
}

function title(): HTMLElement {
  return screen.getByRole('heading', { level: 1, name: TITLE });
}

function deleteEvent(id: string) {
  db.events = db.events.filter((event) => event.id !== id);
}

describe('exam day, the chosen event is not in the list (§ 6.3, § 6.7, #28)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    db.events.push(makeEvent(GONE, { name: GONE_NAME, exam_date: '2026-12-12' }));
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn005 on the phone: the cards give way to the notice, the focus goes to the title and the picker brings a list back', async () => {
    setViewportWidth(360);
    const { user, router } = await renderApp({
      route: `${ROUTE}?evento=${GONE}`,
      signedInAs: 'examiner',
    });
    const cards = await screen.findByRole('list', { name: LIST });
    deleteEvent(GONE);
    await user.click(
      within(cards).getByRole('button', { name: 'Confirmar presença de Ana Souza' }),
    );

    await waitFor(() => {
      expect(alertTexts()).toEqual([NOT_FOUND]);
    });
    expect(pickerText()).toBe(NO_CHOICE);
    expect(studentLists()).toEqual([]);
    expect(screen.queryByRole('button', { name: /^(Encerrar|Reabrir) evento/ })).toBeNull();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    await waitFor(() => {
      expect(title()).toHaveFocus();
    });

    await user.selectOptions(picker(), OPEN);
    expect(await screen.findByRole('list', { name: LIST })).toBeInTheDocument();
    expect(alertTexts()).toEqual([]);
    expect(router.state.location.search).toBe(`?evento=${OPEN}`);
  });

  it('"Encerrar evento" of an event deleted meanwhile: once the dialog closes, the notice and the focus on the title', async () => {
    const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await screen.findByRole('table', { name: LIST });
    await user.click(screen.getByRole('button', { name: `Encerrar evento ${GONE_NAME}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Encerrar evento' });
    deleteEvent(GONE);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Evento não encontrado');

    await user.keyboard('{Escape}');
    await dialogGone();
    await waitFor(() => {
      expect(alertTexts()).toEqual([NOT_FOUND]);
    });
    expect(pickerText()).toBe(NO_CHOICE);
    expect(studentLists()).toEqual([]);
    // Neither the button of the deleted event nor the one of the other open event.
    expect(screen.queryByRole('button', { name: `Encerrar evento ${OPEN_NAME}` })).toBeNull();
    expect(router.state.location.search).toBe('');
    expect(title()).toHaveFocus();
  });

  it('the menu link to the same screen keeps the notice: no event is picked for the examiner', async () => {
    const { user, router } = await renderApp({
      route: `${ROUTE}?evento=${MISSING}`,
      signedInAs: 'examiner',
    });
    await waitFor(() => {
      expect(alertTexts()).toEqual([NOT_FOUND]);
    });
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });

    const before = router.state.location.key;
    const menu = screen.getByRole('navigation', { name: 'Menu principal' });
    await user.click(within(menu).getByRole('link', { name: TITLE }));
    await waitFor(() => {
      expect(router.state.location.key).not.toBe(before);
    });
    expect(router.state.location.pathname).toBe(ROUTE);
    expect(alertTexts()).toEqual([NOT_FOUND]);
    expect(pickerText()).toBe(NO_CHOICE);
    expect(studentLists()).toEqual([]);
    expect(router.state.location.search).toBe('');
  });

  it('a link to a missing event does not move the focus: no list was there to take it away', async () => {
    await renderApp({ route: `${ROUTE}?evento=${MISSING}`, signedInAs: 'examiner' });
    await waitFor(() => {
      expect(alertTexts()).toEqual([NOT_FOUND]);
    });
    expect(title()).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('with no event at all, a link to a missing one shows the empty state and leaves the URL', async () => {
    db.events = [];
    const { router } = await renderApp({
      route: `${ROUTE}?evento=${MISSING}`,
      signedInAs: 'examiner',
    });
    expect(await screen.findByText('Nenhum evento cadastrado.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Criar evento' })).toBeInTheDocument();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(alertTexts()).toEqual([]);
  });
});
