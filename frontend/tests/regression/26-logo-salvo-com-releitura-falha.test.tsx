/**
 * Erro: o `PUT /settings/logos/{slot}` responde 200, mas a releitura do slot (`GET`, que traz
 * a URL nova) falha (503). O `invalidateQueries` não rejeita, então o envio termina como
 * sucesso: a tela diz "Logo principal salvo." e, ao mesmo tempo, mostra "Nenhum logo" com
 * "Carregar" (slot que estava vazio) ou a imagem ANTIGA com "Trocar" (slot que tinha logo),
 * sem erro nem "Tentar de novo". Contraria a decisão 4 do card ("salvo" só depois que a URL
 * nova chegou) e o próprio `useUploadLogo` ("the preview never shows the old image after
 * 'salvo'").
 * Esperado: sem a URL nova, o slot não mostra a prévia antiga nem "Nenhum logo" como se fosse
 * o estado atual; mostra que não conseguiu carregar o logo, com "Tentar de novo", que relê e
 * mostra o logo enviado.
 * Issue: #26
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { openAcademy } from '../features/academy/helpers';
import {
  JPEG_BYTES,
  PNG_BYTES,
  base64Of,
  fileInput,
  imageFile,
  logoUrl,
  mockLogo,
  slotRegion,
} from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';

const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const ALT = 'Logo principal da academia';
const OLD_SRC = `data:image/png;base64,${base64Of(PNG_BYTES)}`;
const NEW_SRC = `data:image/jpeg;base64,${base64Of(JPEG_BYTES)}`;

let db: MockDb;
let readFails: boolean;

beforeEach(() => {
  db = createMockDb();
  readFails = false;
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  server.use(
    http.get(logoUrl('primary'), () =>
      readFails ? HttpResponse.json({ message: BUSY }, { status: 503 }) : undefined,
    ),
    // The PUT is stored by the mock; from then on the read fails.
    http.put(logoUrl('primary'), () => {
      readFails = true;
      return undefined;
    }),
  );
});

describe('envio salvo, releitura com 503', () => {
  it.each([
    ['vazio', false],
    ['com logo', true],
  ])(
    'slot %s: não mostra "salvo" com a prévia errada; oferece "Tentar de novo"',
    async (_, hadLogo) => {
      if (hadLogo) db.logos.primary = mockLogo(PNG_BYTES);
      const { user } = await openAcademy();
      await waitFor(() => {
        expect(screen.queryByText('Carregando logo…')).not.toBeInTheDocument();
      });

      await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));

      const region = slotRegion('primary');
      const retry = await within(region).findByRole('button', { name: 'Tentar de novo' });
      expect(db.logos.primary?.content_type).toBe('image/jpeg');
      expect(region).not.toHaveTextContent('Nenhum logo');
      const shown = within(region).queryByRole('img', { name: ALT });
      expect(shown?.getAttribute('src') ?? null).not.toBe(OLD_SRC);

      readFails = false;
      await user.click(retry);

      await waitFor(() => {
        expect(within(slotRegion('primary')).getByRole('img', { name: ALT })).toHaveAttribute(
          'src',
          NEW_SRC,
        );
      });
    },
  );
});
