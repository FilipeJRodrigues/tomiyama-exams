/**
 * The local check of a logo file (§ 6.6, RN012): PNG or JPEG read from the bytes, up to 2 MB
 * (exactly 2 MB is accepted), and the base64 body without the data-URL prefix.
 */
import { describe, expect, it } from 'vitest';

import { ApiError, NETWORK_ERROR_STATUS } from '../../../src/api/client';
import { LOGO_STALE_TIME_MS } from '../../../src/api/queries';
import {
  MAX_LOGO_BYTES,
  MSG_INVALID_IMAGE,
  describeLogo,
  detectImageType,
  logoWriteErrorTitle,
  logoWriteUnknownHint,
  prepareLogo,
} from '../../../src/features/academy/logoModel';
import { GIF_BYTES, JPEG_BYTES, PNG_BYTES, base64Of, imageFile } from './logoHelpers';

describe('detectImageType (RN012)', () => {
  it('rn012 reads PNG and JPEG from the first bytes', () => {
    expect(detectImageType(PNG_BYTES)).toBe('image/png');
    expect(detectImageType(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('rn012 refuses other types and files shorter than the signature', () => {
    expect(detectImageType(GIF_BYTES)).toBeNull();
    expect(detectImageType([0x89, 0x50, 0x4e])).toBeNull();
    expect(detectImageType([])).toBeNull();
  });
});

describe('prepareLogo (RN012)', () => {
  it('rn012 turns a PNG into the body: standard base64 without the data-URL prefix', async () => {
    const result = await prepareLogo(imageFile(PNG_BYTES, 'logo.png', 'image/png'));

    expect(result).toEqual({
      ok: true,
      input: { content_type: 'image/png', data: base64Of(PNG_BYTES) },
    });
  });

  it('rn012 the type comes from the bytes, not from the name: a PNG named .jpg goes as PNG', async () => {
    const result = await prepareLogo(imageFile(PNG_BYTES, 'logo.jpg', 'image/jpeg'));

    expect(result.ok && result.input.content_type).toBe('image/png');
  });

  it('rn012 refuses a GIF, also one named .png', async () => {
    expect(await prepareLogo(imageFile(GIF_BYTES, 'logo.png', 'image/png'))).toEqual({
      ok: false,
      message: MSG_INVALID_IMAGE,
    });
  });

  it('rn012 refuses an empty file', async () => {
    expect(await prepareLogo(imageFile([], 'vazio.png', 'image/png'))).toEqual({
      ok: false,
      message: 'Envie PNG ou JPEG de até 2 MB',
    });
  });

  it('rn012 accepts exactly 2 MB and refuses one byte more', async () => {
    const exact = await prepareLogo(
      imageFile(PNG_BYTES, 'limite.png', 'image/png', MAX_LOGO_BYTES),
    );
    expect(exact.ok).toBe(true);

    const over = await prepareLogo(
      imageFile(PNG_BYTES, 'grande.png', 'image/png', MAX_LOGO_BYTES + 1),
    );
    expect(over).toEqual({ ok: false, message: MSG_INVALID_IMAGE });
  });
});

describe('describeLogo', () => {
  it('names the type and the size in KB or MB, pt-BR', () => {
    expect(describeLogo('image/png', 300)).toBe('PNG, 1 KB');
    expect(describeLogo('image/png', 48_213)).toBe('PNG, 47 KB');
    expect(describeLogo('image/jpeg', 1_572_864)).toBe('JPEG, 1,5 MB');
    expect(describeLogo('image/jpeg', MAX_LOGO_BYTES)).toBe('JPEG, 2 MB');
  });
});

describe('logo read freshness', () => {
  it('stays fresh for less than the 300 s of the pre-signed URL', () => {
    expect(LOGO_STALE_TIME_MS).toBeLessThan(300_000);
    expect(LOGO_STALE_TIME_MS).toBeGreaterThan(0);
  });
});

describe('logo write errors', () => {
  const noAnswer = new ApiError(NETWORK_ERROR_STATUS, 'sem resposta');
  const timeout = new ApiError(504, 'O servidor demorou para responder. Tente de novo.');
  const forbidden = new ApiError(403, 'Você não tem permissão para esta ação.');
  const refused = new ApiError(400, MSG_INVALID_IMAGE);
  const busy = new ApiError(503, 'Sistema ocupado no momento. Tente de novo em instantes.');

  it('titles a send: no permission, unknown outcome (no answer, 504) or refused', () => {
    expect(logoWriteErrorTitle('upload', forbidden)).toBe('Sem permissão');
    expect(logoWriteErrorTitle('upload', noAnswer)).toBe('Não foi possível confirmar o envio');
    expect(logoWriteErrorTitle('upload', timeout)).toBe('Não foi possível confirmar o envio');
    expect(logoWriteErrorTitle('upload', refused)).toBe('Não foi possível enviar o logo');
    expect(logoWriteErrorTitle('upload', busy)).toBe('Não foi possível enviar o logo');
  });

  it('titles a removal the same way', () => {
    expect(logoWriteErrorTitle('remove', forbidden)).toBe('Sem permissão');
    expect(logoWriteErrorTitle('remove', noAnswer)).toBe('Não foi possível confirmar a remoção');
    expect(logoWriteErrorTitle('remove', busy)).toBe('Não foi possível remover');
  });

  it('with the mark on there is no preview to check: the hint says to load again', () => {
    expect(logoWriteUnknownHint('upload', true)).toBe(
      'O logo pode ter sido salvo, mas a prévia não carregou. Tente carregar de novo para conferir e envie de novo se precisar.',
    );
    expect(logoWriteUnknownHint('upload', false)).toBe(
      'O logo pode ter sido salvo. Confira a prévia e envie de novo se precisar.',
    );
    expect(logoWriteUnknownHint('remove', true)).toBe(
      'O logo pode ter sido removido, mas a prévia não carregou. Tente carregar de novo para conferir e remova de novo se precisar.',
    );
    expect(logoWriteUnknownHint('remove', false)).toBe(
      'O logo pode ter sido removido. Confira a prévia e remova de novo se precisar.',
    );
  });
});
