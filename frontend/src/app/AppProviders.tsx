import { MantineProvider } from '@mantine/core';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ApiProvider } from '../api/ApiProvider';
import { AuthProvider } from '../auth/AuthProvider';
import type { AuthService } from '../auth/types';
import { colorSchemeManager, cssVariablesResolver, theme } from './theme';

interface Props {
  auth: AuthService;
  apiUrl: string;
  queryClient: QueryClient;
  children: ReactNode;
}

export function AppProviders({ auth, apiUrl, queryClient, children }: Props) {
  return (
    <MantineProvider
      theme={theme}
      colorSchemeManager={colorSchemeManager}
      cssVariablesResolver={cssVariablesResolver}
      // Dark on the first visit; a saved choice wins. `index.html` sets it before React.
      defaultColorScheme="dark"
    >
      <QueryClientProvider client={queryClient}>
        <AuthProvider service={auth}>
          <ApiProvider baseUrl={apiUrl}>{children}</ApiProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
