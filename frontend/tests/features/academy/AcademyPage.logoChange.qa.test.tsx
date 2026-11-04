/**
 * Academy logos (§ 6.6, RN012), qa-frontend coverage of the slot's mark "the logo may have
 * changed" against concurrent reads: a read of the other slot, reads on window focus, no loop
 * of reads while the read keeps failing, and an image that fails while the read again of a
 * send is on its way (its own read cancels the send's read).
 *
 * Requests on their way are held (`gate`), never delayed.
 */
import type { QueryClient } from '@tanstack/react-query';
import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { JPEG_BYTES, fileInput, imageFile, logoUrl, logoView, slotRegion } from './logoHelpers';

const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const ALT = 'Logo principal da academia';
const OLD_URL = 'https://imagens.test/logos/primary?v=antigo';
const NEW_URL = 'https://imagens.test/logos/primary?v=novo';
const SECONDARY_URL = 'https://imagens.test/logos/secondary?v=1';

const STORED_META: LogoMeta = {
  slot: 'primary',
  content_type: 'image/jpeg',
  size: JPEG_BYTES.length,
  updated_at: '2026-11-04T12:00:00+00:00',
  updated_by: 'mock-examiner-2',
};

let stored: string;
let readFails: boolean;
/** While set, each read of the primary slot waits for it; it answers what the slot had when asked. */
let readGate: ReturnType<typeof gate> | null;
let reads: number;
let secondaryReads: number;

beforeEach(() => {
  stored = OLD_URL;
  readFails = false;
  readGate = null;
  reads = 0;
  secondaryReads = 0;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  server.use(
    http.get(logoUrl('primary'), async () => {
      reads += 1;
      const asked = { stored, readFails };
      if (readGate) await readGate.wait;
      if (asked.readFails) return HttpResponse.json({ message: BUSY }, { status: 503 });
      return HttpResponse.json(logoView('primary', asked.stored));
    }),
    http.get(logoUrl('secondary'), () => {
      secondaryReads += 1;
      return HttpResponse.json(logoView('secondary', SECONDARY_URL));
    }),
  );
});

afterEach(() => {
  focusManager.setFocused(undefined);
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
    expect(within(slotRegion('secondary')).queryByText('Carregando logo…')).not.toBeInTheDocument();
  });
  return { user, queryClient };
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

/** One more turn of the timer queue: TanStack notifies the screen in a `setTimeout(0)`. */
async function nextTurn() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

function windowFocusBack() {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

/** A logo stored (PUT 200) whose read again fails: the mark is on, "Tentar de novo" shown. */
async function storedWithoutRead() {
  server.use(
    http.put(logoUrl('primary'), () => {
      stored = NEW_URL;
      readFails = true;
      return HttpResponse.json(STORED_META);
    }),
  );
  const opened = await openScreen();
  await opened.user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
  await within(slotRegion('primary')).findByRole('button', { name: 'Tentar de novo' });
  expect(mark(opened.queryClient)).toEqual({ outcome: 'stored' });
  return opened;
}

describe('academy logos, the mark against concurrent reads (qa)', () => {
  it('a read of the other slot leaves the mark on', async () => {
    const { queryClient } = await storedWithoutRead();
    const before = secondaryReads;

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.logo('secondary') });
    });
    await nextTurn();

    expect(secondaryReads).toBeGreaterThan(before);
    expect(mark(queryClient)).toEqual({ outcome: 'stored' });
    expect(shownSrc()).toBeNull();
    expect(slotButtonNames()).toEqual(['Tentar de novo']);
  });

  it('a read on window focus that fails leaves the mark on; one that works shows the logo sent', async () => {
    const { queryClient } = await storedWithoutRead();
    const before = reads;

    windowFocusBack();
    await waitFor(() => {
      expect(reads).toBeGreaterThan(before);
      expect(queryClient.isFetching()).toBe(0);
    });
    await nextTurn();
    expect(mark(queryClient)).toEqual({ outcome: 'stored' });
    expect(shownSrc()).toBeNull();
    expect(slotButtonNames()).toEqual(['Tentar de novo']);

    readFails = false;
    windowFocusBack();

    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    expect(within(slotRegion('primary')).getByRole('status')).toHaveTextContent(
      'Logo principal salvo.',
    );
    expect(mark(queryClient)).toBeNull();
  });

  it('no loop of reads while the mark is on and the read keeps failing', async () => {
    await storedWithoutRead();
    const after = reads;

    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        }),
    );

    expect(reads).toBe(after);
    expect(slotButtonNames()).toEqual(['Tentar de novo']);
  });

  it('an image that fails while the read again of a send is on its way: the logo sent and "salvo"', async () => {
    server.use(
      http.put(logoUrl('primary'), () => {
        stored = NEW_URL;
        return HttpResponse.json(STORED_META);
      }),
    );
    const { user, queryClient } = await openScreen();
    const oldImage = within(slotRegion('primary')).getByRole('img', { name: ALT });
    const held = gate();
    readGate = held;

    const readsOnOpen = reads;
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    // The send's read again (after the PUT) is held.
    await waitFor(() => {
      expect(reads).toBe(readsOnOpen + 1);
    });
    // The old image fails now: the slot asks a read of its own, which cancels the send's read.
    fireEvent.error(oldImage);
    await waitFor(() => {
      expect(reads).toBe(readsOnOpen + 2);
    });
    readGate = null;
    held.release();

    await waitFor(() => {
      expect(shownSrc()).toBe(NEW_URL);
    });
    expect(within(slotRegion('primary')).getByRole('status')).toHaveTextContent(
      'Logo principal salvo.',
    );
    expect(mark(queryClient)).toBeNull();
    await waitFor(() => {
      expect(
        within(slotRegion('primary')).getByRole('button', { name: 'Trocar logo principal' }),
      ).toHaveFocus();
    });
  });
});
