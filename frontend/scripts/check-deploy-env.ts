/**
 * Stops the Amplify build when the production configuration is missing or has the mocks on.
 *
 * Run with `node scripts/check-deploy-env.ts` (Node 22.18+ strips the types). Only the
 * Amplify build calls it: `npm run build` in the CI and locally stays as it is.
 * Prints variable names only, never their values.
 */
import { checkDeployEnv } from './deployEnv.ts';

const problems = checkDeployEnv(process.env);

if (problems.length > 0) {
  process.stderr.write(
    [
      'Build de produção interrompido: a configuração do site não está pronta para publicar.',
      ...problems.map((problem) => `- ${problem}`),
      'Corrija as variáveis em Hosting > Environment variables no console do Amplify (guia na seção "Front no Amplify (dev)" do README.md da raiz) e rode o build de novo.',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Configuração de produção conferida: VITE_API_URL, VITE_COGNITO_USER_POOL_ID e VITE_COGNITO_CLIENT_ID definidas, VITE_USE_MOCKS=false.\n',
  );
}
