/**
 * Focus after "Confirmar presença" (§ 6.3, § 6.7, RN005): it goes to "Abrir exame" only if,
 * when the 201 arrives, it is still on the clicked button or has fallen to the body (a real
 * browser drops it there when the loading button is disabled). Otherwise it stays put.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb, MOCK_EVENT_IDS, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${MOCK_EVENT_IDS.open}/exams`;

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

function cardOf(name: string): HTMLElement {
  return within(screen.getByRole('list', { name: LIST }))
    .getAllByRole('listitem')
    .find((item) => item.textContent.includes(name))!;
}

/** One gate per student: each `POST` waits until its own `release(studentId)`. */
function holdPerStudent() {
  const gates = new Map<string, () => void>();
  const waiting = new Map<string, Promise<void>>();
  const gateOf = (id: string) => {
    if (!waiting.has(id)) {
      waiting.set(
        id,
        new Promise<void>((resolve) => {
          gates.set(id, resolve);
        }),
      );
    }
    return waiting.get(id)!;
  };
  const seen: string[] = [];
  server.use(
    http.post(OPEN_EXAMS_URL, async ({ request }) => {
      const body = (await request.clone().json()) as { student_id: string };
      seen.push(body.student_id);
      await gateOf(body.student_id);
      return undefined;
    }),
  );
  return {
    seen: () => seen.length,
    release: (id: string) => {
      void gateOf(id);
      gates.get(id)!();
    },
  };
}

async function settle(ms = 80) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

let db: MockDb;

/**
 * What a real browser does when the focused button becomes disabled (focus fixup): the
 * focus goes to the body. jsdom ignores `blur()` on a disabled button, so a throwaway
 * element takes the focus and is removed.
 */
function dropFocusToBody() {
  act(() => {
    const temp = document.createElement('div');
    temp.tabIndex = -1;
    document.body.append(temp);
    temp.focus();
    temp.remove();
  });
}

function studentId(name: string): string {
  return db.students.find((item) => item.student.full_name === name)!.student.id;
}

