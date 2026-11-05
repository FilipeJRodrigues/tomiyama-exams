/**
 * Requirements screen (§ 6.5, § 6.7): the belts and then the requirements of the chosen belt
 * are two reads in sequence. "Tentar de novo" of the belts waits for the requirements too: if
 * they fail on their first read, the focus goes to their "Tentar de novo", not to the title.
 * The data-arrived and failed-again cases are in
 * `tests/regression/52-foco-perdido-tentar-de-novo-telas.test.tsx`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const BELTS_ERROR = 'Não foi possível carregar as faixas';
const REQUIREMENTS_ERROR = 'Não foi possível carregar os requisitos';

function busy() {
  return HttpResponse.json({ message: BUSY }, { status: 503 });
}

function retryOf(error: string): HTMLElement {
  const alert = screen.getByText(error).closest<HTMLElement>('[role="alert"]')!;
  return within(alert).getByRole('button', { name: 'Tentar de novo' });
}

beforeEach(() => {
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
});

it('belts back, requirements fail on their first read: the focus goes to their "Tentar de novo"', async () => {
  let beltReads = 0;
  server.use(
    http.get(`${TEST_API_URL}/belts`, () => {
      beltReads += 1;
      return beltReads === 1 ? busy() : undefined;
    }),
    http.get(`${TEST_API_URL}/requirements`, busy),
  );
  const { user } = await renderApp({ route: '/requisitos', signedInAs: 'examiner' });
  await screen.findByText(BELTS_ERROR);

  retryOf(BELTS_ERROR).focus();
  await user.keyboard('{Enter}');

  expect(await screen.findByText(REQUIREMENTS_ERROR)).toBeInTheDocument();
  await waitFor(() => {
    expect(retryOf(REQUIREMENTS_ERROR)).toHaveFocus();
  });
});
