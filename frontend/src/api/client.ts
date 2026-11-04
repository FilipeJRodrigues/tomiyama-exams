import type { ApiErrorBody } from './types';

/** Error raised for any failed API call; `message` is pt-BR and safe to show. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Status 0 means the request never got a response. */
export const NETWORK_ERROR_STATUS = 0;

const NETWORK_MESSAGE =
  'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.';

/** Messages API Gateway itself returns in English (no Lambda involved). */
const GATEWAY_MESSAGES: Record<string, string> = {
  unauthorized: 'Sua sessão expirou. Entre de novo.',
  forbidden: 'Você não tem permissão para esta ação.',
  'not found': 'Recurso não encontrado.',
  'too many requests': 'Muitas requisições. Aguarde um instante e tente de novo.',
  'internal server error': 'Erro no servidor. Tente de novo.',
  'service unavailable': 'Serviço indisponível. Tente de novo em instantes.',
  'endpoint request timed out': 'O servidor demorou para responder. Tente de novo.',
};

function fallbackMessage(status: number): string {
  if (status === 400) return 'Dados inválidos.';
  if (status === 401) return GATEWAY_MESSAGES.unauthorized ?? '';
  if (status === 403) return GATEWAY_MESSAGES.forbidden ?? '';
  if (status === 404) return GATEWAY_MESSAGES['not found'] ?? '';
  if (status === 409) return 'Conflito com outra alteração. Tente de novo.';
  if (status === 429) return GATEWAY_MESSAGES['too many requests'] ?? '';
  if (status === 503) return GATEWAY_MESSAGES['service unavailable'] ?? '';
  if (status === 504) return GATEWAY_MESSAGES['endpoint request timed out'] ?? '';
  if (status >= 500) return 'Erro no servidor. Tente de novo.';
  return `Erro inesperado (${status}). Tente de novo.`;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn an error response into a pt-BR message.
 *
 * The backend already answers `{"message": "..."}` in pt-BR; API Gateway answers in
 * English (`{"message": "Unauthorized"}`), so those are translated.
 */
export function messageFromErrorBody(status: number, body: unknown): string {
  const raw = isErrorBody(body) && typeof body.message === 'string' ? body.message.trim() : '';
  if (!raw) return fallbackMessage(status);
  return GATEWAY_MESSAGES[raw.toLowerCase()] ?? raw;
}

/** Message to show for any error caught by a screen. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Algo deu errado. Tente de novo.';
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface ApiClientOptions {
  /** Base URL without a trailing slash; relative bases resolve against the page origin. */
  baseUrl: string;
  /** Cognito ID token (or the simulated one); null when signed out. */
  getToken: () => Promise<string | null>;
  /** Called on 401 so the app can end the session. */
  onUnauthorized?: () => void;
  fetchFn?: typeof fetch;
}

export interface ApiClient {
  get<T>(path: string, query?: QueryParams): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  /** `T` is the JSON body of a 200; a 204 resolves to `undefined`. */
  delete<T = void>(path: string): Promise<T>;
}

/** Build the absolute URL of an API path (`/students`) with its query string. */
export function buildApiUrl(baseUrl: string, path: string, query?: QueryParams): string {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * The JSON body of a response; null when it is empty or not JSON. Rejects (`TypeError`) when
 * the connection drops while the body is still arriving.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));

  async function request<T>(
    method: string,
    path: string,
    { query, body }: { query?: QueryParams; body?: unknown } = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    const token = await options.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await fetchFn(buildApiUrl(options.baseUrl, path, query), {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(NETWORK_ERROR_STATUS, NETWORK_MESSAGE);
    }

    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      // A body cut halfway still leaves the status: the error keeps it, with its own message.
      const errorBody = await readJson(response).catch(() => null);
      throw new ApiError(response.status, messageFromErrorBody(response.status, errorBody));
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await readJson(response)) as T;
    } catch {
      // The API answered, but its body was cut on the way: the outcome is unknown, as when no
      // answer arrives at all (a mark may have been saved, § 6.4).
      throw new ApiError(NETWORK_ERROR_STATUS, NETWORK_MESSAGE);
    }
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    delete: (path) => request('DELETE', path),
  };
}
