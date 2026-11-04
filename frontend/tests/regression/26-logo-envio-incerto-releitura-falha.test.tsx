/**
 * Erro: o `PUT /settings/logos/{slot}` falha sem resposta (rede), com 504 ou com 503. A tela
 * relê o slot porque o logo pode ter mudado mesmo assim (`backend/README.md`, "Ordem das
 * gravações": o arquivo novo pode já estar no S3, sob a mesma chave). Quando essa releitura
 * também falha (503), o slot continua com a prévia ANTIGA (ou "Nenhum logo") e "Trocar"/
 * "Remover", como se fosse o estado atual, sem erro de leitura nem "Tentar de novo". Com rede
 * ou 504, o aviso ainda pede "Confira a prévia", que não foi relida. É o mesmo erro de
 * `26-logo-salvo-com-releitura-falha.test.tsx` por outro caminho (decisão 4 do card: a tela
 * não mostra como do slot um logo que pode não ser mais o dele).
 * Esperado: como na decisão do responsável de 2026-11-04 para o logo salvo sem releitura, o
 * slot mostra o erro de leitura com "Tentar de novo", sem a prévia antiga nem "Nenhum logo";
 * o foco continua no slot (§ 6.7); "Tentar de novo" relê e mostra o que o slot tem.
 * (Slot vazio com 503: pelo README os metadados não foram gravados e o `GET` responde 404,
 * então "Nenhum logo" é o estado do slot; esse caso fica de fora.)
 * Issue: #26
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

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

type Answer = () => Response;

const NO_ANSWER: [string, Answer] = ['sem resposta (rede)', () => HttpResponse.error()];
const TIMEOUT: [string, Answer] = [
  '504',
  () => HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 }),
];
const SERVER_ERROR: [string, Answer] = [
  '503',
  () => HttpResponse.json({ message: BUSY }, { status: 503 }),
];

/** What the slot has in the simulated API: the URL of its logo, or `null` (404). */
let stored: string | null;
let readFails: boolean;
let puts: number;

beforeEach(() => {
  stored = null;
  readFails = false;
  puts = 0;
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

/** The PUT stores the new logo but answers `answer`; from then on the read fails. */
async function sendWithUnknownOutcome(answer: Answer) {
  server.use(
    http.put(logoUrl('primary'), () => {
      puts += 1;
      stored = NEW_URL;
      readFails = true;
      return answer();
    }),
  );
  const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
  await screen.findByRole('region', { name: 'Logo principal' });
  await waitFor(() => {
    expect(within(slotRegion('primary')).queryByText('Carregando logo…')).not.toBeInTheDocument();
  });

  await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
  await waitFor(() => {
    expect(puts).toBe(1);
  });
  return user;
}

function shownSrc(): string | null {
  return (
    within(slotRegion('primary')).queryByRole('img', { name: ALT })?.getAttribute('src') ?? null
  );
}

async function expectFocusInSlot() {
  await waitFor(() => {
    expect(document.activeElement).not.toBe(document.body);
    expect(slotRegion('primary')).toContainElement(document.activeElement as HTMLElement);
  });
}

describe('PUT do logo sem resultado certo, releitura com 503', () => {
  it.each([NO_ANSWER, TIMEOUT, SERVER_ERROR])(
    'slot com logo, %s: não mostra a prévia antiga; oferece "Tentar de novo"',
    async (_, answer) => {
      stored = OLD_URL;
      const user = await sendWithUnknownOutcome(answer);

      await waitFor(() => {
        expect(shownSrc()).not.toBe(OLD_URL);
        expect(
          within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
        ).toBeEnabled();
      });
      await expectFocusInSlot();

      readFails = false;
      await user.click(
        within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
      );

      await waitFor(() => {
        expect(shownSrc()).toBe(NEW_URL);
      });
    },
  );

  it.each([NO_ANSWER, TIMEOUT])(
    'slot vazio, %s: não mostra "Nenhum logo"; oferece "Tentar de novo"',
    async (_, answer) => {
      const user = await sendWithUnknownOutcome(answer);

      await waitFor(() => {
        expect(slotRegion('primary')).not.toHaveTextContent('Nenhum logo');
        expect(
          within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
        ).toBeEnabled();
      });
      await expectFocusInSlot();

      readFails = false;
      await user.click(
        within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
      );

      await waitFor(() => {
        expect(shownSrc()).toBe(NEW_URL);
      });
    },
  );
});
