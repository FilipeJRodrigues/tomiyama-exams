/**
 * Erro: o logo é salvo (PUT 200) e a releitura falha (503). O slot mostra o erro com "Tentar
 * de novo", como decidido. Mas, se a pessoa sai da tela Academia e volta enquanto a leitura
 * ainda falha, o slot volta a mostrar a prévia ANTIGA com "Trocar"/"Remover", sem erro nem
 * "Tentar de novo", como se fosse o logo do slot. O estado "salvo mas não relido" (`outdated`
 * em `LogoSlotPanel`) vive só no componente, e o cache do `useLogo` continua com o logo antigo.
 * Esperado: enquanto nenhuma leitura trouxer o logo enviado, o slot não mostra o logo antigo
 * como atual, nem depois de sair e voltar: mostra o erro de leitura com "Tentar de novo", que
 * relê e mostra o logo enviado (decisão do responsável de 2026-11-04; decisão 4 do card).
 * Issue: #26
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { ROUTE } from '../features/academy/helpers';
import {
  JPEG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  logoView,
  slotRegion,
} from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const ALT = 'Logo principal da academia';
const OLD_URL = 'https://imagens.test/logos/primary?v=antigo';
const NEW_URL = 'https://imagens.test/logos/primary?v=novo';

let stored: string;
let readFails: boolean;

beforeEach(() => {
  stored = OLD_URL;
  readFails = false;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  server.use(
    http.get(logoUrl('primary'), () =>
      readFails
        ? HttpResponse.json({ message: BUSY }, { status: 503 })
        : HttpResponse.json(logoView('primary', stored)),
    ),
    // The PUT is stored (200 from the mock); from then on the read fails.
    http.put(logoUrl('primary'), () => {
      stored = NEW_URL;
      readFails = true;
      return undefined;
    }),
  );
});

function shownSrc(): string | null {
  return (
    within(slotRegion('primary')).queryByRole('img', { name: ALT })?.getAttribute('src') ?? null
  );
}

it('ao voltar à tela com a leitura ainda falhando, o slot não mostra o logo antigo', async () => {
  const { user, router } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
  await screen.findByRole('img', { name: ALT });
  await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
  await within(slotRegion('primary')).findByRole('button', { name: 'Tentar de novo' });

  await router.navigate('/alunos');
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Logo principal' })).not.toBeInTheDocument();
  });
  await router.navigate(ROUTE);
  await screen.findByRole('region', { name: 'Logo principal' });

  await waitFor(() => {
    expect(shownSrc()).not.toBe(OLD_URL);
    expect(
      within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
    ).toBeEnabled();
  });

  readFails = false;
  await user.click(within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }));

  await waitFor(() => {
    expect(shownSrc()).toBe(NEW_URL);
  });
});
