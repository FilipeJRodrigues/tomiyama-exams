import { render, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';

import { AppProviders } from '../src/app/AppProviders';
import { createQueryClient } from '../src/app/queryClient';
import { createRoutes } from '../src/app/routes';
import { createMockAuth } from '../src/auth/mockAuth';
import { MOCK_MASTER_EMAIL } from '../src/auth/mockConstants';
import type { AuthService, Role } from '../src/auth/types';
import { TEST_API_URL } from './msw-server';

export interface RenderAppOptions {
  route?: string;
  /**
   * Signed-in profile; omit to start signed out. `master` is the simulated admin master (an
   * examiner in the groups `admin` and `master`).
   */
  signedInAs?: Role | 'master';
  auth?: AuthService;
}

export interface RenderAppResult extends RenderResult {
  user: UserEvent;
  auth: AuthService;
  router: ReturnType<typeof createMemoryRouter>;
}

/** Render the whole app (providers + routes) at a route, with the simulated login. */
export async function renderApp({
  route = '/',
  signedInAs,
  auth = createMockAuth(window.sessionStorage),
}: RenderAppOptions = {}): Promise<RenderAppResult> {
  if (signedInAs === 'master') {
    await auth.signIn({ email: MOCK_MASTER_EMAIL, password: 'senha-teste', role: 'examiner' });
  } else if (signedInAs) {
    await auth.signIn({
      email: `${signedInAs}@example.com`,
      password: 'senha-teste',
      role: signedInAs,
    });
  }
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: true } });
  const router = createMemoryRouter(createRoutes({ useMocks: true }), { initialEntries: [route] });
  // No delay between keystrokes: same event order, much faster under load.
  const user = userEvent.setup({ delay: null });
  const result = render(
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, user, auth, router };
}
