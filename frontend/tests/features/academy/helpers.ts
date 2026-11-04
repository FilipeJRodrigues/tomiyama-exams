/** Shared steps of the academy screen tests (§ 6.6). */
import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http } from 'msw';

import type { AcademySettings } from '../../../src/api/types';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

export const SETTINGS_URL = `${TEST_API_URL}/settings`;
export const EXAMINERS_URL = `${TEST_API_URL}/examiners`;
export const ROUTE = '/academia';

export type Profile = 'examiner' | 'guardian' | 'master';

/** Opens the screen and, for an examiner, waits for the form. */
export async function openAcademy(profile: Profile = 'examiner') {
  const result = await renderApp({ route: ROUTE, signedInAs: profile });
  if (profile !== 'guardian') await screen.findByRole('form', { name: 'Dados da academia' });
  return result;
}

export function nameField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/^Nome da academia/);
}

export function cityField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(/^Cidade do certificado/);
}

export function senseiSelect(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: /^Sensei/ });
}

/** Labels of the selector's options, in screen order. */
export function senseiOptionLabels(): string[] {
  return Array.from(senseiSelect().options).map((option) => option.text);
}

export function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Salvar' });
}

/** Replace the text of a field (paste: same React events, less work for the suite). */
export async function replaceText(user: UserEvent, input: HTMLElement, text: string) {
  await user.clear(input);
  if (text) {
    await user.click(input);
    await user.paste(text);
  }
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

/** Records every request to `/settings` and `/examiners` and lets the mock answer. */
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
  server.use(http.all(SETTINGS_URL, record), http.all(EXAMINERS_URL, record));
  return requests;
}

export function puts(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.method === 'PUT');
}

/** A `GET /settings` answer of the tests. */
export function makeSettings(fields: Partial<AcademySettings> = {}): AcademySettings {
  return {
    academy_name: 'Associação Tomiyama de Judô',
    sensei_user_id: 'sensei-1',
    certificate_city: 'Araraquara',
    created_at: '2026-10-01T12:00:00+00:00',
    updated_at: '2026-10-01T12:00:00+00:00',
    sensei: { id: 'sensei-1', email: 'sensei@example.com', name: 'Tomiyama', active: true },
    ...fields,
  };
}
