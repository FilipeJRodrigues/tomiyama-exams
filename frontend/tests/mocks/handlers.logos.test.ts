/**
 * The simulated logo routes follow `backend/README.md` (§ "Imagens da academia (RN012)"):
 * examiners only, `primary` and `secondary`, 404 for an empty or unknown slot, the type read
 * from the bytes, up to 2 MB, 413 above 3 MiB and a 204 delete, also without a logo.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, createApiClient, type ApiClient } from '../../src/api/client';
import { deleteLogo, getLogo, uploadLogo } from '../../src/api/queries';
import type { LogoSlot, LogoUploadInput } from '../../src/api/types';
import { createMockAuth } from '../../src/auth/mockAuth';
import { createMockDb, type MockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { GIF_BYTES, JPEG_BYTES, PNG_BYTES, base64Of } from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';

const INVALID = 'Envie PNG ou JPEG de até 2 MB';

let db: MockDb;

async function apiAs(role: 'examiner' | 'guardian'): Promise<ApiClient> {
  const auth = createMockAuth(null);
  await auth.signIn({ email: 'pessoa@example.com', password: 'senha-teste', role });
  return createApiClient({ baseUrl: TEST_API_URL, getToken: () => auth.getIdToken() });
}

async function failure(call: Promise<unknown>): Promise<[number, string]> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) return [error.status, error.message];
  }
  throw new Error('a chamada deveria falhar');
}

const png: LogoUploadInput = { content_type: 'image/png', data: base64Of(PNG_BYTES) };

describe('simulated logo routes (RN012)', () => {
  beforeEach(() => {
    db = createMockDb();
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
  });

  it('starts without logos: GET is null (404) for both slots', async () => {
    const api = await apiAs('examiner');
    expect(await getLogo(api, 'primary')).toBeNull();
    expect(await getLogo(api, 'secondary')).toBeNull();
  });

  it('rn012 PUT stores the logo and answers the metadata; GET adds a URL for 300 s', async () => {
    const api = await apiAs('examiner');

    const meta = await uploadLogo(api, 'primary', png);
    expect(meta).toMatchObject({ slot: 'primary', content_type: 'image/png', size: 12 });
    expect(meta).not.toHaveProperty('url');

    const view = await getLogo(api, 'primary');
    expect(view).toMatchObject({ slot: 'primary', content_type: 'image/png', expires_in: 300 });
    expect(view?.url).toBe(`data:image/png;base64,${png.data}`);
    expect(await getLogo(api, 'secondary')).toBeNull();
  });

  it('rn012 refuses a type that does not match the bytes, a GIF and a data-URL prefix', async () => {
    const api = await apiAs('examiner');
    const bodies: LogoUploadInput[] = [
      { content_type: 'image/jpeg', data: base64Of(PNG_BYTES) },
      { content_type: 'image/png', data: base64Of(GIF_BYTES) },
      { content_type: 'image/png', data: `data:image/png;base64,${png.data}` },
      { content_type: 'image/png', data: '' },
    ];
    for (const body of bodies) {
      expect(await failure(uploadLogo(api, 'primary', body))).toEqual([400, INVALID]);
    }
    expect(db.logos.primary).toBeUndefined();
  });

  it('rn012 accepts exactly 2 MB, refuses one byte more and answers 413 above 3 MiB', async () => {
    const api = await apiAs('examiner');
    const sized = (size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set(JPEG_BYTES);
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    };

    await uploadLogo(api, 'secondary', {
      content_type: 'image/jpeg',
      data: sized(2 * 1024 * 1024),
    });
    expect(db.logos.secondary?.size).toBe(2 * 1024 * 1024);

    expect(
      await failure(
        uploadLogo(api, 'secondary', {
          content_type: 'image/jpeg',
          data: sized(2 * 1024 * 1024 + 1),
        }),
      ),
    ).toEqual([400, INVALID]);
    expect(
      await failure(
        uploadLogo(api, 'secondary', {
          content_type: 'image/jpeg',
          data: 'A'.repeat(3 * 1024 * 1024),
        }),
      ),
    ).toEqual([413, 'Corpo da requisição grande demais']);
  });

  it('DELETE removes the logo and is 204 also without one', async () => {
    const api = await apiAs('examiner');
    await uploadLogo(api, 'primary', png);

    await deleteLogo(api, 'primary');
    expect(await getLogo(api, 'primary')).toBeNull();
    await expect(deleteLogo(api, 'primary')).resolves.toBeUndefined();
  });

  it('an unknown slot is 404 "Logo não encontrado"; a guardian gets 403 first', async () => {
    const examiner = await apiAs('examiner');
    const guardian = await apiAs('guardian');
    const unknown = 'terciario' as LogoSlot;

    expect(await failure(uploadLogo(examiner, unknown, png))).toEqual([404, 'Logo não encontrado']);
    expect(await failure(deleteLogo(examiner, unknown))).toEqual([404, 'Logo não encontrado']);
    expect(await failure(getLogo(guardian, unknown))).toEqual([
      403,
      'Esta área é dos examinadores',
    ]);
    expect(await failure(uploadLogo(guardian, 'primary', png))).toEqual([
      403,
      'Esta área é dos examinadores',
    ]);
  });
});
