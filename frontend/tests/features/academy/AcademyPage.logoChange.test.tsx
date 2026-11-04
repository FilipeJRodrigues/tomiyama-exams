/**
 * Academy logos (§ 6.6, RN012): the slot's mark "the logo may have changed" (`useLogoChange`,
 * kept in the query cache). A write that stored the logo, or may have, followed by no read that
 * worked turns it on; only a read that works (or the 204 of a removal) turns it off. While it is
 * on, the slot shows the read error (or the loading), never the old preview, "Nenhum logo",
 * "Trocar" or "Remover".
 *
 * Covered here, besides the regressions of #26: the removal with no answer, the texts of the
 * unknown outcome, the empty slot with a 503 (still empty), the unknown outcome after leaving
 * and coming back (no "salvo"), the send that ends while no screen shows the slot, and a read
 * asked before the write that answers after it.
 *
 * Requests on their way are held (`gate`), never delayed.
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

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
const ALT = 'Logo principal da academia';
const OLD_URL = 'https://imagens.test/logos/primary?v=antigo';
const NEW_URL = 'https://imagens.test/logos/primary?v=novo';
const UNCHECKED_SEND =
  'O logo pode ter sido salvo, mas a prévia não carregou. Tente carregar de novo para conferir e envie de novo se precisar.';
const CHECK_PREVIEW = 'O logo pode ter sido salvo. Confira a prévia e envie de novo se precisar.';

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
/** While set, each read of the primary slot waits for it; it answers what the slot had when asked. */
let readGate: ReturnType<typeof gate> | null;
let reads: number;
let readsAnswered: number;

beforeEach(() => {
  stored = OLD_URL;
  readFails = false;
  readGate = null;
  reads = 0;
  readsAnswered = 0;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  server.use(
    http.get(logoUrl('primary'), async () => {
      reads += 1;
      const asked = { stored, readFails };
      if (readGate) await readGate.wait;
      readsAnswered += 1;
      if (asked.readFails) return HttpResponse.json({ message: BUSY }, { status: 503 });
      if (asked.stored === null) {
        return HttpResponse.json({ message: 'Logo não encontrado' }, { status: 404 });
      }
      return HttpResponse.json(logoView('primary', asked.stored));
    }),
  );
});

/** The screen with a query cache the test can look into (the mark lives there). */
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
  await screen.findByRole('region', { name: 'Logo principal' });
  await waitFor(() => {
    expect(within(slotRegion('primary')).queryByText('Carregando logo…')).not.toBeInTheDocument();
  });
  return { user, queryClient, router };
}

function mark(queryClient: QueryClient): unknown {
  return queryClient.getQueryData(queryKeys.logoChange('primary'));
}

function shownSrc(): string | null {
  return (
    within(slotRegion('primary')).queryByRole('img', { name: ALT })?.getAttribute('src') ?? null
  );
}

function slotButtonNames(): string[] {
  return within(slotRegion('primary'))
    .queryAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent);
}

async function leaveAndWait(router: ReturnType<typeof createMemoryRouter>) {
  await router.navigate('/alunos');
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Logo principal' })).not.toBeInTheDocument();
  });
}

/** One more turn of the timer queue: TanStack notifies the screen in a `setTimeout(0)`. */
async function nextTurn() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

