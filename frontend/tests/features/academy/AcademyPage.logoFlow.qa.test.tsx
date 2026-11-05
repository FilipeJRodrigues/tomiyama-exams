/**
 * Academy logos (§ 6.6, § 6.7, RN012), qa-frontend: the common flow after the writes started
 * being followed by slot (`useLogoWrites`): sending, replacing and removing in one panel, and
 * again after leaving the screen and coming back, with the ended writes still in the mutation
 * cache; a write taken over by the panel opened again, then used as usual; the other slot free
 * meanwhile. No React warning from the slot on the console along the way.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createMockDb } from '../../../src/mocks/data';
import { createHandlers } from '../../../src/mocks/handlers';
import { server, TEST_API_URL } from '../../msw-server';
import { renderApp } from '../../render';
import { ROUTE, gate } from './helpers';
import {
  JPEG_BYTES,
  PNG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  slotButton,
  slotRegion,
  leaveLogoScreen,
} from './logoHelpers';

let consoleError: MockInstance;
let consoleWarn: MockInstance;

beforeEach(() => {
  server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
  consoleError = vi.spyOn(console, 'error');
  consoleWarn = vi.spyOn(console, 'warn');
});

afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

/**
 * No React warning from the slot along the way: an update of another component while
 * rendering, a state loop, or anything naming the panel. (The `act` warnings of the app's
 * providers come from navigating in the test, not from the screen.)
 */
function expectQuietConsole() {
  const calls = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
    .map((args) => args.map(String).join(' '))
    .filter(
      (text) =>
        /Cannot update a component|Maximum update depth|Too many re-renders/.test(text) ||
        /LogoSlotPanel|LogosSection|RemoveLogoDialog/.test(text),
    );
  expect(calls).toEqual([]);
}

/** The academy screen with both slots read. */
async function openSlots() {
  await screen.findByRole('region', { name: 'Logo principal' });
  await within(slotRegion('primary')).findByText('Nenhum logo');
  await within(slotRegion('secondary')).findByText('Nenhum logo');
}

const png = () => imageFile(PNG_BYTES, 'logo.png', 'image/png');
const jpeg = () => imageFile(JPEG_BYTES, 'logo.jpg', 'image/jpeg');

/** The red alert of a slot, if any. */
function redAlert(slot: 'primary' | 'secondary') {
  return within(slotRegion(slot)).queryByRole('alert');
}

