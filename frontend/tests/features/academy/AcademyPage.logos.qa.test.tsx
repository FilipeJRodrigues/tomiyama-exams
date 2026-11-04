/**
 * Academy logos (§ 6.6, RN012), cases added by the qa-frontend: the guardian never reaches the
 * logo routes, `Esc` on the removal (ignored while the DELETE is on its way, closes it
 * otherwise, with the focus back on the slot) and a 504 on the upload (outcome unknown).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { gate, openAcademy } from './helpers';
import {
  PNG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  mockLogo,
  ofMethod,
  recordLogoRequests,
  slotButton,
  slotRegion,
} from './logoHelpers';

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
});