describe('academy logos, the mark "the logo may have changed"', () => {
  it('a removal with no answer whose read again fails: the read error, then the focus on "Tentar de novo"', async () => {
    server.use(
      http.delete(logoUrl('primary'), () => {
        stored = null;
        readFails = true;
        return HttpResponse.error();
      }),
    );
    const { user, queryClient } = await openScreen();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível confirmar a remoção');
    expect(alert).toHaveTextContent(
      'O logo pode ter sido removido, mas não foi possível conferir. Remova de novo para concluir.',
    );
    expect(alert).not.toHaveTextContent('Confira a prévia');
    expect(mark(queryClient)).toEqual({ outcome: 'unknown' });

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const region = slotRegion('primary');
    expect(within(region).getByRole('alert')).toHaveTextContent(
      'Não foi possível carregar o logo principal',
    );
    expect(shownSrc()).toBeNull();
    expect(region).not.toHaveTextContent('Nenhum logo');
    expect(slotButtonNames()).toEqual(['Tentar de novo']);
    await waitFor(() => {
      expect(within(region).getByRole('button', { name: 'Tentar de novo' })).toHaveFocus();
    });

    readFails = false;
    await user.keyboard('{Enter}');

    expect(await within(slotRegion('primary')).findByText('Nenhum logo')).toBeVisible();
    expect(within(slotRegion('primary')).queryByRole('alert')).not.toBeInTheDocument();
    expect(mark(queryClient)).toBeNull();
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toHaveFocus();
    });
  });

  it('"Remover" again in the dialog ends it: the 204 says the slot is empty', async () => {
    let deletes = 0;
    server.use(
      http.delete(logoUrl('primary'), () => {
        deletes += 1;
        stored = null;
        if (deletes === 1) {
          readFails = true;
          return HttpResponse.error();
        }
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user, queryClient } = await openScreen();
    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await within(dialog).findByRole('alert');

    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const region = slotRegion('primary');
    expect(region).toHaveTextContent('Nenhum logo');
    expect(within(region).getByRole('status')).toHaveTextContent('Logo principal removido.');
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(mark(queryClient)).toBeNull();
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toHaveFocus();
    });
    expect(deletes).toBe(2);
  });

  it('a send with no answer whose read again fails does not ask to check a preview that is not there', async () => {
    server.use(
      http.put(logoUrl('primary'), () => {
        stored = NEW_URL;
        readFails = true;
        return HttpResponse.error();
      }),
    );
    const { user, queryClient } = await openScreen();

    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));

    const region = slotRegion('primary');
    const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });
    expect(region).toHaveTextContent('Não foi possível confirmar o envio');
    expect(region).toHaveTextContent(UNCHECKED_SEND);
    expect(region).not.toHaveTextContent('Confira a prévia');
    expect(slotButtonNames()).toEqual(['Tentar de novo']);
    expect(mark(queryClient)).toEqual({ outcome: 'unknown' });

    readFails = false;
    await user.click(retry);

    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    // The outcome is still unknown: no "salvo", and now there is a preview to check.
    expect(slotRegion('primary')).toHaveTextContent(CHECK_PREVIEW);
    expect(within(slotRegion('primary')).queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(slotButton('primary', 'Trocar')).toHaveFocus();
    });
  });

  it('an empty slot with a 503 on the send stays "Nenhum logo" even when the read again fails', async () => {
    stored = null;
    server.use(
      http.put(logoUrl('primary'), () => {
        readFails = true;
        return HttpResponse.json({ message: BUSY }, { status: 503 });
      }),
    );
    const { user, queryClient } = await openScreen();
    const readsBefore = reads;

    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));

    const alert = await within(slotRegion('primary')).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível enviar o logo');
    expect(alert).toHaveTextContent(BUSY);
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toBeEnabled();
    });
    expect(slotRegion('primary')).toHaveTextContent('Nenhum logo');
    expect(slotButtonNames()).toEqual(['Carregar logo principal']);
    expect(reads).toBeGreaterThan(readsBefore);
    expect(mark(queryClient)).toBeNull();
  });

  it('the mark of an unknown outcome outlives leaving the screen; the read that works brings no "salvo"', async () => {
    server.use(
      http.put(logoUrl('primary'), () => {
        stored = NEW_URL;
        readFails = true;
        return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
      }),
    );
    const { user, router } = await openScreen();
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await within(slotRegion('primary')).findByRole('button', { name: 'Tentar de novo' });

    await leaveAndWait(router);
    await router.navigate(ROUTE);
    await screen.findByRole('region', { name: 'Logo principal' });

    await waitFor(() => {
      expect(
        within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
      ).toBeEnabled();
    });
    expect(shownSrc()).toBeNull();
    expect(slotButtonNames()).toEqual(['Tentar de novo']);

    readFails = false;
    await user.click(within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }));

    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    expect(within(slotRegion('primary')).queryByRole('status')).not.toBeInTheDocument();
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
  });

  it('a send that ends while no screen shows the slot is read on the way back, never shown with the old logo', async () => {
    const held = gate();
    server.use(
      http.put(logoUrl('primary'), async () => {
        await held.wait;
        stored = NEW_URL;
        return HttpResponse.json(STORED_META);
      }),
    );
    const { user, queryClient, router } = await openScreen();
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await waitFor(() => {
      expect(slotButton('primary', 'Trocar')).toBeDisabled();
    });

    await leaveAndWait(router);
    held.release();
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
    // Nothing read the slot after the write: the mark is on.
    expect(mark(queryClient)).toEqual({ outcome: 'stored' });

    const back = gate();
    readGate = back;
    await router.navigate(ROUTE);
    await screen.findByRole('region', { name: 'Logo principal' });
    await waitFor(() => {
      expect(within(slotRegion('primary')).getByText('Carregando logo…')).toBeVisible();
    });
    expect(shownSrc()).toBeNull();
    expect(slotButtonNames()).toEqual([]);

    back.release();
    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    expect(within(slotRegion('primary')).getByRole('status')).toHaveTextContent(
      'Logo principal salvo.',
    );
    expect(mark(queryClient)).toBeNull();
  });

  it('a read asked before the write does not turn the mark off when it answers after it', async () => {
    const putHeld = gate();
    server.use(
      http.put(logoUrl('primary'), async () => {
        await putHeld.wait;
        stored = NEW_URL;
        readFails = true;
        return HttpResponse.json(STORED_META);
      }),
    );
    const { user, queryClient, router } = await openScreen();

    // The image fails: the slot is read again, and that read is held (it answers the old logo).
    const oldRead = gate();
    readGate = oldRead;
    fireEvent.error(within(slotRegion('primary')).getByRole('img', { name: ALT }));
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    readGate = null;

    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await waitFor(() => {
      expect(slotButton('primary', 'Trocar')).toBeDisabled();
    });
    await leaveAndWait(router);
    putHeld.release();
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
    expect(mark(queryClient)).toEqual({ outcome: 'stored' });

    oldRead.release();
    await waitFor(() => {
      expect(readsAnswered).toBe(2);
    });
    await nextTurn();
    expect(mark(queryClient)).toEqual({ outcome: 'stored' });

    await router.navigate(ROUTE);
    await screen.findByRole('region', { name: 'Logo principal' });
    await waitFor(() => {
      expect(
        within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
      ).toBeEnabled();
    });
    expect(shownSrc()).toBeNull();
    expect(slotButtonNames()).toEqual(['Tentar de novo']);
  });
});
