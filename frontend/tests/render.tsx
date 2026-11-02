import { render, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';

import { AppProviders } from '../src/app/AppProviders';
import { createQueryClient } from '../src/app/queryClient';
import { createRoutes } from '../src/app/routes';
import { createMockAuth } from '../src/auth/mockAuth';
import type { AuthService, Role } from '../src/auth/types';
import { TEST_API_URL } from './msw-server';

export interface RenderAppOptions {
  route?: string;
  /** Signed-in profile; omit to start signed out. */
  signedInAs?: Role;
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
  if (signedInAs) {
    await auth.signIn({
      email: `${signedInAs}@example.com`,
      password: 'senha-teste',
      role: signedInAs,
    });
  }
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: true } });
  const router = createMemoryRouter(createRoutes({ useMocks: true }), { initialEntries: [route] });
  const user = userEvent.setup();
  const result = render(
    <AppProviders auth={auth} apiUrl={TEST_API_URL} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, user, auth, router };
}