function notices(slot: 'primary' | 'secondary') {
  return within(slotRegion(slot))
    .queryAllByRole('status')
    .map((node) => node.textContent);
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

describe('common flow of a slot, with the writes followed by slot', () => {
  it('rn012 load, replace, remove and load again in one panel: notices only, never a red alert', async () => {
    const { user } = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    await openSlots();

    await user.upload(fileInput('primary'), png());
    await within(slotRegion('primary')).findByText('Logo principal salvo.');
    expect(within(slotRegion('primary')).getByRole('img')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/png;base64,'),
    );
    expect(redAlert('primary')).toBeNull();
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
    expect(slotButton('primary', 'Remover')).toBeEnabled();

    await user.upload(fileInput('primary'), jpeg());
    await waitFor(() => {
      expect(within(slotRegion('primary')).getByRole('img')).toHaveAttribute(
        'src',
        expect.stringContaining('data:image/jpeg;base64,'),
      );
    });
    expect(notices('primary')).toEqual(['Logo principal salvo.']);
    expect(redAlert('primary')).toBeNull();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await within(slotRegion('primary')).findByText('Nenhum logo');
    expect(notices('primary')).toEqual(['Logo principal removido.']);
    expect(redAlert('primary')).toBeNull();
    await waitFor(() => {
      expect(slotButton('primary', 'Carregar')).toHaveFocus();
    });

    await user.upload(fileInput('primary'), png());
    await waitFor(() => {
      expect(notices('primary')).toEqual(['Logo principal salvo.']);
    });
    expect(slotButton('primary', 'Trocar')).toBeEnabled();
    expect(redAlert('primary')).toBeNull();
    expectQuietConsole();
  });

  it('after ended writes, leaving and coming back shows no old notice and the slot works as usual', async () => {
    const app = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const { user } = app;
    await openSlots();
    await user.upload(fileInput('primary'), png());
    await within(slotRegion('primary')).findByText('Logo principal salvo.');

    await leaveAndComeBack(app);

    await waitFor(() => {
      expect(slotButton('primary', 'Trocar')).toBeEnabled();
    });
    expect(notices('primary')).toEqual([]);
    expect(redAlert('primary')).toBeNull();
    expect(slotRegion('primary').querySelector('[aria-busy="true"]')).toBeNull();

    await user.click(slotButton('primary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo principal' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await within(slotRegion('primary')).findByText('Nenhum logo');
    expect(notices('primary')).toEqual(['Logo principal removido.']);

    await leaveAndComeBack(app);
    await within(slotRegion('primary')).findByText('Nenhum logo');
    expect(notices('primary')).toEqual([]);
    expect(redAlert('primary')).toBeNull();
    expect(slotButton('primary', 'Carregar')).toBeEnabled();
    expectQuietConsole();
  });

  it('a send taken over ends with "salvo"; then "Trocar" in the new panel works with one notice', async () => {
    const held = gate();
    let firstPut = true;
    server.use(
      http.put(logoUrl('primary'), async () => {
        if (firstPut) {
          firstPut = false;
          await held.wait;
        }
        return undefined;
      }),
    );
    const app = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const { user } = app;
    await openSlots();
    await user.upload(fileInput('primary'), png());

    await leaveAndComeBack(app);
    expect(slotButton('primary', 'Carregar')).toBeDisabled();

    held.release();
    await within(slotRegion('primary')).findByText('Logo principal salvo.');
    expect(slotButton('primary', 'Trocar')).toBeEnabled();

    await user.upload(fileInput('primary'), jpeg());
    await waitFor(() => {
      expect(within(slotRegion('primary')).getByRole('img')).toHaveAttribute(
        'src',
        expect.stringContaining('data:image/jpeg;base64,'),
      );
    });
    expect(notices('primary')).toEqual(['Logo principal salvo.']);
    expect(redAlert('primary')).toBeNull();
    expect(slotButton('primary', 'Remover')).toBeEnabled();
    expectQuietConsole();
  });

  it('while the primary send taken over is on its way, the secondary is sent and removed as usual', async () => {
    const held = gate();
    server.use(
      http.put(logoUrl('primary'), async () => {
        await held.wait;
        return undefined;
      }),
    );
    const app = await renderApp({ route: ROUTE, signedInAs: 'examiner' });
    const { user } = app;
    await openSlots();
    await user.upload(fileInput('primary'), png());

    await leaveAndComeBack(app);
    expect(slotButton('primary', 'Carregar')).toBeDisabled();
    await within(slotRegion('secondary')).findByText('Nenhum logo');
    expect(slotButton('secondary', 'Carregar')).toBeEnabled();

    await user.upload(fileInput('secondary'), jpeg());
    await within(slotRegion('secondary')).findByText('Logo secundário salvo.');
    await user.click(slotButton('secondary', 'Remover'));
    const dialog = await screen.findByRole('dialog', { name: 'Remover logo secundário' });
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await within(slotRegion('secondary')).findByText('Nenhum logo');
    expect(notices('secondary')).toEqual(['Logo secundário removido.']);
    // The primary send is still on its way.
    expect(slotButton('primary', 'Carregar')).toBeDisabled();
    expect(notices('primary')).toEqual([]);

    held.release();
    await within(slotRegion('primary')).findByText('Logo principal salvo.');
    expect(notices('secondary')).toEqual(['Logo secundário removido.']);
    expectQuietConsole();
  });
});
