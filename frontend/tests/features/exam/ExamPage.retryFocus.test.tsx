/**
 * Exam screen (§ 6.4, § 6.7): where the focus goes after "Tentar de novo" of a load, beyond
 * `tests/regression/52-foco-perdido-tentar-de-novo-telas.test.tsx` (which takes the title or
 * the decision area): "quem é o sensei" gives it to the decision area of the summary, where
 * the error was, and an exam that comes back as a 404 gives it to the title of that page.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { examPath } from '../../../src/app/navigation';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const OPEN = MOCK_EVENT_IDS.open;
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';

function busy() {
  return HttpResponse.json({ message: BUSY }, { status: 503 });
}

/** The first GET of `url` fails (503); the next one answers `then()`. */
function failsOnceThen(url: string, then: () => Response | undefined) {
  let reads = 0;
  server.use(
    http.get(url, () => {
      reads += 1;
      return reads === 1 ? busy() : then();
    }),
  );
}

function retryOf(error: string): HTMLElement {
  const alert = screen.getByText(error).closest<HTMLElement>('[role="alert"]')!;
  return within(alert).getByRole('button', { name: 'Tentar de novo' });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
  const db = createMockDb({ includeShowcase: true });
  db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

afterEach(() => {
  vi.useRealTimers();
});

it('"quem é o sensei" loads again: the focus goes to the decision area of the summary', async () => {
  const error = 'Não foi possível saber quem é o sensei';
  failsOnceThen(`${TEST_API_URL}/settings`, () => undefined);
  const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByText(error);

  retryOf(error).focus();
  await user.keyboard('{Enter}');

  const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
  expect(await within(summary).findByRole('button', { name: 'Aprovar' })).toBeInTheDocument();
  await waitFor(() => {
    expect(document.activeElement).toHaveAttribute('data-decision-area');
  });
  expect(summary).toContainElement(document.activeElement as HTMLElement);
});

it('the exam comes back as a 404: the focus goes to the title of that page', async () => {
  const error = 'Não foi possível carregar o exame';
  failsOnceThen(`${TEST_API_URL}/events/${OPEN}/exams/${HELENA}`, () =>
    HttpResponse.json({ message: 'Exame não encontrado' }, { status: 404 }),
  );
  const { user } = await renderApp({ route: examPath(OPEN, HELENA), signedInAs: 'examiner' });
  await screen.findByText(error);

  retryOf(error).focus();
  await user.keyboard('{Enter}');

  const title = await screen.findByRole('heading', { level: 1, name: 'Exame não encontrado' });
  await waitFor(() => {
    expect(title).toHaveFocus();
  });
});
