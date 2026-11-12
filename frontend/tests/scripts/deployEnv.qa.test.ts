/**
 * Extra coverage from qa-frontend for the Amplify hosting (#31): edge cases of the deploy check
 * and the SPA rewrite rule documented in frontend/AMPLIFY.md, tested against the app routes and
 * the files the build publishes.
 */
import { describe, expect, it } from 'vitest';

import { examPath, paths, studentPath } from '../../src/app/navigation';
import { checkDeployEnv, type DeployEnv } from '../../scripts/deployEnv';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string, options: { recursive: true }): string[];
}

interface UrlLike {
  fileURLToPath(url: string): string;
}

async function load<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

async function localPath(relative: string): Promise<string> {
  const url = await load<UrlLike>('node:url');
  return url.fileURLToPath(new URL(relative, import.meta.url).href);
}

const valid: DeployEnv = {
  VITE_USE_MOCKS: 'false',
  VITE_API_URL: 'https://abc123.execute-api.us-east-2.amazonaws.com',
  VITE_COGNITO_USER_POOL_ID: 'us-east-2_AbC123xyz',
  VITE_COGNITO_CLIENT_ID: 'client-example',
};

describe('checkDeployEnv, edge cases (qa-frontend, #31)', () => {
  it.each([
    [
      'API URL with a trailing slash',
      { VITE_API_URL: 'https://x.execute-api.us-east-2.amazonaws.com/' },
    ],
    [
      'API URL with a stage path',
      { VITE_API_URL: 'https://x.execute-api.us-east-2.amazonaws.com/dev' },
    ],
    [
      'values pasted with a line break',
      { VITE_USE_MOCKS: 'false\n', VITE_COGNITO_CLIENT_ID: 'abc\r\n' },
    ],
    ['a pool id from another region', { VITE_COGNITO_USER_POOL_ID: 'sa-east-1_AbC123' }],
    ['a GovCloud pool id', { VITE_COGNITO_USER_POOL_ID: 'us-gov-west-1_AbC123' }],
  ])('accepts %s', (_case, override) => {
    expect(checkDeployEnv({ ...valid, ...override })).toEqual([]);
  });

  it.each(['"false"', 'off', 'false false'])('rejects VITE_USE_MOCKS=%j', (mocks) => {
    expect(checkDeployEnv({ ...valid, VITE_USE_MOCKS: mocks })).toHaveLength(1);
  });

  it.each(['https:///x', 'HTTP://x.com', 'ftp://x.com', ' http://x.com '])(
    'rejects VITE_API_URL=%j',
    (apiUrl) => {
      expect(checkDeployEnv({ ...valid, VITE_API_URL: apiUrl })).toHaveLength(1);
    },
  );

  it.each(['us-east-2', '_AbC123', 'us-east-2_', 'us-east-2_Ab-C', 'US-EAST-2_AbC'])(
    'rejects VITE_COGNITO_USER_POOL_ID=%j',
    (poolId) => {
      expect(checkDeployEnv({ ...valid, VITE_COGNITO_USER_POOL_ID: poolId })).toHaveLength(1);
    },
  );

  it('never echoes the values in the messages', () => {
    const marker = 'VALOR_QA_9f3';
    const problems = checkDeployEnv({
      VITE_USE_MOCKS: marker,
      VITE_API_URL: `http://${marker}`,
      VITE_COGNITO_USER_POOL_ID: marker,
      VITE_COGNITO_CLIENT_ID: '',
    });
    expect(problems).toHaveLength(4);
    for (const problem of problems) expect(problem).not.toContain(marker);
  });
});

describe('SPA rewrite rule of frontend/AMPLIFY.md (qa-frontend, #31)', () => {
  async function readRule() {
    const fs = await load<FsLike>('node:fs');
    const readme = fs.readFileSync(await localPath('../../AMPLIFY.md'), 'utf8');
    const block = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
    if (!block) throw new Error('JSON block of the rewrite rule not found in AMPLIFY.md');
    const rules = JSON.parse(block) as { source: string; target: string; status: string }[];
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    if (!rule) throw new Error('empty rule list');
    const source = /^<\/(.*)\/>$/.exec(rule.source)?.[1];
    if (!source) throw new Error(`source is not a </regex/>: ${rule.source}`);
    return { readme, rule, source, regex: new RegExp(source), fs };
  }

  it('rewrites to /index.html with status 200, and the table shows the same regex', async () => {
    const { readme, rule, source } = await readRule();
    expect(rule).toMatchObject({ target: '/index.html', status: '200' });
    const tableSource = /\| `<\/(.*?)\/>` \|/.exec(readme)?.[1]?.replaceAll('\\|', '|');
    expect(tableSource).toBe(source);
  });

  it('sends every route of the app to index.html, including ids and trailing slashes', async () => {
    const { regex } = await readRule();
    const uuid = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
    const routes = [
      '/',
      ...Object.values(paths).filter((path) => !path.includes(':')),
      `${paths.students}/`,
      studentPath(uuid),
      examPath(uuid, uuid),
      '/rota-que-nao-existe',
    ];
    for (const route of routes) expect([route, regex.test(route)]).toEqual([route, true]);
  });

  it('keeps the build assets and every file of public/ out of the rewrite', async () => {
    const { regex, fs } = await readRule();
    const publicDir = await localPath('../../public/');
    const publicFiles = fs
      .readdirSync(publicDir, { recursive: true })
      .map((file) => `/${file.replaceAll('\\', '/')}`)
      .filter((file) => /\.[^/]+$/.test(file));
    expect(publicFiles).toContain('/mockServiceWorker.js');
    const files = [
      ...publicFiles,
      '/assets/index-Cvv95kuy.js',
      '/assets/index-CZPYGvBm.css',
      '/assets/tslib.es6-CrUeKAU5.js',
      '/assets/index-Cvv95kuy.js.map',
      '/favicon.ico',
    ];
    for (const file of files) expect([file, regex.test(file)]).toEqual([file, false]);
  });
});
