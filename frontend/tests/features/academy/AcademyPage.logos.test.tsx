/**
 * Academy screen (§ 6.6), the "Logos" section (RN012): the two slots loaded on their own (a
 * logo, none = 404, an error), sending and replacing, the file refused before any request
 * (type, over 2 MB), the API refusals (400, 413, 503) and the unknown outcome, the removal
 * with confirmation, one request per action, the expired URL read again and the slots
 * independent of each other.
 *
 * The state while a request is on its way is checked with the response held (`gate`), never
 * with a delay. jsdom does not load images: the load and the error of the preview are fired.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LogoSlot } from '../../../src/api/types';
import { MOCK_USER_IDS } from '../../../src/auth/mockConstants';
import { createMockDb, type MockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { setViewportWidth } from '../../viewport';
import { ROUTE, gate, openAcademy } from './helpers';
import {
  GIF_BYTES,
  JPEG_BYTES,
  PNG_BYTES,
  base64Of,
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

const INVALID = 'Envie PNG ou JPEG de até 2 MB';
const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const PRIMARY_ALT = 'Logo principal da academia';

let db: MockDb;

function png(name = 'logo.png') {
  return imageFile(PNG_BYTES, name, 'image/png');
}

function jpeg(name = 'logo.jpg') {
  return imageFile(JPEG_BYTES, name, 'image/jpeg');
}

/** Opens the screen and waits until both slots are loaded. */
async function openLogos(profile: 'examiner' | 'master' = 'examiner') {
  const result = await openAcademy(profile);
  await waitFor(() => {
    expect(screen.queryByText('Carregando logo…')).not.toBeInTheDocument();
  });
  return result;
}

function preview(slot: LogoSlot) {
  return within(slotRegion(slot)).queryByRole('img');
}

/**
 * A choice that the file picker would hide (`accept`): the user picked "Todos os arquivos".
 * Like `user.upload`, it does nothing on a disabled input.
 */
async function chooseAnyFile(slot: LogoSlot, file: File) {
  await userEvent.setup({ delay: null, applyAccept: false }).upload(fileInput(slot), file);
}

describe('academy logos, loading (§ 6.6)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('shows the section below the academy data, with a slot for each logo', async () => {
    await openLogos();

    const headings = within(screen.getByRole('main'))
      .getAllByRole('heading')
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Academia',
      'Dados da academia',
      'Logos',
      'Logo principal',
      'Logo secundário',
    ]);
    expect(screen.getByRole('region', { name: 'Logos' })).toBeVisible();
  });

  it('a stored logo has its preview, type and size, "Trocar" and "Remover"', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    await openLogos();

    const image = within(slotRegion('primary')).getByRole('img', { name: PRIMARY_ALT });
    expect(image).toHaveAttribute('src', `data:image/png;base64,${base64Of(PNG_BYTES)}`);
    expect(slotRegion('primary')).toHaveTextContent('PNG, 1 KB');
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
    expect(slotButton('primary', 'Remover')).toBeEnabled();
  });

  it('a slot without a logo (404) shows "Nenhum logo" and only "Carregar", not an error', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    await openLogos();

    const secondary = slotRegion('secondary');
    expect(secondary).toHaveTextContent('Nenhum logo');
    expect(preview('secondary')).not.toBeInTheDocument();
    expect(slotButton('secondary', 'Carregar')).toBeEnabled();
    expect(within(secondary).queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows "Carregando logo…" in the slot until its logo arrives', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    const held = gate();
    server.use(
      http.get(logoUrl('primary'), async () => {
        await held.wait;
        return undefined;
      }),
    );
    await openAcademy();

    expect(within(slotRegion('primary')).getByText('Carregando logo…')).toBeVisible();
    await waitFor(() => {
      expect(slotRegion('secondary')).toHaveTextContent('Nenhum logo');
    });
    expect(within(slotRegion('primary')).queryByRole('button')).not.toBeInTheDocument();

    held.release();
    expect(
      await within(slotRegion('primary')).findByRole('img', { name: PRIMARY_ALT }),
    ).toBeInTheDocument();
  });

  it('a load error stays in its slot, with "Tentar de novo" that reads it again', async () => {
    let fail = true;
    server.use(
      http.get(logoUrl('secondary'), () =>
        fail ? HttpResponse.json({ message: BUSY }, { status: 503 }) : undefined,
      ),
    );
    const { user } = await openAcademy();

    const secondary = slotRegion('secondary');
    const alert = await within(secondary).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível carregar o logo secundário');
    expect(alert).toHaveTextContent(BUSY);
    expect(slotButton('primary', 'Carregar')).toBeEnabled();

    fail = false;
    await user.click(within(secondary).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(slotRegion('secondary')).findByText('Nenhum logo')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 403 on the read shows "Sem permissão" without "Tentar de novo"', async () => {
    server.use(
      http.get(logoUrl('primary'), () =>
        HttpResponse.json({ message: 'Esta área é dos examinadores' }, { status: 403 }),
      ),
    );
    await openAcademy();

    const alert = await within(slotRegion('primary')).findByRole('alert');
    expect(alert).toHaveTextContent('Sem permissão');
    expect(alert).toHaveTextContent('Esta área é dos examinadores');
    expect(
      within(slotRegion('primary')).queryByRole('button', { name: 'Tentar de novo' }),
    ).not.toBeInTheDocument();
  });

  it('the file input has a name and is reached with the keyboard through "Carregar"', async () => {
    const { user } = await openLogos();

    const input = fileInput('primary');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg');
    let opened = 0;
    input.addEventListener('click', () => {
      opened += 1;
    });

    slotButton('primary', 'Carregar').focus();
    await user.keyboard('{Enter}');
    expect(opened).toBe(1);
    await user.tab();
    expect(slotButton('secondary', 'Carregar')).toHaveFocus();
  });
});

