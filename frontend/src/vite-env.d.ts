/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the HTTP API, without a trailing slash. */
  readonly VITE_API_URL?: string;
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  /** "true" turns on MSW and the simulated login. Default: on in dev, off in builds. */
  readonly VITE_USE_MOCKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