describe('exam day: where the focus goes after the 201 (§ 6.3, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    db = createMockDb({ includeShowcase: true });
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn005 moves the focus to the link when the user just waits on the button', async () => {
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    const button = within(rowOf(table, 'Ana Souza')).getByRole('button', {
      name: 'Confirmar presença de Ana Souza',
    });
    await user.click(button);
    const link = await screen.findByRole('link', { name: 'Abrir exame de Ana Souza' });
    await waitFor(() => expect(link).toHaveFocus());
  });

  it('rn005 moves the focus to the link when it fell to the body while loading', async () => {
    const hold = holdPerStudent();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', {
        name: 'Confirmar presença de Ana Souza',
      }),
    );
    await waitFor(() => {
      expect(hold.seen()).toBe(1);
    });
    dropFocusToBody();
    expect(document.body).toHaveFocus();

    hold.release(studentId('Ana Souza'));
    const link = await screen.findByRole('link', { name: 'Abrir exame de Ana Souza' });
    await waitFor(() => expect(link).toHaveFocus());
  });

  it('rn005 keeps the second button focused when the first confirmation answers first', async () => {
    const hold = holdPerStudent();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    const carlaButton = within(rowOf(table, 'Carla Mendes')).getByRole('button', {
      name: /Confirmar presença/,
    });
    await user.click(carlaButton);
    await waitFor(() => {
      expect(hold.seen()).toBe(2);
    });

    hold.release(studentId('Ana Souza'));
    await screen.findByRole('link', { name: 'Abrir exame de Ana Souza' });
    await settle();
    expect(screen.getByRole('link', { name: 'Abrir exame de Ana Souza' })).not.toHaveFocus();
    expect(carlaButton).toHaveFocus();

    hold.release(studentId('Carla Mendes'));
    const carla = await screen.findByRole('link', { name: 'Abrir exame de Carla Mendes' });
    await waitFor(() => expect(carla).toHaveFocus());
  });

  it('rn005 sends the body focus only to the last clicked row, answers out of order', async () => {
    const hold = holdPerStudent();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await user.click(
      within(rowOf(table, 'Carla Mendes')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await waitFor(() => {
      expect(hold.seen()).toBe(2);
    });
    dropFocusToBody();

    hold.release(studentId('Ana Souza'));
    await screen.findByRole('link', { name: 'Abrir exame de Ana Souza' });
    await settle();
    expect(screen.getByRole('link', { name: 'Abrir exame de Ana Souza' })).not.toHaveFocus();
    expect(document.body).toHaveFocus();

    hold.release(studentId('Carla Mendes'));
    const carla = await screen.findByRole('link', { name: 'Abrir exame de Carla Mendes' });
    await waitFor(() => expect(carla).toHaveFocus());
  });

  it('rn005 leaves the focus on the second link when the first answers last', async () => {
    const hold = holdPerStudent();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    await user.click(
      within(rowOf(table, 'Ana Souza')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await user.click(
      within(rowOf(table, 'Carla Mendes')).getByRole('button', { name: /Confirmar presença/ }),
    );
    await waitFor(() => {
      expect(hold.seen()).toBe(2);
    });

    hold.release(studentId('Carla Mendes'));
    const carla = await screen.findByRole('link', { name: 'Abrir exame de Carla Mendes' });
    await waitFor(() => expect(carla).toHaveFocus());

    hold.release(studentId('Ana Souza'));
    await screen.findByRole('link', { name: 'Abrir exame de Ana Souza' });
    await settle();
    expect(screen.getByRole('link', { name: 'Abrir exame de Carla Mendes' })).toHaveFocus();
  });

  it('rn005 moves the focus to the link on a retry after a failed confirmation', async () => {
    let failures = 1;
    server.use(
      http.post(OPEN_EXAMS_URL, () => {
        if (failures === 0) return undefined;
        failures -= 1;
        return HttpResponse.json({ error: 'Erro interno.' }, { status: 500 });
      }),
    );
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const table = await screen.findByRole('table', { name: LIST });
    const button = within(rowOf(table, 'Ana Souza')).getByRole('button', {
      name: 'Confirmar presença de Ana Souza',
    });
    await user.click(button);
    await screen.findByRole('alert');
    expect(screen.queryByRole('link', { name: 'Abrir exame de Ana Souza' })).toBeNull();

    await user.click(
      within(rowOf(screen.getByRole('table', { name: LIST }), 'Ana Souza')).getByRole('button', {
        name: 'Confirmar presença de Ana Souza',
      }),
    );
    const link = await screen.findByRole('link', { name: 'Abrir exame de Ana Souza' });
    await waitFor(() => expect(link).toHaveFocus());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rn005 moves the focus to the link in a card at 390 px after it fell to the body', async () => {
    setViewportWidth(390);
    const hold = holdPerStudent();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await screen.findByRole('list', { name: LIST });
    await user.click(within(cardOf('Ana Souza')).getByRole('button', { name: /Confirmar/ }));
    await waitFor(() => {
      expect(hold.seen()).toBe(1);
    });
    dropFocusToBody();
    hold.release(studentId('Ana Souza'));
    const link = await within(cardOf('Ana Souza')).findByRole('link', {
      name: 'Abrir exame de Ana Souza',
    });
    await waitFor(() => expect(link).toHaveFocus());
  });

  it('rn005 keeps the focus in the search at 390 px while the card answers late', async () => {
    setViewportWidth(390);
    const hold = holdPerStudent();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await screen.findByRole('list', { name: LIST });
    await user.click(within(cardOf('Ana Souza')).getByRole('button', { name: /Confirmar/ }));
    await waitFor(() => {
      expect(hold.seen()).toBe(1);
    });
    const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });
    await user.click(search);
    await user.type(search, 'ana');
    hold.release(studentId('Ana Souza'));
    await within(cardOf('Ana Souza')).findByRole('link', { name: 'Abrir exame de Ana Souza' });
    await settle();
    expect(search).toHaveFocus();
  });
});
