/** Shared steps of the requirements screen tests (§ 6.5). */
import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http } from 'msw';

import type { RequirementInput } from '../../../src/api/types';
import { mockBelts } from '../../../src/mocks/data';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

export const REQUIREMENTS_URL = `${TEST_API_URL}/requirements`;

export function beltId(name: string): string {
  const belt = mockBelts.find((item) => item.name === name);
  if (!belt) throw new Error(`sem a faixa ${name}`);
  return belt.id;
}

/** The cells of each body row of the table, as text. */
export function tableRows(): string[][] {
  const table = screen.getByRole('table', { name: 'Requisitos' });
  const [, ...rows] = within(table).getAllByRole('row');
  return rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent.trim()),
  );
}

/** Descriptions of the rows, in screen order. */
export function rowDescriptions(): string[] {
  return tableRows().map((cells) => cells[3] ?? '');
}

/** The filters above the list (outside any dialog). */
export function beltFilter(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: 'Faixa' });
}

export function kindFilter(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: 'Tipo' });
}

export async function openRequirements(role: 'examiner' | 'guardian' = 'examiner') {
  const result = await renderApp({ route: '/requisitos', signedInAs: role });
  if (role === 'examiner') await screen.findByRole('table', { name: 'Requisitos' });
  return result;
}

/** Replace the text of a field (paste: same React events, less work for the suite). */
export async function replaceText(user: UserEvent, input: HTMLElement, text: string) {
  await user.clear(input);
  if (text) {
    await user.click(input);
    await user.paste(text);
  }
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: RequirementInput | null;
}

/** Records every request to `/requirements` (and below) and lets the mock answer. */
export function recordRequests(): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const record = async ({ request }: { request: Request }) => {
    const text = await request.clone().text();
    requests.push({
      method: request.method,
      url: request.url,
      body: text ? (JSON.parse(text) as RequirementInput) : null,
    });
    return undefined;
  };
  server.use(http.all(REQUIREMENTS_URL, record), http.all(`${REQUIREMENTS_URL}/:id`, record));
  return requests;
}

export function writes(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.method !== 'GET');
}
