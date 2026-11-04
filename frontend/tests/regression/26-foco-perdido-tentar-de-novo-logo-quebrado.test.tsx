/**
 * Erro: quando a imagem do logo não carrega nem com a URL relida, o slot mostra "Não foi
 * possível mostrar o logo." e o botão "Tentar de novo". Ao acionar esse botão (pelo teclado ou
 * pelo clique), ele some da tela no mesmo instante e o foco cai no `body`: quem usa teclado ou
 * leitor de tela volta para o topo da página.
 * Esperado: o foco fica no slot do logo, num controle que continua na tela (por exemplo,
 * "Trocar logo principal"), pela regra única de foco da tela (`focusIfLost`, § 6.7).
 * Issue: #26
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

beforeEach(() => {
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  // Each read answers a new pre-signed URL (`…?v=1`, `…?v=2`, …).
  let reads = 0;
  server.use(
    http.get(logoUrl('primary'), () => {
      reads += 1;
      return HttpResponse.json(
        logoView('primary', `https://imagens.test/logos/primary?v=${String(reads)}`),
      );
    }),
  );
});

it('o foco continua no slot depois de "Tentar de novo" da imagem que não carregou', async () => {
  const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
  fireEvent.error(await screen.findByRole('img', { name: ALT }));
  await waitFor(() => {
    expect(screen.getByRole('img', { name: ALT })).toHaveAttribute(
      'src',
      'https://imagens.test/logos/primary?v=2',
    );
  });
  fireEvent.error(screen.getByRole('img', { name: ALT }));
  const region = slotRegion('primary');
  const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });

  retry.focus();
  await user.keyboard('{Enter}');

  await waitFor(() => {
    expect(screen.getByRole('img', { name: ALT })).toHaveAttribute(
      'src',
      'https://imagens.test/logos/primary?v=3',
    );
  });
  await waitFor(() => {
    expect(document.activeElement).not.toBe(document.body);
    expect(slotRegion('primary')).toContainElement(document.activeElement as HTMLElement);
  });
});
