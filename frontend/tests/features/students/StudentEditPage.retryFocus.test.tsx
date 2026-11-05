/**
 * Student form in edit mode (§ 6.2, § 6.7): where the focus goes after "Tentar de novo" of the
 * load when the screen does not end with the form. The data-arrived and failed-again cases are
 * in `tests/regression/52-foco-perdido-tentar-de-novo-telas.test.tsx`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';

const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';
const STUDENT_URL = `${TEST_API_URL}/students/${ANA}`;
const BELTS_URL = `${TEST_API_URL}/belts`;
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const STUDENT_ERROR = 'Não foi possível carregar o aluno';
const BELTS_ERROR = 'Não foi possível carregar as faixas';

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
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
});

describe('editar aluno: foco depois de "Tentar de novo" (§ 6.7)', () => {
  it('the student comes but the belts are still in error: the focus is on their "Tentar de novo"', async () => {
    failsOnceThen(STUDENT_URL, () => undefined);
    server.use(http.get(BELTS_URL, busy));
    const { user } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    await screen.findByText(STUDENT_ERROR);

    retryOf(STUDENT_ERROR).focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByText(BELTS_ERROR)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(STUDENT_ERROR)).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(retryOf(BELTS_ERROR)).toHaveFocus();
    });
  });

  it('the reload ends in a 404: the focus goes to the "Aluno não encontrado" title', async () => {
    failsOnceThen(STUDENT_URL, () =>
      HttpResponse.json({ message: 'Aluno não encontrado' }, { status: 404 }),
    );
    const { user } = await renderApp({ route: `/alunos/${ANA}`, signedInAs: 'guardian' });
    await screen.findByText(STUDENT_ERROR);

    retryOf(STUDENT_ERROR).focus();
    await user.keyboard('{Enter}');

    const title = await screen.findByRole('heading', { level: 1, name: 'Aluno não encontrado' });
    await waitFor(() => {
      expect(title).toHaveFocus();
    });
  });
});
