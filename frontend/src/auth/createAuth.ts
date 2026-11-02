import type { AppConfig } from '../app/config';
import type { AuthService } from './types';

/** Pick the implementation; each one is loaded only when used. */
export async function createAuth(config: AppConfig): Promise<AuthService> {
  if (config.useMocks || !config.cognito) {
    const { createMockAuth } = await import('./mockAuth');
    return createMockAuth();
  }
  const { createCognitoAuth } = await import('./cognitoAuth');
  return createCognitoAuth(config.cognito);
}
