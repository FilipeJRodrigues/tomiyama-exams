/**
 * Academy logos (§ 6.6, § 6.7, RN012): a write of the slot that goes on after leaving the
 * screen (`useLogoWrites`). The panel opened while it is on its way takes it over: busy and with
 * no action until it ends (regression `26-logo-gravacao-em-andamento-volta-a-tela`), then what
 * it left, with its "salvo"/"removido" or its error, and the focus back in the slot when lost.
 * Also the read paused while the browser is offline, with the slot's mark on: it is the read
 * error with "Tentar de novo" (regression `26-logo-rede-cai-releitura-pausada`), also when the
 * screen opens again offline.
 *
 * Requests on their way are held (`gate`), never delayed.
 */
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryKeys } from '../../../src/api/queries';
import type { LogoMeta } from '../../../src/api/types';
import { AppProviders } from '../../../src/app/AppProviders';
import { createQueryClient } from '../../../src/app/queryClient';
import { createRoutes } from '../../../src/app/routes';
import { createMockAuth } from '../../../src/auth/mockAuth';
import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { ROUTE, gate } from './helpers';
import {
  JPEG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  logoView,
  slotButton,
  slotRegion,
} from './logoHelpers';

const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const INVALID = 'Envie PNG ou JPEG de até 2 MB';
const OFFLINE = 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';
const ALT = 'Logo principal da academia';
const OLD_URL = 'https://imagens.test/logos/primary?v=antigo';
const NEW_URL = 'https://imagens.test/logos/primary?v=novo';
const UNCHECKED_SEND =
  'O logo pode ter sido salvo, mas a prévia não carregou. Tente carregar de novo para conferir e envie de novo se precisar.';
const UNCHECKED_REMOVAL =
  'O logo pode ter sido removido, mas a prévia não carregou. Tente carregar de novo para conferir e remova de novo se precisar.';

const STORED_META: LogoMeta = {
  slot: 'primary',
  content_type: 'image/jpeg',
  size: JPEG_BYTES.length,
  updated_at: '2026-11-04T12:00:00+00:00',
  updated_by: 'mock-examiner-2',
};

/** What the slot has in the simulated API: the URL of its logo, or `null` (404). */
let stored: string | null;
let readFails: boolean;

beforeEach(() => {
  stored = OLD_URL;
  readFails = false;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  server.use(
    http.get(logoUrl('primary'), () => {
      if (readFails) return HttpResponse.json({ message: BUSY }, { status: 503 });
      if (stored === null) {
        return HttpResponse.json({ message: 'Logo não encontrado' }, { status: 404 });
      }
      return HttpResponse.json(logoView('primary', stored));
    }),
  );
});

afterEach(() => {
  onlineManager.setOnline(true);
});

/** The screen with a query cache the test can look into (the writes and the mark live there). */
async function openScreen() {
  const auth = createMockAuth(window.sessionStorage);
  await auth.signIn({ email: 'examiner@example.com', password: 'senha-teste', role: 'examiner' });
  const queryClient: QueryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: true } });
  const router = createMemoryRouter(createRoutes({ useMocks: true }), { initialEntries: [ROUTE] });
  const user = userEvent.setup({ delay: null });
  render(
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  await screen.findByRole('img', { name: ALT });
  return { user, queryClient, router };
}

function shownSrc(): string | null {
  return (
    within(slotRegion('primary')).queryByRole('img', { name: ALT })?.getAttribute('src') ?? null
  );
}

async function nextTurn() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

async function leave(router: ReturnType<typeof createMemoryRouter>) {
  await router.navigate('/alunos');
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Logo principal' })).not.toBeInTheDocument();
  });
}

async function comeBack(router: ReturnType<typeof createMemoryRouter>) {
  await router.navigate(ROUTE);
  await screen.findByRole('region', { name: 'Logo principal' });
  await nextTurn();
}