describe('academy logos, sending (RN012)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('rn012 sends a PNG: base64 without prefix, the preview, the notice and the focus kept', async () => {
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    await user.upload(fileInput('primary'), png());

    const notice = await within(slotRegion('primary')).findByRole('status');
    expect(notice).toHaveTextContent('Logo principal salvo.');
    expect(ofMethod(requests, 'PUT')).toEqual([
      {
        method: 'PUT',
        slot: 'primary',
        body: { content_type: 'image/png', data: base64Of(PNG_BYTES) },
      },
    ]);
    expect(db.logos.primary?.updated_by).toBe(MOCK_USER_IDS.examiner);
    expect(within(slotRegion('primary')).getByRole('img', { name: PRIMARY_ALT })).toHaveAttribute(
      'src',
      `data:image/png;base64,${base64Of(PNG_BYTES)}`,
    );
    expect(slotButton('primary', 'Trocar')).toHaveFocus();
    expect(slotButton('primary', 'Remover')).toBeEnabled();
    // The other slot was not touched.
    expect(ofMethod(requests, 'PUT', 'secondary')).toEqual([]);
    expect(slotRegion('secondary')).toHaveTextContent('Nenhum logo');
  });

  it('rn012 "Trocar" replaces a stored PNG with a JPEG', async () => {
    db.logos.secondary = mockLogo(PNG_BYTES);
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    await user.upload(fileInput('secondary'), jpeg());

    expect(await within(slotRegion('secondary')).findByRole('status')).toHaveTextContent(
      'Logo secundário salvo.',
    );
    expect(ofMethod(requests, 'PUT', 'secondary')[0]?.body).toEqual({
      content_type: 'image/jpeg',
      data: base64Of(JPEG_BYTES),
    });
    expect(within(slotRegion('secondary')).getByRole('img')).toHaveAttribute(
      'src',
      `data:image/jpeg;base64,${base64Of(JPEG_BYTES)}`,
    );
    expect(slotRegion('secondary')).toHaveTextContent('JPEG, 1 KB');
  });

  it('the notice closes with its own button and the focus goes to "Trocar"', async () => {
    const { user } = await openLogos();
    await user.upload(fileInput('primary'), png());
    await within(slotRegion('primary')).findByRole('status');

    await user.click(screen.getByRole('button', { name: 'Fechar aviso do logo principal' }));

    expect(screen.queryByText('Logo principal salvo.')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(slotButton('primary', 'Trocar')).toHaveFocus();
    });
  });

  it('rn012 a GIF is refused with the RN012 message and no request', async () => {
    const requests = recordLogoRequests();
    await openLogos();

    await chooseAnyFile('primary', imageFile(GIF_BYTES, 'logo.gif', 'image/gif'));

    const alert = await within(slotRegion('primary')).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível enviar o logo');
    expect(alert).toHaveTextContent(INVALID);
    expect(ofMethod(requests, 'PUT')).toEqual([]);
    expect(slotButton('primary', 'Carregar')).toBeEnabled();
  });

  it('rn012 a file named .png that is not a PNG is refused too', async () => {
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    await user.upload(fileInput('primary'), imageFile(GIF_BYTES, 'falso.png', 'image/png'));

    expect(await within(slotRegion('primary')).findByRole('alert')).toHaveTextContent(INVALID);
    expect(ofMethod(requests, 'PUT')).toEqual([]);
  });

  it('rn012 a file over 2 MB is refused with no request, and the stored logo stays', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    await user.upload(
      fileInput('primary'),
      imageFile(PNG_BYTES, 'grande.png', 'image/png', 2 * 1024 * 1024 + 1),
    );

    expect(await within(slotRegion('primary')).findByRole('alert')).toHaveTextContent(INVALID);
    expect(ofMethod(requests, 'PUT')).toEqual([]);
    expect(within(slotRegion('primary')).getByRole('img', { name: PRIMARY_ALT })).toBeVisible();
  });

  it('a new choice clears the message of the refused file', async () => {
    const { user } = await openLogos();
    await chooseAnyFile('primary', imageFile(GIF_BYTES, 'logo.gif', 'image/gif'));
    await within(slotRegion('primary')).findByRole('alert');

    await user.upload(fileInput('primary'), png());

    expect(await within(slotRegion('primary')).findByRole('status')).toBeVisible();
    expect(within(slotRegion('primary')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [400, INVALID],
    [413, 'Corpo da requisição grande demais'],
    [503, BUSY],
  ])('shows the API message of a %i and keeps the stored logo', async (status, message) => {
    db.logos.primary = mockLogo(PNG_BYTES);
    server.use(http.put(logoUrl('primary'), () => HttpResponse.json({ message }, { status })));
    const { user } = await openLogos();

    await user.upload(fileInput('primary'), jpeg());

    const alert = await within(slotRegion('primary')).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível enviar o logo');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent('pode ter sido salvo');
    expect(within(slotRegion('primary')).getByRole('img', { name: PRIMARY_ALT })).toHaveAttribute(
      'src',
      `data:image/png;base64,${base64Of(PNG_BYTES)}`,
    );
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
    expect(screen.queryByText('Logo principal salvo.')).not.toBeInTheDocument();
  });

  it('with no answer the logo may have been saved: says so and reads the slot again', async () => {
    const requests = recordLogoRequests();
    server.use(
      http.put(logoUrl('primary'), () => {
        db.logos.primary = mockLogo(PNG_BYTES);
        return HttpResponse.error();
      }),
    );
    const { user } = await openLogos();
    const readsBefore = ofMethod(requests, 'GET', 'primary').length;

    await user.upload(fileInput('primary'), png());

    const alert = await within(slotRegion('primary')).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível confirmar o envio');
    expect(alert).toHaveTextContent(
      'O logo pode ter sido salvo. Confira a prévia e envie de novo se precisar.',
    );
    // The read again shows what was stored.
    expect(
      await within(slotRegion('primary')).findByRole('img', { name: PRIMARY_ALT }),
    ).toBeInTheDocument();
    expect(ofMethod(requests, 'GET', 'primary').length).toBeGreaterThan(readsBefore);
  });

  it('sends once: while on its way the buttons are disabled and another file is ignored', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    const held = gate();
    const requests = recordLogoRequests();
    server.use(
      http.put(logoUrl('primary'), async () => {
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openLogos();

    await user.upload(fileInput('primary'), jpeg());
    await waitFor(() => {
      expect(slotButton('primary', 'Trocar')).toBeDisabled();
    });
    expect(slotButton('primary', 'Remover')).toBeDisabled();
    expect(fileInput('primary')).toBeDisabled();
    await chooseAnyFile('primary', png('outro.png'));
    fireEvent.click(slotButton('primary', 'Trocar'));

    held.release();
    expect(await within(slotRegion('primary')).findByRole('status')).toHaveTextContent(
      'Logo principal salvo.',
    );
    expect(ofMethod(requests, 'PUT')).toHaveLength(1);
    expect(db.logos).toMatchObject({ primary: { content_type: 'image/jpeg' } });
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
  });

  it('the slots are independent: the secondary is sent while the primary is on its way', async () => {
    const held = gate();
    server.use(
      http.put(logoUrl('primary'), async () => {
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openLogos();

    await user.upload(fileInput('primary'), png());
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toBeDisabled();
    });

    expect(slotButton('secondary', 'Carregar')).toBeEnabled();
    await user.upload(fileInput('secondary'), jpeg());
    expect(await within(slotRegion('secondary')).findByRole('status')).toHaveTextContent(
      'Logo secundário salvo.',
    );
    expect(slotButton('primary', 'Carregar')).toBeDisabled();
    expect(db.logos.secondary?.content_type).toBe('image/jpeg');

    held.release();
    expect(await within(slotRegion('primary')).findByRole('status')).toHaveTextContent(
      'Logo principal salvo.',
    );
    expect(within(slotRegion('secondary')).getByRole('status')).toHaveTextContent(
      'Logo secundário salvo.',
    );
  });

  it('saving the academy data does not touch the logos', async () => {
    db.logos.primary = mockLogo(PNG_BYTES);
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('Dados da academia salvos.')).toBeVisible();
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(within(slotRegion('primary')).getByRole('img', { name: PRIMARY_ALT })).toBeVisible();
  });
});

describe('academy logos, removing (§ 6.6)', () => {
  beforeEach(() => {
    db = createMockDb();
    db.logos.primary = mockLogo(PNG_BYTES);
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('asks first, then removes: "Nenhum logo", the notice and the focus on "Carregar"', async () => {
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    expect(dialog).toHaveTextContent(
      'Remover o logo principal da academia? Esta ação não pode ser desfeita.',
    );
    expect(ofMethod(requests, 'DELETE')).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(ofMethod(requests, 'DELETE')).toEqual([
      { method: 'DELETE', slot: 'primary', body: null },
    ]);
    expect(db.logos.primary).toBeUndefined();
    expect(slotRegion('primary')).toHaveTextContent('Nenhum logo');
    expect(within(slotRegion('primary')).getByRole('status')).toHaveTextContent(
      'Logo principal removido.',
    );
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toHaveFocus();
    });
  });

  it('"Cancelar" keeps the logo, sends nothing and gives the focus back to "Remover"', async () => {
    const requests = recordLogoRequests();
    const { user } = await openLogos();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(ofMethod(requests, 'DELETE')).toEqual([]);
    expect(within(slotRegion('primary')).getByRole('img', { name: PRIMARY_ALT })).toBeVisible();
    await waitFor(() => {
      expect(slotButton('primary', 'Remover')).toHaveFocus();
    });
  });

  it('the API error stays in the dialog and the logo stays', async () => {
    server.use(
      http.delete(logoUrl('primary'), () => HttpResponse.json({ message: BUSY }, { status: 503 })),
    );
    const { user } = await openLogos();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível remover');
    expect(alert).toHaveTextContent(BUSY);
    expect(dialog).toBeInTheDocument();
  });

  it('with no answer the dialog says the logo may have been removed', async () => {
    server.use(http.delete(logoUrl('primary'), () => HttpResponse.error()));
    const { user } = await openLogos();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Não foi possível confirmar a remoção');
    expect(alert).toHaveTextContent('O logo pode ter sido removido.');
  });

  it('removes once: a second click while on its way sends nothing more', async () => {
    const held = gate();
    const requests = recordLogoRequests();
    server.use(
      http.delete(logoUrl('primary'), async () => {
        await held.wait;
        return undefined;
      }),
    );
    const { user } = await openLogos();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    const confirm = within(dialog).getByRole('button', { name: 'Remover' });
    await user.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    });
    expect(slotButton('primary', 'Trocar')).toBeDisabled();

    held.release();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(ofMethod(requests, 'DELETE')).toHaveLength(1);
  });

  it.each([1280, 768, 390])('keeps every action at %i px and removes there', async (width) => {
    setViewportWidth(width);
    const { user } = await openLogos();
    for (const button of [
      slotButton('primary', 'Trocar'),
      slotButton('primary', 'Remover'),
      slotButton('secondary', 'Carregar'),
    ]) {
      expect(button).toBeVisible();
    }

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));

    expect(await within(slotRegion('primary')).findByText('Nenhum logo')).toBeVisible();
  });
});

