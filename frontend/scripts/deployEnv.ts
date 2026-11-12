/**
 * Production configuration check run by the Amplify build (see `amplify.yml` at the repo root).
 *
 * Vite bakes the `VITE_*` variables into the bundle (`src/app/config.ts`). Without them, or
 * with the mocks on, the build would publish a site that shows the configuration error or
 * runs on fake data. Pure: no Node or browser API, so the tests import it as is.
 */

export type DeployEnvName =
  'VITE_USE_MOCKS' | 'VITE_API_URL' | 'VITE_COGNITO_USER_POOL_ID' | 'VITE_COGNITO_CLIENT_ID';

export type DeployEnv = Partial<Record<DeployEnvName, string>>;

/** `<region>_<id>`, e.g. `us-east-2_AbC123xyz`. */
const USER_POOL_ID = /^[a-z]{2}(-[a-z]+)+-\d+_[0-9A-Za-z]+$/;

/**
 * List what is wrong with the production configuration, as messages in pt-BR.
 *
 * @returns an empty list when the build may go on.
 */
export function checkDeployEnv(env: DeployEnv): string[] {
  const read = (name: DeployEnvName) => (env[name] ?? '').trim();
  const problems: string[] = [];

  const mocks = read('VITE_USE_MOCKS').toLowerCase();
  if (mocks === 'true') {
    problems.push(
      'VITE_USE_MOCKS está ligada: o site publicado usaria a API e o login simulados, com dados de mentira. Use VITE_USE_MOCKS=false.',
    );
  } else if (mocks !== 'false') {
    problems.push('VITE_USE_MOCKS não está definida como false. Use VITE_USE_MOCKS=false.');
  }

  const apiUrl = read('VITE_API_URL');
  if (!apiUrl) {
    problems.push('VITE_API_URL está vazia. Use a saída ApiUrl da stack.');
  } else if (!/^https:\/\/[^\s/]+/.test(apiUrl)) {
    problems.push(
      'VITE_API_URL precisa começar com https:// (o site no Amplify é HTTPS e o navegador bloqueia chamadas HTTP). Use a saída ApiUrl da stack.',
    );
  }

  const userPoolId = read('VITE_COGNITO_USER_POOL_ID');
  if (!userPoolId) {
    problems.push('VITE_COGNITO_USER_POOL_ID está vazia. Use a saída UserPoolId da stack.');
  } else if (!USER_POOL_ID.test(userPoolId)) {
    problems.push(
      'VITE_COGNITO_USER_POOL_ID não tem o formato <região>_<id> (ex.: us-east-2_AbC123). Confira se não foi trocada pela UserPoolClientId.',
    );
  }

  if (!read('VITE_COGNITO_CLIENT_ID')) {
    problems.push('VITE_COGNITO_CLIENT_ID está vazia. Use a saída UserPoolClientId da stack.');
  }

  return problems;
}