/** A send held on its way; `answer` is what the API does once released. */
function holdPut(answer: () => Response) {
  const held = gate();
  let arrived = false;
  server.use(
    http.put(logoUrl('primary'), async () => {
      arrived = true;
      await held.wait;
      return answer();
    }),
  );
  return { release: held.release, arrived: () => arrived };
}

function holdDelete(answer: () => Response) {
  const held = gate();
  let arrived = false;
  server.use(
    http.delete(logoUrl('primary'), async () => {
      arrived = true;
      await held.wait;
      return answer();
    }),
  );
  return { release: held.release, arrived: () => arrived };
}

async function sendAndComeBack(
  put: ReturnType<typeof holdPut>,
  user: ReturnType<typeof userEvent.setup>,
  router: ReturnType<typeof createMemoryRouter>,
) {
  await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
  await waitFor(() => {
    expect(put.arrived()).toBe(true);
  });
  await leave(router);
  await comeBack(router);
  expect(slotButton('primary', 'Trocar')).toBeDisabled();
}

async function removeAndComeBack(
  del: ReturnType<typeof holdDelete>,
  user: ReturnType<typeof userEvent.setup>,
  router: ReturnType<typeof createMemoryRouter>,
) {
  await user.click(slotButton('primary', 'Remover'));
  const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
  await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
  await waitFor(() => {
    expect(del.arrived()).toBe(true);
  });
  await leave(router);
  await comeBack(router);
  expect(slotButton('primary', 'Remover')).toBeDisabled();
}

describe('a send taken over by the panel opened again', () => {
  it('works: the slot shows the logo sent, says "salvo" and the lost focus goes to "Trocar"', async () => {
    const put = holdPut(() => {
      stored = NEW_URL;
      return HttpResponse.json(STORED_META);
    });
    const { user, router } = await openScreen();
    await sendAndComeBack(put, user, router);
    expect(document.activeElement).toBe(document.body);

    put.release();
    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    expect(within(slotRegion('primary')).getByRole('status')).toHaveTextContent(
      'Logo principal salvo.',
    );
    await waitFor(() => {
      expect(slotButton('primary', 'Trocar')).toHaveFocus();
    });
  });

  it('a focus put elsewhere stays there when the send ends', async () => {
    const put = holdPut(() => {
      stored = NEW_URL;
      return HttpResponse.json(STORED_META);
    });
    const { user, router } = await openScreen();
    await sendAndComeBack(put, user, router);
    const title = screen.getByRole('heading', { level: 1, name: 'Academia' });
    title.focus();

    put.release();
    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    await nextTurn();
    expect(title).toHaveFocus();
  });

  it('is refused: the slot shows the API message over the logo it still has; a new send clears it', async () => {
    const put = holdPut(() => HttpResponse.json({ message: INVALID }, { status: 400 }));
    const { user, router } = await openScreen();
    await sendAndComeBack(put, user, router);

    put.release();
    const region = slotRegion('primary');
    const alert = await within(region).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível enviar o logo');
    expect(alert).toHaveTextContent(INVALID);
    expect(shownSrc()).toBe(OLD_URL);
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
    expect(within(region).queryByRole('status')).not.toBeInTheDocument();

    server.use(
      http.put(logoUrl('primary'), () => {
        stored = NEW_URL;
        return HttpResponse.json(STORED_META);
      }),
    );
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(region).getByRole('status')).toHaveTextContent('Logo principal salvo.');
  });

  it('ends with no answer and the read fails: the slot says to load again and the focus goes to "Tentar de novo"', async () => {
    const put = holdPut(() => {
      stored = NEW_URL;
      readFails = true;
      return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
    });
    const { user, queryClient, router } = await openScreen();
    await sendAndComeBack(put, user, router);

    put.release();
    const region = slotRegion('primary');
    const alert = await within(region).findByText('Não foi possível confirmar o envio');
    expect(alert.closest('[role="alert"]')).toHaveTextContent(UNCHECKED_SEND);
    const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });
    await waitFor(() => {
      expect(retry).toHaveFocus();
    });
    expect(shownSrc()).toBeNull();
    expect(queryClient.getQueryData(queryKeys.logoChange('primary'))).toEqual({
      outcome: 'unknown',
    });
  });

  it('that ended before the screen opened again shows no error: only writes seen on their way are taken over', async () => {
    const put = holdPut(() => HttpResponse.json({ message: INVALID }, { status: 400 }));
    const { user, queryClient, router } = await openScreen();
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await waitFor(() => {
      expect(put.arrived()).toBe(true);
    });
    await leave(router);
    put.release();
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    await comeBack(router);
    await waitFor(() => {
      expect(shownSrc()).toBe(OLD_URL);
    });
    expect(within(slotRegion('primary')).queryByRole('alert')).not.toBeInTheDocument();
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
  });
});

