/**
 * `ChangeEventStatusDialog` on its own, as another screen (the exam day) will use it: the
 * screen passes the event as it shows it now, also after the change. The dialog keeps the
 * texts of its opening while it fades out, reads the event again at the next opening, and the
 * change reloads the students' exam notices (RN019: a closed event has no notice).
 */
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExamEvent } from '../../../src/api/types';
import { AppProviders } from '../../../src/app/AppProviders';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { ChangeEventStatusDialog } from '../../../src/features/events/ChangeEventStatusDialog';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { holdExitTransitions } from '../../exitTransitions';
import { server, TEST_API_URL } from '../../msw-server';
import { dialogGone, recordRequests, writes } from './helpers';

const NOTICES_KEY = ['student', 'aluno-qualquer', 'exam-notices'] as const;

let db: MockDb;

function Screen({ initial, onClosed }: { initial: ExamEvent; onClosed: () => void }) {
  const [event, setEvent] = useState(initial);
  const [opened, setOpened] = useState(true);
  return (
    <>
      <p data-testid="live-status">{event.status}</p>
      <button
        type="button"
        onClick={() => {
          setOpened(true);
        }}
      >
        Abrir de novo
      </button>
      <ChangeEventStatusDialog
        event={event}
        opened={opened}
        fullScreen={false}
        onClose={() => {
          setOpened(false);
        }}
        onChanged={(saved) => {
          setEvent(saved);
          setOpened(false);
        }}
        onClosed={onClosed}
      />
    </>
  );
}

async function renderDialog(event: ExamEvent) {
  const auth = createMockAuth(null);
  await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role: 'examiner' });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  queryClient.setQueryData(NOTICES_KEY, []);
  const onClosed = vi.fn();
  const user = userEvent.setup({ delay: null });
  render(
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      <Screen initial={event} onClosed={onClosed} />
    </AppProviders>,
  );
  const dialog = await screen.findByRole('dialog', {
    name: event.status === 'OPEN' ? 'Encerrar evento' : 'Reabrir evento',
  });
  return { user, queryClient, onClosed, dialog };
}

function openEvent(): ExamEvent {
  const event = db.events.find((candidate) => candidate.id === MOCK_EVENT_IDS.open);
  if (!event) throw new Error('sem o evento aberto');
  return { ...event };
}

describe('ChangeEventStatusDialog outside the events list', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn016 keeps the texts of its opening while it fades out, then reads the event again', async () => {
    const requests = recordRequests();
    const { user, onClosed, dialog } = await renderDialog(openEvent());
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));

    const exit = holdExitTransitions();
    await waitFor(() => {
      expect(screen.getByTestId('live-status')).toHaveTextContent('CLOSED');
    });
    // The screen already shows the event closed; the dialog still says what it did.
    expect(screen.getByRole('dialog', { name: 'Encerrar evento' })).toBeInTheDocument();
    exit.release();
    await dialogGone();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(writes(requests).map((request) => request.body)).toEqual([
      { name: 'Exame novembro/2026', status: 'CLOSED' },
    ]);

    await user.click(screen.getByRole('button', { name: 'Abrir de novo' }));
    const again = await screen.findByRole('dialog', { name: 'Reabrir evento' });
    expect(again).toHaveTextContent(
      'Reabrir o evento “Exame novembro/2026” (21/11/2026)? A presença e a marcação dos itens voltam a ser permitidas.',
    );
    expect(within(again).getByRole('button', { name: 'Reabrir' })).toBeInTheDocument();
  });

  it('rn019 a change of status reloads the exam notices in cache', async () => {
    const { user, queryClient, dialog } = await renderDialog(openEvent());
    expect(queryClient.getQueryState(NOTICES_KEY)?.isInvalidated).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Encerrar' }));
    await dialogGone();
    expect(queryClient.getQueryState(NOTICES_KEY)?.isInvalidated).toBe(true);
  });
});
