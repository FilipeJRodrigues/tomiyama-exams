/**
 * Erro: a imagem do logo falha (URL vencida ou objeto ausente no S3, a "corrida que sobra" do
 * `backend/README.md`), a tela relê o slot e a API devolve a MESMA URL. A URL pré-assinada só
 * muda de um segundo para outro (`X-Amz-Date`), então duas leituras no mesmo segundo trazem
 * URLs iguais. Com a URL igual, o `<img>` não é recriado nem recarregado, o navegador não
 * dispara outro `error`, e a tela fica para sempre com a imagem quebrada (só o texto
 * alternativo), sem "Não foi possível mostrar o logo." e sem "Tentar de novo".
 * Esperado: depois da única releitura, se a imagem continua sem carregar, o slot mostra
 * "Não foi possível mostrar o logo." e "Tentar de novo", sem reler em laço (decisão 1 do card).
 * Issue: #26
 *
 * O jsdom não carrega imagens: o teste imita o navegador, que só dispara `error` quando um
 * `<img>` (novo, ou com outro `src`) tenta carregar a URL morta.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { ROUTE } from '../features/academy/helpers';
import { logoUrl, logoView, slotRegion } from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ALT = 'Logo principal da academia';
const SAME_URL = 'https://imagens.test/logos/primary?X-Amz-Date=20261104T120000Z';

let reads = 0;

beforeEach(() => {
  reads = 0;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  server.use(
    http.get(logoUrl('primary'), () => {
      reads += 1;
      return HttpResponse.json(logoView('primary', SAME_URL));
    }),
  );
});

it('a releitura com a mesma URL que falhou mostra o aviso e "Tentar de novo"', async () => {
  await renderApp({ route: ROUTE, signedInAs: 'examiner' });
  const first = await screen.findByRole('img', { name: ALT });

  // Each image element tries its `src` once; the URL is dead, so every attempt fails.
  const tried = new Map<Element, string>();
  const browserLoads = () => {
    const image = within(slotRegion('primary')).queryByRole('img', { name: ALT });
    const src = image?.getAttribute('src') ?? null;
    if (image && src !== null && tried.get(image) !== src) {
      tried.set(image, src);
      fireEvent.error(image);
    }
  };
  browserLoads();
  expect(tried.has(first)).toBe(true);

  await waitFor(() => {
    browserLoads();
    expect(
      within(slotRegion('primary')).getByText('Não foi possível mostrar o logo.'),
    ).toBeVisible();
  });
  expect(
    within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
  ).toBeEnabled();
  // Read again once, not in a loop.
  expect(reads).toBe(2);
});
