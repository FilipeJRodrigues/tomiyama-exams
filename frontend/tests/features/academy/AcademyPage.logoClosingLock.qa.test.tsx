/**
 * Academia, logos (§ 6.6, § 6.7, RN012): a trava do espaço presa até a confirmação "Remover"
 * terminar de fechar (#88) não pode ficar presa depois dela. Remover, enviar outro arquivo e
 * remover de novo; o outro espaço durante a saída; remoção recusada e "Cancelar"; o "Carregar"
 * durante a saída; a confirmação em tela cheia no celular.
 *
 * A resposta da API e a saída do diálogo são seguradas pelo teste (`holdExitTransitions`), sem
 * espera real.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogoSlot } from '../../../src/api/types';
import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { holdExitTransitions } from '../../exitTransitions';
import { server, TEST_API_URL } from '../../msw-server';
import { setViewportWidth } from '../../viewport';
import { openAcademy } from './helpers';
import {
  JPEG_BYTES,
  PNG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  mockLogo,
  ofMethod,
  recordLogoRequests,
  slotButton,
  slotRegion,
} from './logoHelpers';

const TITLE = 'Remover logo principal';

interface DeleteControl {
  /** Answers of the next DELETEs, in order; with none left the mock removes. */
  answers: ('ok' | '503')[];
  /** The next DELETE waits for `open()`. */
  hold: () => { open: () => void };
}

function controlDeletes(slot: LogoSlot): DeleteControl {
  let gate: Promise<void> | null = null;
  const control: DeleteControl = {
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
    http.delete(logoUrl(slot), async () => {
      if (gate) {
        const waiting = gate;
        gate = null;
        await waiting;
      }
      if ((control.answers.shift() ?? 'ok') === '503') {
        return HttpResponse.json({ message: 'Sistema ocupado no momento.' }, { status: 503 });
      }
      return undefined;
    }),
  );
  return control;
}

async function openLogos() {
  const result = await openAcademy('examiner');
  await waitFor(() => {
    expect(screen.queryByText('Carregando logo…')).not.toBeInTheDocument();
  });
  return result;
}

async function dialogGone() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

async function openRemove(user: UserEvent) {
  await user.click(slotButton('primary', 'Remover'));
  return screen.findByRole('dialog', { name: TITLE });
}

describe('logos: a trava do espaço não fica presa depois da remoção (qa-frontend, #88)', () => {
  beforeEach(() => {
    const db = createMockDb();
    db.logos.primary = mockLogo(PNG_BYTES);
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('remover, enviar outro arquivo e remover de novo: cada ação sai uma vez', async () => {
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    const dialog = await openRemove(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await dialogGone();
    const region = slotRegion('primary');
    expect(region).toHaveTextContent('Nenhum logo');
    // § 6.7: the focus goes to "Carregar", as before #88.
    expect(slotButton('primary', 'Carregar')).toHaveFocus();

    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    expect(await within(region).findByRole('status')).toHaveTextContent('Logo principal salvo.');
    await waitFor(() => {
      expect(slotButton('primary', 'Remover')).toBeEnabled();
    });

    const again = await openRemove(user);
    await user.click(within(again).getByRole('button', { name: 'Remover' }));
    await dialogGone();
    expect(within(region).getByRole('status')).toHaveTextContent('Logo principal removido.');
    expect({
      deletes: ofMethod(requests, 'DELETE', 'primary').length,
      puts: ofMethod(requests, 'PUT', 'primary').length,
    }).toEqual({ deletes: 2, puts: 1 });
  });

  it('durante a saída da confirmação do principal, o espaço secundário envia normalmente', async () => {
    const deletes = controlDeletes('primary');
    const requests = recordLogoRequests();
    const { user } = await openLogos();
    const dialog = await openRemove(user);
    const { open } = deletes.hold();
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await waitFor(() => {
      expect(ofMethod(requests, 'DELETE', 'primary')).toHaveLength(1);
    });
    const exit = holdExitTransitions();
    open();
    expect(await within(slotRegion('primary')).findByRole('status')).toHaveTextContent(
      'Logo principal removido.',
    );
    expect(screen.getByRole('dialog', { name: TITLE })).toBeInTheDocument();

    await user.upload(fileInput('secondary'), imageFile(PNG_BYTES, 'logo.png', 'image/png'));
    expect(await within(slotRegion('secondary')).findByRole('status')).toHaveTextContent(
      'Logo secundário salvo.',
    );
    exit.release();
    await dialogGone();
    expect({
      primaryDeletes: ofMethod(requests, 'DELETE', 'primary').length,
      secondaryPuts: ofMethod(requests, 'PUT', 'secondary').length,
    }).toEqual({ primaryDeletes: 1, secondaryPuts: 1 });
  });

  it('remoção recusada (503) e "Cancelar": o espaço envia um arquivo e a confirmação abre de novo', async () => {
    const deletes = controlDeletes('primary');
    deletes.answers = ['503'];
    const requests = recordLogoRequests();
    const { user } = await openLogos();
    const dialog = await openRemove(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Sistema ocupado no momento.',
    );
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeEnabled();
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await dialogGone();
    expect(slotButton('primary', 'Remover')).toHaveFocus();

    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    expect(await within(slotRegion('primary')).findByRole('status')).toHaveTextContent(
      'Logo principal salvo.',
    );
    await waitFor(() => {
      expect(slotButton('primary', 'Remover')).toBeEnabled();
    });
    await openRemove(user);
    expect(ofMethod(requests, 'PUT', 'primary')).toHaveLength(1);
  });

  it('"Carregar" durante a saída não abre o seletor; depois do fechamento abre', async () => {
    const deletes = controlDeletes('primary');
    const { user } = await openLogos();
    const dialog = await openRemove(user);
    const { open } = deletes.hold();
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    const exit = holdExitTransitions();
    open();
    expect(await within(slotRegion('primary')).findByRole('status')).toHaveTextContent(
      'Logo principal removido.',
    );
    const picker = vi.spyOn(fileInput('primary'), 'click').mockImplementation(() => undefined);

    slotButton('primary', 'Carregar').click();
    expect(picker).not.toHaveBeenCalled();
    exit.release();
    await dialogGone();
    await user.click(slotButton('primary', 'Carregar'));
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('no celular (tela cheia): Enter durante a saída não remove de novo e o foco vai ao "Carregar"', async () => {
    setViewportWidth(375);
    const deletes = controlDeletes('primary');
    const requests = recordLogoRequests();
    const { user } = await openLogos();
    const dialog = await openRemove(user);
    const confirm = within(dialog).getByRole('button', { name: 'Remover' });
    const { open } = deletes.hold();
    await user.click(confirm);
    await waitFor(() => {
      expect(ofMethod(requests, 'DELETE', 'primary')).toHaveLength(1);
    });
    const exit = holdExitTransitions();
    open();
    expect(await within(slotRegion('primary')).findByRole('status')).toHaveTextContent(
      'Logo principal removido.',
    );

    confirm.focus();
    await user.keyboard('{Enter}');
    exit.release();
    await dialogGone();
    expect(ofMethod(requests, 'DELETE', 'primary')).toHaveLength(1);
    expect(slotButton('primary', 'Carregar')).toHaveFocus();
  });
});
