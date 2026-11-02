/**
 * Simulated ID token: `mock.<base64 of the claims>`. Only the MSW handlers read it.
 */
export interface MockClaims {
  sub: string;
  email: string;
  'cognito:groups': string[];
}

const PREFIX = 'mock.';

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeMockToken(claims: MockClaims): string {
  return PREFIX + toBase64(JSON.stringify(claims));
}

function isClaims(value: unknown): value is MockClaims {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const groups = record['cognito:groups'];
  return (
    typeof record.sub === 'string' &&
    typeof record.email === 'string' &&
    Array.isArray(groups) &&
    groups.every((group) => typeof group === 'string')
  );
}

/** Read the claims of a simulated token, or null when it is not one. */
export function decodeMockToken(token: string): MockClaims | null {
  if (!token.startsWith(PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64(token.slice(PREFIX.length)));
    return isClaims(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