describe('academy logos, the URL of the preview (5 minutes)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  /** Each read answers a new pre-signed URL (`…?v=1`, `…?v=2`, …). */
  function signedUrls() {
    let reads = 0;
    server.use(
      http.get(logoUrl('primary'), () => {
        reads += 1;
        return HttpResponse.json(
          logoView('primary', `https://imagens.test/logos/primary?v=${String(reads)}`),
        );
      }),
    );
    return () => reads;
  }

  it('an image that fails to load (expired URL) is read again and shown with the new URL', async () => {
    const reads = signedUrls();
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const image = await screen.findByRole('img', { name: PRIMARY_ALT });
    expect(image).toHaveAttribute('src', 'https://imagens.test/logos/primary?v=1');

    fireEvent.error(image);

    await waitFor(() => {
      expect(screen.getByRole('img', { name: PRIMARY_ALT })).toHaveAttribute(
        'src',
        'https://imagens.test/logos/primary?v=2',
      );
    });
    expect(reads()).toBe(2);
    expect(screen.queryByText('Não foi possível mostrar o logo.')).not.toBeInTheDocument();
  });

  it('if the new URL fails too it says so, and "Tentar de novo" reads once more', async () => {
    const reads = signedUrls();
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    fireEvent.error(await screen.findByRole('img', { name: PRIMARY_ALT }));
    await waitFor(() => {
      expect(screen.getByRole('img', { name: PRIMARY_ALT })).toHaveAttribute(
        'src',
        'https://imagens.test/logos/primary?v=2',
      );
    });

    fireEvent.error(screen.getByRole('img', { name: PRIMARY_ALT }));

    const region = slotRegion('primary');
    expect(await within(region).findByText('Não foi possível mostrar o logo.')).toBeVisible();
    expect(within(region).queryByRole('img')).not.toBeInTheDocument();
    // No loop: the second failure does not read again by itself.
    expect(reads()).toBe(2);

    await user.click(within(region).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(region).findByRole('img', { name: PRIMARY_ALT })).toHaveAttribute(
      'src',
      'https://imagens.test/logos/primary?v=3',
    );
    expect(reads()).toBe(3);
  });

  it('after an image loads, a later failure is read again by itself', async () => {
    const reads = signedUrls();
    await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    fireEvent.error(await screen.findByRole('img', { name: PRIMARY_ALT }));
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
    const second = await screen.findByRole('img', { name: PRIMARY_ALT });
    await waitFor(() => {
      expect(second).toHaveAttribute('src', 'https://imagens.test/logos/primary?v=2');
    });

    fireEvent.load(second);
    fireEvent.error(second);

    await waitFor(() => {
      expect(screen.getByRole('img', { name: PRIMARY_ALT })).toHaveAttribute(
        'src',
        'https://imagens.test/logos/primary?v=3',
      );
    });
  });
});
