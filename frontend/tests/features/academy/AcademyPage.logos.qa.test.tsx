/**
 * Academy logos (§ 6.6, RN012), cases added by the qa-frontend: the guardian never reaches the
 * logo routes, `Esc` on the removal (ignored while the DELETE is on its way, closes it
 * otherwise, with the focus back on the slot), a 504 on the upload (outcome unknown), an
 * image whose read again fails too, and a logo stored but not read again whose "Tentar de
 * novo" fails once more.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { gate, openAcademy } from './helpers';
import {
  JPEG_BYTES,
  PNG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  logoView,
  mockLogo,
  ofMethod,
  recordLogoRequests,
  slotButton,
  slotRegion,
} from './logoHelpers';

const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const PRIMARY_ALT = 'Logo principal da academia';

let db: MockDb;

beforeEach(() => {
  db = createMockDb();
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
});

describe('academy logos, qa-frontend', () => {
  it('a guardian gets the notice and no logo request', async () => {
    const requests = recordLogoRequests();
    await openAcademy('guardian');

    expect(
      await screen.findByRole('heading', { name: 'Esta área é dos examinadores' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Logos' })).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('Esc closes the removal and gives the focus back; while removing it is ignored', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    const held = gate();
    const requests = recordLogoRequests();
    server.use(
      http.delete(logoUrl('primary'), async () => {
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openAcademy();
    await user.click(
      await within(slotRegion('primary')).findByRole('button', { name: 'Remover logo principal' }),
    );
    await screen.findByRole('dialog', { name: 'Remover logo principal' });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(slotButton('primary', 'Remover')).toHaveFocus();
    });
    expect(ofMethod(requests, 'DELETE')).toEqual([]);

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Remover logo principal' })).toBeInTheDocument();

    held.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toHaveFocus();
    });
    expect(ofMethod(requests, 'DELETE')).toHaveLength(1);
  });

  it('a 504 on the upload says the logo may have been saved and reads the slot again', async () => {
    const requests = recordLogoRequests();
    server.use(
      http.put(logoUrl('primary'), () => {
        db.logos.primary = mockLogo(PNG_BYTES);
        return HttpResponse.json({ message: 'Endpoint request timed out' }, { status: 504 });
      }),
    );
    const { user } = await openAcademy();
    await waitFor(() => {
      expect(screen.queryByText('Carregando logo…')).not.toBeInTheDocument();
    });
    const readsBefore = ofMethod(requests, 'GET', 'primary').length;

    await user.upload(fileInput('primary'), imageFile(PNG_BYTES, 'logo.png', 'image/png'));

    const alert = await within(slotRegion('primary')).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível confirmar o envio');
    expect(alert).toHaveTextContent('O servidor demorou para responder. Tente de novo.');
    expect(alert).toHaveTextContent('O logo pode ter sido salvo.');
    expect(
      await within(slotRegion('primary')).findByRole('img', { name: 'Logo principal da academia' }),
    ).toBeInTheDocument();
    expect(ofMethod(requests, 'GET', 'primary').length).toBeGreaterThan(readsBefore);
    expect(screen.queryByText('Logo principal salvo.')).not.toBeInTheDocument();
  });

  it('an image that fails while its read again fails (503) says so, with "Tentar de novo"', async () => {
    let reads = 0;
    let readFails = false;
    server.use(
      http.get(logoUrl('primary'), () => {
        reads += 1;
        return readFails
          ? HttpResponse.json({ message: BUSY }, { status: 503 })
          : HttpResponse.json(logoView('primary', 'https://imagens.test/logos/primary?v=1'));
      }),
    );
    await openAcademy();
    const image = await within(slotRegion('primary')).findByRole('img', { name: PRIMARY_ALT });

    readFails = true;
    fireEvent.error(image);

    await waitFor(() => {
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

  it('stored but not read again: a "Tentar de novo" that fails too keeps the error; the other slot works', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    let reads = 0;
    let readFails = false;
    server.use(
      http.get(logoUrl('primary'), () => {
        reads += 1;
        return readFails ? HttpResponse.json({ message: BUSY }, { status: 503 }) : undefined;
      }),
      http.put(logoUrl('primary'), () => {
        readFails = true;
        return undefined;
      }),
    );
    const { user } = await openAcademy();
    await within(slotRegion('primary')).findByRole('img', { name: PRIMARY_ALT });
    await user.upload(fileInput('primary'), imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg'));
    const retry = await within(slotRegion('primary')).findByRole('button', {
      name: 'Tentar de novo',
    });
    const readsBefore = reads;

    await user.click(retry);

    await waitFor(() => {
      expect(reads).toBe(readsBefore + 1);
      expect(
        within(slotRegion('primary')).getByRole('button', { name: 'Tentar de novo' }),
      ).toBeEnabled();
    });
    const region = slotRegion('primary');
    expect(within(region).getByRole('alert')).toHaveTextContent(BUSY);
    expect(within(region).queryByRole('status')).not.toBeInTheDocument();
    expect(within(region).queryByRole('img', { name: PRIMARY_ALT })).not.toBeInTheDocument();

    await user.upload(fileInput('secondary'), imageFile(PNG_BYTES, 'logo.png', 'image/png'));
    expect(await within(slotRegion('secondary')).findByRole('status')).toHaveTextContent(
      'Logo secundário salvo.',
    );
  });
});
