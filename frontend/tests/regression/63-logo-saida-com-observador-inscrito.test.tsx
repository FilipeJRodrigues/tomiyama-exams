/**
 * Erro (do teste, não da tela): `AcademyPage.logoWrites.test.tsx`, caso "opening the screen
 * again offline…", oscila sob carga: espera a marca `{ outcome: 'stored' }` e recebe `null`.
 * O `leave()` dele só espera a região "Logo principal" sumir do DOM e já libera o PUT. O
 * `useQuery` do logo só se desinscreve no efeito de limpeza do React, que pode rodar depois;
 * se o PUT é liberado antes disso, o `invalidateQueries` de `readLogoAgain` ainda vê a consulta
 * ativa, relê o slot e a releitura (que deu certo) apaga a marca. A tela está certa nesse caso:
 * a releitura trouxe o logo novo. O que falta é o teste garantir a ordem que ele supõe.
 * Esperado: os testes do logo que saem da tela antes de liberar uma gravação usam uma saída
 * compartilhada, `leaveLogoScreen(router, queryClient)` em `tests/features/academy/logoHelpers.ts`,
 * que só termina quando a região saiu e a consulta do logo ficou sem observadores. Com ela, o
 * caso dá a marca `stored` mesmo quando a desinscrição chega tarde.
 * Issue: #63
 *
 * A desinscrição tardia é forçada pelo teste, sem espera real: a remoção do observador da
 * consulta do logo fica para três voltas do laço depois de pedida. Com o `leave()` de hoje
 * (só a região), esse arranjo dá `null`, como sob carga.
 */
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryKeys } from '../../src/api/queries';
import type { LogoMeta } from '../../src/api/types';
import { AppProviders } from '../../src/app/AppProviders';
import { createQueryClient } from '../../src/app/queryClient';
import { createRoutes } from '../../src/app/routes';
import { createMockAuth } from '../../src/auth/mockAuth';
import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { ROUTE, gate } from '../features/academy/helpers';
import * as logoHelpers from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';

const { JPEG_BYTES, fileInput, imageFile, logoUrl, logoView } = logoHelpers;

type Router = ReturnType<typeof createMemoryRouter>;
type LeaveLogoScreen = (router: Router, queryClient: QueryClient) => Promise<void>;

const ALT = 'Logo principal da academia';
const OLD_URL = 'https://imagens.test/logos/primary?v=antigo';
const NEW_URL = 'https://imagens.test/logos/primary?v=novo';
const STORED_META: LogoMeta = {
  slot: 'primary',
  content_type: 'image/jpeg',
  size: JPEG_BYTES.length,
  updated_at: '2026-11-04T12:00:00+00:00',
  updated_by: 'mock-examiner-2',
};

let stored: string;

beforeEach(() => {
  stored = OLD_URL;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  server.use(http.get(logoUrl('primary'), () => HttpResponse.json(logoView('primary', stored))));
});

afterEach(() => {
  onlineManager.setOnline(true);
});

/** The shared way out of the logo screen; fails clearly while it does not exist. */
function leaveLogoScreen(): LeaveLogoScreen {
  const helper = (logoHelpers as Record<string, unknown>).leaveLogoScreen;
  if (typeof helper !== 'function') {
    throw new Error(
      'tests/features/academy/logoHelpers.ts deveria exportar leaveLogoScreen(router, queryClient): ' +
        'sair da tela do logo esperando a região sumir e a consulta do logo ficar sem observadores.',
    );
  }
  return helper as LeaveLogoScreen;
}

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

/**
 * The screen's `useQuery` of the logo lets go of the query late, as when React runs the
 * cleanup effects after the next turns of the loop (machine under load).
 */
function unsubscribeLate(queryClient: QueryClient) {
  const query = queryClient
    .getQueryCache()
    .find({ queryKey: queryKeys.logo('primary'), exact: true });
  if (query === undefined) throw new Error('A consulta do logo principal deveria existir.');
  const remove = query.removeObserver.bind(query);
  query.removeObserver = (observer) => {
    let turns = 3;
    const next = () => {
      turns -= 1;
      if (turns > 0) setTimeout(next, 0);
      else remove(observer);
    };
    setTimeout(next, 0);
  };
  return query;
}

describe('leaving the logo screen before a held write ends (#63)', () => {
  it('the shared exit waits for the logo query to have no observers', async () => {
    const leave = leaveLogoScreen();
    const { queryClient, router } = await openScreen();
    const query = unsubscribeLate(queryClient);

    await leave(router, queryClient);

    expect(screen.queryByRole('region', { name: 'Logo principal' })).not.toBeInTheDocument();
    expect(query.getObserversCount()).toBe(0);
  });

  it('with the shared exit, a PUT released after leaving leaves the mark "stored"', async () => {
    const leave = leaveLogoScreen();
    const held = gate();
    let arrived = false;
    server.use(
      http.put(logoUrl('primary'), async () => {
        arrived = true;
        await held.wait;
        stored = NEW_URL;
        return HttpResponse.json(STORED_META);
      }),
    );
    const { user, queryClient, router } = await openScreen();
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await waitFor(() => {
      expect(arrived).toBe(true);
    });
    unsubscribeLate(queryClient);

    await leave(router, queryClient);
    held.release();
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });

    // Nothing read the slot after the write: the mark is on.
    expect(queryClient.getQueryData(queryKeys.logoChange('primary'))).toEqual({
      outcome: 'stored',
    });
  });
});
