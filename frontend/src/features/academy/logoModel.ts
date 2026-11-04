/**
 * Logos of the academy screen (§ 6.6, RN012): labels, the local check of the chosen file and
 * its conversion to the body of `PUT /settings/logos/{slot}`. The check is a convenience: the
 * API checks the type (by the bytes) and the size again, with the same message.
 */
import { ApiError } from '../../api/client';
import type { LogoWriteKind } from '../../api/queries';
import type { ImageContentType, LogoSlot, LogoUploadInput } from '../../api/types';
import { markOutcomeUnknown } from '../exam/examModel';

export const LOGO_SLOTS: readonly LogoSlot[] = ['primary', 'secondary'];

/** Name of each slot, as a title ("Logo principal"). */
export const LOGO_SLOT_LABELS: Record<LogoSlot, string> = {
  primary: 'Logo principal',
  secondary: 'Logo secundário',
};

/** The slot's name inside a sentence ("Remover o logo principal?"). */
export function logoName(slot: LogoSlot): string {
  return LOGO_SLOT_LABELS[slot].toLowerCase();
}

/** RN012: 2 MB = 2 × 1024 × 1024 bytes of the file; exactly 2 MB is accepted. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** RN012, same text as the API's 400. */
export const MSG_INVALID_IMAGE = 'Envie PNG ou JPEG de até 2 MB';

export const MSG_UNREADABLE_FILE = 'Não foi possível ler o arquivo. Escolha o arquivo de novo.';

/** What the file picker offers; the user may still pick another file ("Todos os arquivos"). */
export const LOGO_ACCEPT = 'image/png,image/jpeg';

const TYPE_LABELS: Record<ImageContentType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: ArrayLike<number>, signature: readonly number[]): boolean {
  return (
    bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value)
  );
}

/**
 * The image type read from the first bytes, like the API (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG
 * `FF D8 FF`); null for anything else. The file's own type (its extension) is not trusted: a
 * PNG renamed `.jpg` is sent as PNG, and a GIF renamed `.png` is refused here.
 */
export function detectImageType(bytes: ArrayLike<number>): ImageContentType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  return null;
}

/** The first bytes of a standard base64 text (12 characters give 9 bytes). */
function leadingBytes(base64: string): number[] {
  try {
    const head = atob(base64.slice(0, 12));
    return Array.from(head, (char) => char.charCodeAt(0));
  } catch {
    return [];
  }
}

/**
 * The file in standard base64, without the `data:…;base64,` prefix the API refuses. The
 * browser reads it in the background (`FileReader`), so the screen does not freeze.
 */
export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('read failed'));
    };
    reader.readAsDataURL(file);
  });
}

export type PreparedLogo = { ok: true; input: LogoUploadInput } | { ok: false; message: string };

/**
 * Checks the chosen file (RN012: PNG or JPEG by its bytes, up to 2 MB) and turns it into the
 * upload body. A file too big is refused before being read.
 */
export async function prepareLogo(file: Blob): Promise<PreparedLogo> {
  if (file.size === 0 || file.size > MAX_LOGO_BYTES) {
    return { ok: false, message: MSG_INVALID_IMAGE };
  }
  let data: string;
  try {
    data = await readAsBase64(file);
  } catch {
    return { ok: false, message: MSG_UNREADABLE_FILE };
  }
  const contentType = detectImageType(leadingBytes(data));
  if (contentType === null) return { ok: false, message: MSG_INVALID_IMAGE };
  return { ok: true, input: { content_type: contentType, data } };
}

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** "PNG, 48 KB" or "JPEG, 1,5 MB" (1 KB = 1024 bytes, like the 2 MB of RN012). */
export function describeLogo(contentType: ImageContentType, size: number): string {
  const kib = size / 1024;
  const amount =
    kib < 1024 ? `${String(Math.max(1, Math.round(kib)))} KB` : `${decimal.format(kib / 1024)} MB`;
  return `${TYPE_LABELS[contentType]}, ${amount}`;
}

/**
 * Title of a failed send or removal (§ 6.6): "Sem permissão" for a 403, "Não foi possível
 * confirmar…" when the request left and no answer came (it may have been stored), and "Não foi
 * possível…" for a refusal of the API.
 */
export function logoWriteErrorTitle(kind: LogoWriteKind, error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Sem permissão';
  if (markOutcomeUnknown(error)) {
    return kind === 'upload'
      ? 'Não foi possível confirmar o envio'
      : 'Não foi possível confirmar a remoção';
  }
  return kind === 'upload' ? 'Não foi possível enviar o logo' : 'Não foi possível remover';
}

/**
 * What to do after a write whose outcome is unknown, in the slot (not in the removal dialog,
 * which has its own "Remover"). `mayHaveChanged`: the slot's mark is on, so there is no preview
 * to check, only "Tentar de novo".
 */
export function logoWriteUnknownHint(kind: LogoWriteKind, mayHaveChanged: boolean): string {
  if (kind === 'upload') {
    return mayHaveChanged
      ? 'O logo pode ter sido salvo, mas a prévia não carregou. Tente carregar de novo para conferir e envie de novo se precisar.'
      : 'O logo pode ter sido salvo. Confira a prévia e envie de novo se precisar.';
  }
  return mayHaveChanged
    ? 'O logo pode ter sido removido, mas a prévia não carregou. Tente carregar de novo para conferir e remova de novo se precisar.'
    : 'O logo pode ter sido removido. Confira a prévia e remova de novo se precisar.';
}
