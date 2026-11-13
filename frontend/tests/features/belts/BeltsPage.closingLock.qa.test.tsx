/**
 * Faixas (§ 6.5, § 6.7): a trava de envio presa até o diálogo terminar de fechar (#88) não
 * pode ficar presa depois dele. Salvar de novo depois do fechamento, `Esc`/"Fechar"/"Cancelar"
 * durante a saída, erro e nova tentativa, reabrir outra faixa durante a saída, sair da tela
 * durante a saída e o diálogo em tela cheia no celular.
 *
 * A resposta da API e a saída do diálogo são seguradas pelo teste (`holdExitTransitions`), sem
 * espera real.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { holdExitTransitions } from '../../exitTransitions';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp, type RenderAppResult } from '../../render';
import { setViewportWidth } from '../../viewport';

const BELTS_URL = `${TEST_API_URL}/belts`;

type Answer = 'ok' | '503' | '504';

interface PutControl {
  count: number;
  /** Answers of the next PUTs, in order; with none left the mock saves. */
  answers: Answer[];
  /** The next PUT waits for `open()`. */
  hold: () => { open: () => void };
}

function controlPuts(): PutControl {
  let gate: Promise<void> | null = null;
  const control: PutControl = {
    count: 0,
    answers: [],
    hold: () => {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open };
    },
  };
  server.use(
    http.put(`${BELTS_URL}/:id`, async () => {
      control.count += 1;
      if (gate) {
        const waiting = gate;
        gate = null;
        await waiting;
      }
      const answer = control.answers.shift() ?? 'ok';
      if (answer === '503') {
        return HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 });
      }
      if (answer === '504') {
        return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
      }
      return undefined;
    }),
  );
  return control;
}

async function openBelts(): Promise<RenderAppResult> {
  // Enter in the Nome field: a field only for the admin master (#143).
  const result = await renderApp({ route: '/faixas', signedInAs: 'master' });
  await screen.findByRole('heading', { name: 'Faixas', level: 1 });
  await screen.findByRole('button', { name: 'Editar faixa Cinza' });
  return result;
}

async function openEditor(user: UserEvent, name: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: `Editar faixa ${name}` }));
  return screen.findByRole('dialog', { name: `Editar faixa ${name}` });
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

/** Saves the open dialog with Enter in the Nome field and waits for it to be gone. */
async function saveWithEnter(user: UserEvent, dialog: HTMLElement) {
  await user.click(within(dialog).getByLabelText(/^Nome/));
  await user.keyboard('{Enter}');
}

/** The PUT on its way answers while the closing is held: the dialog stays on the screen. */
async function answerAndHoldClosing(open: () => void, belt: string) {
  const exit = holdExitTransitions();
  open();
  expect(await screen.findByRole('status')).toHaveTextContent(`Faixa ${belt} salva.`);
  expect(screen.getByRole('dialog', { name: `Editar faixa ${belt}` })).toBeInTheDocument();
  return exit;
}

describe('faixas: a trava de envio não fica presa depois do fechamento (qa-frontend, #88)', () => {
  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  });

  it('depois de salvar e o diálogo fechar, abrir a mesma faixa e outra e salvar envia de novo', async () => {
    const puts = controlPuts();
    const { user } = await openBelts();

    await saveWithEnter(user, await openEditor(user, 'Cinza'));
    await dialogGone();
    expect(puts.count).toBe(1);

    await saveWithEnter(user, await openEditor(user, 'Cinza'));
    await dialogGone();
    expect(puts.count).toBe(2);

    const azul = await openEditor(user, 'Azul');
    await user.click(within(azul).getByRole('button', { name: 'Salvar' }));
    await dialogGone();
    expect(puts.count).toBe(3);
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Azul salva.');
  });

  it('Esc, "Fechar" e "Cancelar" durante a saída não enviam nada nem travam a próxima edição', async () => {
    const puts = controlPuts();
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    const { open } = puts.hold();
    await saveWithEnter(user, dialog);
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    const exit = await answerAndHoldClosing(open, 'Cinza');

    await user.keyboard('{Escape}');
    await user.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    exit.release();
    await dialogGone();
    expect(puts.count).toBe(1);
    // § 6.7: the focus goes back to the belt's edit button, as before #88.
    expect(screen.getByRole('button', { name: 'Editar faixa Cinza' })).toHaveFocus();

    await saveWithEnter(user, await openEditor(user, 'Cinza'));
    await dialogGone();
    expect(puts.count).toBe(2);
  });

  it('503 e 504 deixam tentar de novo no mesmo diálogo; depois do sucesso a próxima edição envia', async () => {
    const puts = controlPuts();
    puts.answers = ['503', '504'];
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');

    await saveWithEnter(user, dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Sistema ocupado no momento.',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });

    await saveWithEnter(user, dialog);
    await waitFor(() => {
      expect(puts.count).toBe(2);
    });
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled();
    });
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();

    await saveWithEnter(user, dialog);
    await dialogGone();
    expect(puts.count).toBe(3);
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Cinza salva.');

    await saveWithEnter(user, await openEditor(user, 'Cinza'));
    await dialogGone();
    expect(puts.count).toBe(4);
  });

  it('abrir outra faixa durante a saída cancela o fechamento e a trava: a outra salva uma vez', async () => {
    const puts = controlPuts();
    const { user } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    const { open } = puts.hold();
    await saveWithEnter(user, dialog);
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    const exit = await answerAndHoldClosing(open, 'Cinza');

    // The edit button behind the dialog that fades out (jsdom does not apply the overlay).
    await user.click(screen.getByRole('button', { name: 'Editar faixa Azul' }));
    exit.release();
    const azul = await screen.findByRole('dialog', { name: 'Editar faixa Azul' });
    await saveWithEnter(user, azul);
    await dialogGone();
    expect(puts.count).toBe(2);
    expect(screen.getByRole('status')).toHaveTextContent('Faixa Azul salva.');
  });

  it('sair da tela durante a saída e voltar: a edição seguinte salva normalmente', async () => {
    const puts = controlPuts();
    const { user, router } = await openBelts();
    const dialog = await openEditor(user, 'Cinza');
    const { open } = puts.hold();
    await saveWithEnter(user, dialog);
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    const exit = await answerAndHoldClosing(open, 'Cinza');

    await act(() => router.navigate('/eventos'));
    await screen.findByRole('heading', { name: 'Eventos', level: 1 });
    exit.release();
    await act(() => router.navigate('/faixas'));
    await screen.findByRole('button', { name: 'Editar faixa Cinza' });

    await saveWithEnter(user, await openEditor(user, 'Cinza'));
    await dialogGone();
    expect(puts.count).toBe(2);
  });

  it('no celular (tela cheia): Enter durante a saída não envia e o foco volta ao "Editar"', async () => {
    setViewportWidth(375);
    const puts = controlPuts();
    const { user } = await openBelts();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const dialog = await openEditor(user, 'Cinza');
    const { open } = puts.hold();
    await saveWithEnter(user, dialog);
    await waitFor(() => {
      expect(puts.count).toBe(1);
    });
    const exit = await answerAndHoldClosing(open, 'Cinza');

    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(puts.count).toBe(1);
    expect(screen.getByRole('button', { name: 'Editar faixa Cinza' })).toHaveFocus();

    await saveWithEnter(user, await openEditor(user, 'Cinza'));
    await dialogGone();
    expect(puts.count).toBe(2);
  });
});
