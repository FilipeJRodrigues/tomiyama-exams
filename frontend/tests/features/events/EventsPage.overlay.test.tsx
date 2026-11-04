/**
 * Events screen (§ 6.5, RN016) with `GET /events` late: the API lists the events with a
 * `Scan` without `ConsistentRead`, so after a write every read here still answers the list
 * from before it. Only the recent writes laid over the list (`recentEventWrites`) keep on the
 * screen what the API confirmed.
 *
 * No race: the late answers carry a marker (the other event renamed to "… (leitura
 * atrasada)"), and each check waits for the marker on the screen, which proves that the late
 * answer has reached it. A read held on its way only answers when the test releases it.
 */
import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExamEvent } from '../../../src/api/types';
import { MOCK_EVENT_IDS, createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import {
  EVENTS_URL,
  dialogGone,
  field,
  gate,
  makeEvent,
  openDelete,
  openEdit,
  openEvents,
  openNew,
  replaceText,
  rowNames,
  statusSelect,
  tableRows,
} from './helpers';

const LATE = 'Exame março/2026 (leitura atrasada)';
const FREE_ID = 'evento-sem-exames';

let db: MockDb;
/** What the late `Scan` answers: the events before the writes, the closed one renamed. */
let lateList: ExamEvent[] | null;
/** The next list read is held until released. */
let held: ReturnType<typeof gate> | null;

function lagTheScan() {
  lateList = db.events.map((event) =>
    event.id === MOCK_EVENT_IDS.closed ? { ...event, name: LATE } : { ...event },
  );
}

async function lateAnswerShown() {
  expect(await screen.findByText(LATE)).toBeInTheDocument();
}

describe('events screen with a late `GET /events`', () => {
  beforeEach(() => {
    db = createMockDb();
    db.events.push(
      makeEvent(FREE_ID, {
        name: 'Exame cancelado',
        exam_date: '2026-08-15',
        created_at: '2026-07-01T12:00:00+00:00',
      }),
    );
    lateList = null;
    held = null;
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    // Used after the mock: it comes first.
    server.use(
      http.get(EVENTS_URL, async () => {
        const hold = held;
        held = null;
        if (hold) await hold.wait;
        return lateList ? HttpResponse.json(lateList) : undefined;
      }),
    );
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it('rn016 a created event stays on the list', async () => {
    const { user } = await openEvents();
    lagTheScan();
    const dialog = await openNew(user);
    await replaceText(user, field(dialog, /^Nome/), 'Exame junho/2026');
    await user.type(field(dialog, /^Data do exame/), '2026-06-20');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    await lateAnswerShown();
    expect(rowNames()).toEqual([
      'Exame novembro/2026',
      'Exame cancelado',
      'Exame junho/2026',
      LATE,
    ]);
  });

  it('rn016 an edited event keeps the name and status saved', async () => {
    const { user } = await openEvents();
    lagTheScan();
    const dialog = await openEdit(user, 'Exame novembro/2026');
    await replaceText(user, field(dialog, /^Nome/), 'Exame de novembro');
    await user.selectOptions(statusSelect(dialog), 'Encerrado');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await dialogGone();

    await lateAnswerShown();
    expect(tableRows()[0]).toEqual([
      'Exame de novembro',
      '21/11/2026',
      'Encerrado',
      'EditarExcluir',
    ]);
  });

  it('rn016 a deleted event does not come back', async () => {
    const { user } = await openEvents();
    lagTheScan();
    const dialog = await openDelete(user, 'Exame cancelado');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await dialogGone();

    await lateAnswerShown();
    expect(rowNames()).toEqual(['Exame novembro/2026', LATE]);
  });

  it('rn016 a read asked before the deletion and answered after it does not bring it back', async () => {
    const { user } = await openEvents();
    lagTheScan();
    // The window gets the focus back: the list reloads, and that read is held on its way.
    held = gate();
    const reload = held;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    const dialog = await openDelete(user, 'Exame cancelado');
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await dialogGone();
    reload.release();

    await lateAnswerShown();
    await waitFor(() => {
      expect(rowNames()).toEqual(['Exame novembro/2026', LATE]);
    });
  });
});
