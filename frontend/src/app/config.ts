/** Runtime configuration read from the `VITE_*` variables (see `.env.example`). */

/** Base used for the API when mocks are on and no `VITE_API_URL` is set. */
export const MOCK_API_URL = '/api';

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
}

export interface AppConfig {
  useMocks: boolean;
  /** API base URL without a trailing slash; may be relative (mock mode). */
  apiUrl: string;
  /** Only present when mocks are off. */
  cognito: CognitoConfig | null;
}

/** Configuration error shown on screen instead of the app. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface EnvSource {
  VITE_API_URL?: string;
  VITE_COGNITO_USER_POOL_ID?: string;
  VITE_COGNITO_CLIENT_ID?: string;
  VITE_USE_MOCKS?: string;
  DEV?: boolean;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Read and validate the configuration.
 *
 * @throws ConfigError when mocks are off and a required variable is missing.
 */
export function readConfig(env: EnvSource): AppConfig {
  const rawMocks = clean(env.VITE_USE_MOCKS).toLowerCase();
  const useMocks = rawMocks === '' ? env.DEV === true : rawMocks === 'true';
  const apiUrl = clean(env.VITE_API_URL).replace(/\/+$/, '');

  if (useMocks) {
    return { useMocks, apiUrl: apiUrl || MOCK_API_URL, cognito: null };
  }

  const userPoolId = clean(env.VITE_COGNITO_USER_POOL_ID);
  const clientId = clean(env.VITE_COGNITO_CLIENT_ID);
  const missing = [
    apiUrl ? null : 'VITE_API_URL',
    userPoolId ? null : 'VITE_COGNITO_USER_POOL_ID',
    clientId ? null : 'VITE_COGNITO_CLIENT_ID',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new ConfigError(
      `Configuração incompleta: defina ${missing.join(', ')} ou use VITE_USE_MOCKS=true.`,
    );
  }
  return { useMocks, apiUrl, cognito: { userPoolId, clientId } };
}
