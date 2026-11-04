/**
 * Erro: a rede cai no meio de uma gravação do logo (o navegador avisa `offline`). O `PUT` (ou
 * o `DELETE`) falha sem resposta e a releitura do slot fica PAUSADA, esperando a rede (modo de
 * rede padrão do TanStack Query): não falha nem termina. A marca "o logo pode ter mudado"
 * liga, e o slot fica em "Carregando logo…" sem nenhum controle, por tempo indeterminado:
 * - o aviso do envio manda "Tente carregar de novo para conferir", mas não há "Tentar de novo";
 * - o foco, que estava no botão desabilitado durante o envio (ou no diálogo de remoção, depois
 *   de fechá-lo), cai no `body` (§ 6.7).
 * Esperado (regra do responsável para a marca ligada): o erro de leitura com "Tentar de novo",
 * sem prévia antiga nem "Nenhum logo", e o foco em "Tentar de novo" quando perdido. Com a rede
 * de volta, o slot mostra o que tem.
 * Issue: #26
 */
import { onlineManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { ROUTE } from '../features/academy/helpers';
import {
  JPEG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  logoView,
  slotButton,
  slotRegion,
} from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ALT = 'Logo principal da academia';
const OLD_URL = 'https://imagens.test/logos/primary?v=antigo';
const NEW_URL = 'https://imagens.test/logos/primary?v=novo';

let stored: string | null;

beforeEach(() => {
  stored = OLD_URL;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  server.use(
    http.get(logoUrl('primary'), () =>
      stored === null
        ? HttpResponse.json({ message: 'Logo não encontrado' }, { status: 404 })
        : HttpResponse.json(logoView('primary', stored)),
    ),
  );
});

afterEach(() => {
  onlineManager.setOnline(true);
});

function shownSrc(): string | null {
  return (
    within(slotRegion('primary')).queryByRole('img', { name: ALT })?.getAttribute('src') ?? null
  );
}

/** The network is back: a paused read goes on by itself; a read error is tried again once. */
async function networkBack(user: UserEvent) {
  act(() => {
    onlineManager.setOnline(true);
  });
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
  const retry = within(slotRegion('primary')).queryByRole<HTMLButtonElement>('button', {
    name: 'Tentar de novo',
  });
  if (retry && !retry.disabled) await user.click(retry);
}

describe('rede cai no meio da gravação do logo', () => {
  it('envio: o slot oferece "Tentar de novo", que o aviso pede, e o foco vai para ele', async () => {
    server.use(
      http.put(logoUrl('primary'), () => {
        // The file reached the API; the answer is lost when the network goes away.
        stored = NEW_URL;
        onlineManager.setOnline(false);
        return HttpResponse.error();
      }),
    );
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await screen.findByRole('img', { name: ALT });
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));

    const region = slotRegion('primary');
    await within(region).findByText('Não foi possível confirmar o envio');
    expect(region).toHaveTextContent('Tente carregar de novo para conferir');
    expect(shownSrc()).toBeNull();
    expect(region).not.toHaveTextContent('Nenhum logo');

    const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });
    expect(region).not.toHaveTextContent('Carregando logo…');
    await waitFor(() => {
      expect(retry).toHaveFocus();
    });

    await networkBack(user);
    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
  });

  it('remoção: ao fechar o diálogo, o slot oferece "Tentar de novo" e o foco vai para ele', async () => {
    server.use(
      http.delete(logoUrl('primary'), () => {
        stored = null;
        onlineManager.setOnline(false);
        return HttpResponse.error();
      }),
    );
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await screen.findByRole('img', { name: ALT });
    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await within(dialog).findByText('Não foi possível confirmar a remoção');

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const region = slotRegion('primary');
    expect(shownSrc()).toBeNull();
    expect(region).not.toHaveTextContent('Nenhum logo');
    const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });
    expect(region).not.toHaveTextContent('Carregando logo…');
    await waitFor(() => {
      expect(retry).toHaveFocus();
    });

    await networkBack(user);
    await waitFor(() => {
      expect(slotRegion('primary')).toHaveTextContent('Nenhum logo');
    });
  });
});
