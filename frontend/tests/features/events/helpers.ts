/** Shared steps of the events screen tests (§ 6.5). */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http } from 'msw';
import { expect } from 'vitest';

import type { ExamEvent } from '../../../src/api/types';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

export const EVENTS_URL = `${TEST_API_URL}/events`;
export const ROUTE = '/eventos';

/** An event of the tests; `id` and `created_at` decide the ties of the order. */
export function makeEvent(id: string, fields: Partial<ExamEvent> = {}): ExamEvent {
  return {
    id,
    name: `Evento ${id}`,
    exam_date: '2027-03-20',
    status: 'OPEN',
    created_at: '2026-10-01T12:00:00+00:00',
    updated_at: '2026-10-01T12:00:00+00:00',
    ...fields,
  };
}

/** The cells of each body row of the table, as text. */
export function tableRows(): string[][] {
  const table = screen.getByRole('table', { name: 'Eventos' });
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent.trim()),
  );
}

/** Names of the rows, in screen order. */
export function rowNames(): string[] {
  return tableRows().map((cells) => cells[0] ?? '');
}

export async function openEvents(role: 'examiner' | 'guardian' = 'examiner') {
  const result = await renderApp({ route: ROUTE, signedInAs: role });
  if (role === 'examiner') await screen.findByRole('table', { name: 'Eventos' });
  return result;
}

export async function openNew(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Novo evento' }));
  return screen.findByRole('dialog', { name: 'Novo evento' });
}

export async function openEdit(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Editar evento ${name}` }));
  return screen.findByRole('dialog', { name: 'Editar evento' });
}

export async function openDelete(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: `Excluir evento ${name}` }));
  return screen.findByRole('dialog', { name: 'Excluir evento' });
}

export function field(dialog: HTMLElement, label: RegExp): HTMLInputElement {
  return within(dialog).getByLabelText<HTMLInputElement>(label);
}

export function statusSelect(dialog: HTMLElement): HTMLSelectElement {
  return within(dialog).getByRole<HTMLSelectElement>('combobox', { name: /^Situação/ });
}

/** Replace the text of a field (paste: same React events, less work for the suite). */
export async function replaceText(user: UserEvent, input: HTMLElement, text: string) {
  await user.clear(input);
  if (text) {
    await user.click(input);
    await user.paste(text);
  }
}

export async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

/** A response held until `release()`: the state in between is checked with no race. */
export function gate() {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  const release = () => {
    open();
  };
  return { wait, release };
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

/** Records every request to `/events` and `/events/{id}` and lets the mock answer. */
export function recordRequests(): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const record = async ({ request }: { request: Request }) => {
    const text = await request.clone().text();
    requests.push({
      method: request.method,
      url: request.url,
      body: text ? (JSON.parse(text) as unknown) : null,
    });
    return undefined;
  };
  server.use(http.all(EVENTS_URL, record), http.all(`${EVENTS_URL}/:id`, record));
  return requests;
}

export function writes(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.method !== 'GET');
}