describe('a removal taken over by the panel opened again', () => {
  it('works: "Nenhum logo", "removido" and the lost focus goes to "Carregar"', async () => {
    const del = holdDelete(() => {
      stored = null;
      return new HttpResponse(null, { status: 204 });
    });
    const { user, router } = await openScreen();
    await removeAndComeBack(del, user, router);

    del.release();
    await waitFor(() => {
      expect(slotRegion('primary')).toHaveTextContent('Nenhum logo');
    });
    expect(within(slotRegion('primary')).getByRole('status')).toHaveTextContent(
      'Logo principal removido.',
    );
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toHaveFocus();
    });
  });

  it('ends with no answer and the read fails: no old preview nor "Nenhum logo", the hint and "Tentar de novo"', async () => {
    const del = holdDelete(() => {
      stored = null;
      readFails = true;
      return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
    });
    const { user, router } = await openScreen();
    await removeAndComeBack(del, user, router);

    del.release();
    const region = slotRegion('primary');
    const title = await within(region).findByText('Não foi possível confirmar a remoção');
    expect(title.closest('[role="alert"]')).toHaveTextContent(UNCHECKED_REMOVAL);
    const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });
    await waitFor(() => {
      expect(retry).toHaveFocus();
    });
    expect(shownSrc()).toBeNull();
    expect(region).not.toHaveTextContent('Nenhum logo');

    readFails = false;
    await user.click(retry);
    await waitFor(() => {
      expect(region).toHaveTextContent('Nenhum logo');
    });
  });

  it('is refused: the API message over the logo the slot still has', async () => {
    const del = holdDelete(() =>
      HttpResponse.json({ message: 'Você não tem permissão para esta ação.' }, { status: 403 }),
    );
    const { user, router } = await openScreen();
    await removeAndComeBack(del, user, router);

    del.release();
    const alert = await within(slotRegion('primary')).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Você não tem permissão para esta ação.');
    expect(shownSrc()).toBe(OLD_URL);
    expect(slotButton('primary', 'Remover')).toBeEnabled();
  });
});

describe('the slot read waiting for the network, with the mark on', () => {
  it('opening the screen again offline shows the network error with "Tentar de novo"; the read goes on when the network is back', async () => {
    const put = holdPut(() => {
      stored = NEW_URL;
      return HttpResponse.json(STORED_META);
    });
    const { user, queryClient, router } = await openScreen();
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await waitFor(() => {
      expect(put.arrived()).toBe(true);
    });
    await leave(router);
    put.release();
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
    // Nothing read the slot after the write: the mark is on.
    expect(queryClient.getQueryData(queryKeys.logoChange('primary'))).toEqual({
      outcome: 'stored',
    });

    act(() => {
      onlineManager.setOnline(false);
    });
    await comeBack(router);
    const region = slotRegion('primary');
    const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });
    expect(retry).toBeEnabled();
    expect(region).toHaveTextContent('Não foi possível carregar o logo principal');
    expect(region).toHaveTextContent(OFFLINE);
    expect(region).not.toHaveTextContent('Carregando logo…');
    expect(shownSrc()).toBeNull();

    act(() => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    expect(within(region).getByRole('status')).toHaveTextContent('Logo principal salvo.');
  });
});
