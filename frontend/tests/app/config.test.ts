import { describe, expect, it } from 'vitest';

import { ConfigError, MOCK_API_URL, readConfig } from '../../src/app/config';

describe('readConfig', () => {
  it('turns mocks on by default in dev', () => {
    expect(readConfig({ DEV: true })).toEqual({
      useMocks: true,
      apiUrl: MOCK_API_URL,
      cognito: null,
    });
  });

  it('turns mocks off by default in builds and requires the AWS values', () => {
    expect(() => readConfig({ DEV: false })).toThrow(ConfigError);
    expect(() => readConfig({ DEV: false })).toThrow(
      'Configuração incompleta: defina VITE_API_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID ou use VITE_USE_MOCKS=true.',
    );
  });

  it('reads the Cognito ids and strips the trailing slash of the API URL', () => {
    expect(
      readConfig({
        VITE_USE_MOCKS: 'false',
        VITE_API_URL: 'https://api.example.com/',
        VITE_COGNITO_USER_POOL_ID: 'us-east-2_example',
        VITE_COGNITO_CLIENT_ID: 'client-example',
        DEV: true,
      }),
    ).toEqual({
      useMocks: false,
      apiUrl: 'https://api.example.com',
      cognito: { userPoolId: 'us-east-2_example', clientId: 'client-example' },
    });
  });

  it('honours VITE_USE_MOCKS=true in a build', () => {
    expect(readConfig({ VITE_USE_MOCKS: 'true', DEV: false }).useMocks).toBe(true);
  });
});
