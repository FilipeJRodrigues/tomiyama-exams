/** Shared steps of the logo tests (§ 6.6, RN012). */
import { screen, within } from '@testing-library/react';
import { http } from 'msw';

import type { LogoSlot, LogoView } from '../../../src/api/types';
import type { MockLogo } from '../../../src/mocks/data';
import { server, TEST_API_URL } from '../../msw-server';

export const PNG_BYTES: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
];
export const JPEG_BYTES: readonly number[] = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
export const GIF_BYTES: readonly number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00];

export function logoUrl(slot: LogoSlot): string {
  return `${TEST_API_URL}/settings/logos/${slot}`;
}

export function base64Of(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * A file starting with `bytes`; with `size`, padded with zeros up to it (the size check comes
 * before the type check, so a big file only needs its signature).
 */
export function imageFile(
  bytes: readonly number[],
  name: string,
  type: string,
  size = bytes.length,
): File {
  const content = new Uint8Array(size);
  content.set(bytes.slice(0, size));
  return new File([content], name, { type });
}

/** A stored logo of the simulated API. */
export function mockLogo(bytes: readonly number[] = PNG_BYTES): MockLogo {
  return {
    content_type: bytes === JPEG_BYTES ? 'image/jpeg' : 'image/png',
    size: bytes.length,
    updated_at: '2026-11-02T12:00:00+00:00',
    updated_by: 'mock-examiner-2',
    data: base64Of(bytes),
  };
}

/** A `GET /settings/logos/{slot}` answer with a given URL. */
export function logoView(slot: LogoSlot, url: string): LogoView {
  return {
    slot,
    url,
    expires_in: 300,
    content_type: 'image/png',
    size: 48_213,
    updated_at: '2026-11-02T12:00:00+00:00',
    updated_by: 'mock-examiner-2',
  };
}

const SLOT_TITLES: Record<LogoSlot, string> = {
  primary: 'Logo principal',
  secondary: 'Logo secundário',
};

/** The section of a slot (`<section>` named by its heading). */
export function slotRegion(slot: LogoSlot): HTMLElement {
  return screen.getByRole('region', { name: SLOT_TITLES[slot] });
}

/** The hidden file input of a slot, named for assistive technology. */
export function fileInput(slot: LogoSlot): HTMLInputElement {
  return within(slotRegion(slot)).getByLabelText<HTMLInputElement>(
    `Arquivo do ${SLOT_TITLES[slot].toLowerCase()}`,
  );
}

export function slotButton(slot: LogoSlot, verb: 'Carregar' | 'Trocar' | 'Remover') {
  return within(slotRegion(slot)).getByRole<HTMLButtonElement>('button', {
    name: `${verb} ${SLOT_TITLES[slot].toLowerCase()}`,
  });
}

export interface LogoRequest {
  method: string;
  slot: string;
  body: unknown;
}

/** Records every request to the logo routes and lets the mock answer. */
export function recordLogoRequests(): LogoRequest[] {
  const requests: LogoRequest[] = [];
  server.use(
    http.all(`${TEST_API_URL}/settings/logos/:slot`, async ({ request, params }) => {
      const text = await request.clone().text();
      requests.push({
        method: request.method,
        slot: String(params.slot),
        body: text ? (JSON.parse(text) as unknown) : null,
      });
      return undefined;
    }),
  );
  return requests;
}

export function ofMethod(requests: readonly LogoRequest[], method: string, slot?: LogoSlot) {
  return requests.filter(
    (request) => request.method === method && (slot === undefined || request.slot === slot),
  );
}
