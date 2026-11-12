import { describe, expect, it } from 'vitest';

import { checkDeployEnv, type DeployEnv } from '../../scripts/deployEnv';

const valid: DeployEnv = {
  VITE_USE_MOCKS: 'false',
  VITE_API_URL: 'https://abc123.execute-api.us-east-2.amazonaws.com',
  VITE_COGNITO_USER_POOL_ID: 'us-east-2_AbC123xyz',
  VITE_COGNITO_CLIENT_ID: 'client-example',
};

describe('checkDeployEnv', () => {
  it('accepts the four variables with the mocks off', () => {
    expect(checkDeployEnv(valid)).toEqual([]);
  });

  it('accepts surrounding spaces and FALSE in capitals, as the site reads them', () => {
    expect(
      checkDeployEnv({
        ...valid,
        VITE_USE_MOCKS: ' FALSE ',
        VITE_API_URL: ' https://api.example.com/ ',
      }),
    ).toEqual([]);
  });

  it('blocks a build without any variable, one message per variable', () => {
    expect(checkDeployEnv({})).toEqual([
      'VITE_USE_MOCKS não está definida como false. Use VITE_USE_MOCKS=false.',
      'VITE_API_URL está vazia. Use a saída ApiUrl da stack.',
      'VITE_COGNITO_USER_POOL_ID está vazia. Use a saída UserPoolId da stack.',
      'VITE_COGNITO_CLIENT_ID está vazia. Use a saída UserPoolClientId da stack.',
    ]);
  });

  it('treats blank values as missing', () => {
    expect(
      checkDeployEnv({
        VITE_USE_MOCKS: 'false',
        VITE_API_URL: '  ',
        VITE_COGNITO_USER_POOL_ID: '',
        VITE_COGNITO_CLIENT_ID: ' ',
      }),
    ).toHaveLength(3);
  });

  it.each(['true', 'TRUE', ' true '])('blocks the mocks on (VITE_USE_MOCKS=%j)', (mocks) => {
    expect(checkDeployEnv({ ...valid, VITE_USE_MOCKS: mocks })).toEqual([
      'VITE_USE_MOCKS está ligada: o site publicado usaria a API e o login simulados, com dados de mentira. Use VITE_USE_MOCKS=false.',
    ]);
  });

  it.each(['', '0', 'no'])('requires VITE_USE_MOCKS=false explicitly (got %j)', (mocks) => {
    expect(checkDeployEnv({ ...valid, VITE_USE_MOCKS: mocks })).toEqual([
      'VITE_USE_MOCKS não está definida como false. Use VITE_USE_MOCKS=false.',
    ]);
  });

  it.each(['http://api.example.com', 'api.example.com', 'https://'])(
    'requires an https API URL (got %j)',
    (apiUrl) => {
      expect(checkDeployEnv({ ...valid, VITE_API_URL: apiUrl })).toEqual([
        'VITE_API_URL precisa começar com https:// (o site no Amplify é HTTPS e o navegador bloqueia chamadas HTTP). Use a saída ApiUrl da stack.',
      ]);
    },
  );

  it('catches a user pool id swapped with the client id', () => {
    expect(
      checkDeployEnv({
        ...valid,
        VITE_COGNITO_USER_POOL_ID: 'client-example',
        VITE_COGNITO_CLIENT_ID: 'us-east-2_AbC123xyz',
      }),
    ).toEqual([
      'VITE_COGNITO_USER_POOL_ID não tem o formato <região>_<id> (ex.: us-east-2_AbC123). Confira se não foi trocada pela UserPoolClientId.',
    ]);
  });
});
