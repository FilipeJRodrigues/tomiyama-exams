import { Anchor, Center, Loader, Stack, Text, Title } from '@mantine/core';
import { Link, Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from '../auth/useAuth';
import { paths } from './navigation';

/** Where the login sends the user back to; kept in router state, never in the URL. */
export interface LoginRedirectState {
  from?: string;
}

export function FullPageLoader() {
  return (
    <Center mih="100dvh">
      <Loader aria-label="Carregando" />
    </Center>
  );
}

/** Routes that need a session; without one, go to the login. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'signedOut') {
    const state: LoginRedirectState = { from: location.pathname };
    return <Navigate to={paths.login} replace state={state} />;
  }
  return <Outlet />;
}

/** Examiner-only routes; guardians see a notice (the API also refuses, 403). */
export function RequireExaminer() {
  const { user } = useAuth();
  if (user?.role === 'examiner') return <Outlet />;
  return (
    <Stack gap="sm" maw={560}>
      <Title order={1} size="h2">
        Esta área é dos examinadores
      </Title>
      <Text>
        <Anchor component={Link} to={paths.students}>
          Meus alunos
        </Anchor>
      </Text>
    </Stack>
  );
}
