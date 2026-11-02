import { useMemo, type ReactNode } from 'react';

import { useAuth } from '../auth/useAuth';
import { createApiClient } from './client';
import { ApiContext } from './context';

interface Props {
  baseUrl: string;
  children: ReactNode;
}

/** Provide the API client with the token of the signed-in user. */
export function ApiProvider({ baseUrl, children }: Props) {
  const { getIdToken, signOut } = useAuth();
  const client = useMemo(
    () =>
      createApiClient({
        baseUrl,
        getToken: getIdToken,
        // An expired or revoked token ends the session; the guard sends the user to the login.
        onUnauthorized: () => void signOut(),
      }),
    [baseUrl, getIdToken, signOut],
  );
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}
