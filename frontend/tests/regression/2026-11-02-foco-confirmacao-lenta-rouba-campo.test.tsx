/**
 * Erro: com a resposta de "Confirmar presença" demorando (rede lenta no ginásio), o
 * examinador já passa para outra coisa: clica na busca e digita, ou escolhe o filtro
 * Presentes. Quando o 201 chega, o link "Abrir exame de Ana Souza" toma o foco do campo em
 * que o usuário está, e as teclas seguintes vão para o link: o Backspace digitado na busca
 * não apaga nada ("souza" continua "souza"), e as setas do filtro deixam de funcionar.
 * Esperado: o foco só vai para "Abrir exame" se continuar no botão que foi clicado (ou se
 * tiver se perdido com a troca do botão pelo link); se o usuário levou o foco para outro
 * controle enquanto esperava, ele fica lá (§ 6.3, teclado em § 6.7). Mesmo sintoma da
 * regressão 2026-11-02-foco-abrir-exame-rouba-busca.test.tsx, por outro caminho.
 * Issue: (nenhuma; 2ª rodada de QA da tela Dia do exame, 2026-11-02)
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockDb, MOCK_EVENT_IDS } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ROUTE = '/dia-do-exame';
const LIST = 'Alunos do evento';
const OPEN_EXAMS_URL = `${TEST_API_URL}/events/${MOCK_EVENT_IDS.open}/exams`;

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table).getByRole('rowheader', { name }).closest('tr')!;
}

/** Holds `POST /events/{id}/exams` until `release`, then lets the simulated API answer. */
function holdConfirmation() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  server.use(
    http.post(OPEN_EXAMS_URL, async () => {
      held += 1;
      await gate;
      return undefined;
    }),
  );
  return {
    held: () => held,
    release: () => {
      open();
    },
  };
}

async function startConfirmingAna() {
  const confirmation = holdConfirmation();
  const rendered = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
  const table = await screen.findByRole('table', { name: LIST });
  await rendered.user.click(
    within(rowOf(table, 'Ana Souza')).getByRole('button', {
      name: 'Confirmar presença de Ana Souza',
    }),
  );
  await waitFor(() => {
    expect(confirmation.held()).toBe(1);
  });
  return { ...rendered, release: confirmation.release };
}

async function answerArrives(release: () => void) {
  release();
  await screen.findByRole('link', { name: 'Abrir exame de Ana Souza' });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

describe('exam day: focus when the confirmation answers late (§ 6.3, § 6.7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 2, 12) });
    server.use(
      ...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb({ includeShowcase: true }) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rn005 keeps the focus in the search the user went to while waiting', async () => {
    const { user, release } = await startConfirmingAna();
    const search = screen.getByRole('searchbox', { name: 'Buscar por nome' });
    await user.click(search);
    await user.type(search, 'souza');

    await answerArrives(release);
    await user.keyboard('{Backspace}');

    expect(search).toHaveFocus();
    expect(search).toHaveValue('souz');
  });

  it('rn005 keeps the focus on the filter the user chose while waiting', async () => {
    const { user, release } = await startConfirmingAna();
    const filters = screen.getByRole('radiogroup', { name: 'Filtrar alunos' });
    await user.click(within(filters).getByRole('radio', { name: /^Presentes/ }));

    await answerArrives(release);

    expect(within(filters).getByRole('radio', { name: /^Presentes/ })).toHaveFocus();
  });
});
