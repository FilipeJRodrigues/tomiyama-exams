/**
 * Erro: a pessoa envia (ou remove) um logo, sai da tela Academia e volta ANTES de a gravação
 * terminar. A mutação continua, mas o slot novo não sabe dela: mostra a prévia ANTIGA como o
 * logo atual, sem "ocupado", com "Trocar" e "Remover" habilitados. Pelo `backend/README.md`
 * ("Ordem das gravações"), o envio grava no S3 primeiro, na mesma chave (a URL antiga já
 * entrega o arquivo novo), e a remoção apaga os metadados primeiro: a prévia pode não ser mais
 * a do slot. E, com os botões habilitados, a mesma pessoa provoca a "corrida que sobra" (um
 * `PUT` e um `DELETE` do mesmo slot ao mesmo tempo, que pode deixar metadados sem objeto).
 * É a mesma classe das reprovações anteriores do #26 (o slot mostra como atual uma prévia que
 * pode não ser mais a dele), pelo caminho da gravação ainda em andamento.
 * Esperado: enquanto uma gravação do slot está em andamento, também depois de sair e voltar, o
 * slot fica como no painel que enviou: sem prévia antiga fora do quadro ocupado (`aria-busy`)
 * e sem "Carregar"/"Trocar"/"Remover" habilitados. Quando a gravação termina, o slot mostra o
 * que ela deixou.
 * Issue: #26
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LogoMeta } from '../../src/api/types';
import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { ROUTE, gate } from '../features/academy/helpers';
import {
  JPEG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  logoView,
  slotButton,
  slotRegion,
  leaveLogoScreen,
} from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const ALT = 'Logo principal da academia';
const OLD_URL = 'https://imagens.test/logos/primary?v=antigo';
const NEW_URL = 'https://imagens.test/logos/primary?v=novo';
const ACTIONS = ['Carregar logo principal', 'Trocar logo principal', 'Remover logo principal'];

const STORED_META: LogoMeta = {
  slot: 'primary',
  content_type: 'image/jpeg',
  size: JPEG_BYTES.length,
  updated_at: '2026-11-04T12:00:00+00:00',
  updated_by: 'mock-examiner-2',
};

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

/** Enabled "Carregar"/"Trocar"/"Remover" of the primary slot. */
function enabledActions(): string[] {
  return within(slotRegion('primary'))
    .queryAllByRole('button')
    .filter((button) => !(button as HTMLButtonElement).disabled)
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter((name) => ACTIONS.includes(name));
}

/** The old logo shown as the slot's: its image outside a busy frame. */
function oldPreviewShownAsCurrent(): boolean {
  const image = within(slotRegion('primary')).queryByRole('img', { name: ALT });
  return image?.getAttribute('src') === OLD_URL && image.closest('[aria-busy="true"]') === null;
}

async function leaveAndComeBack({ router, queryClient }: Awaited<ReturnType<typeof renderApp>>) {
  await leaveLogoScreen(router, queryClient);
  await router.navigate(ROUTE);
  await screen.findByRole('region', { name: 'Logo principal' });
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

describe('gravação do logo ainda em andamento ao voltar à tela', () => {
  it('envio em andamento: o slot não mostra o logo antigo como atual nem libera as ações', async () => {
    const held = gate();
    let putArrived = false;
    server.use(
      http.put(logoUrl('primary'), async () => {
        putArrived = true;
        await held.wait;
        stored = NEW_URL;
        return HttpResponse.json(STORED_META);
      }),
    );
    const app = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const { user } = app;
    await screen.findByRole('img', { name: ALT });
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    await waitFor(() => {
      expect(putArrived).toBe(true);
    });

    await leaveAndComeBack(app);

    // The PUT is still on its way.
    expect(oldPreviewShownAsCurrent()).toBe(false);
    expect(enabledActions()).toEqual([]);

    held.release();
    await waitFor(() => {
      expect(within(slotRegion('primary')).getByRole('img', { name: ALT })).toHaveAttribute(
        'src',
        NEW_URL,
      );
      expect(slotButton('primary', 'Trocar')).toBeEnabled();
    });
  });

  it('remoção em andamento: o slot não mostra o logo antigo como atual nem libera as ações', async () => {
    const held = gate();
    let deleteArrived = false;
    server.use(
      http.delete(logoUrl('primary'), async () => {
        deleteArrived = true;
        await held.wait;
        stored = null;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const app = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const { user } = app;
    await screen.findByRole('img', { name: ALT });
    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await waitFor(() => {
      expect(deleteArrived).toBe(true);
    });

    await leaveAndComeBack(app);

    // The DELETE is still on its way.
    expect(oldPreviewShownAsCurrent()).toBe(false);
    expect(enabledActions()).toEqual([]);

    held.release();
    await waitFor(() => {
      expect(slotRegion('primary')).toHaveTextContent('Nenhum logo');
      expect(slotButton('primary', 'Carregar')).toBeEnabled();
    });
  });
});
