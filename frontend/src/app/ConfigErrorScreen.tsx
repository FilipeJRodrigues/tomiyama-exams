import { Alert, Center, MantineProvider } from '@mantine/core';

import { mantineProviderProps } from './theme';

/**
 * Shown instead of the app when the configuration is missing or startup failed. Same
 * provider settings as `AppProviders`: dark on the first visit, the saved choice, the colors.
 */
export function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <MantineProvider {...mantineProviderProps}>
      <Center mih="100dvh" p="md" component="main">
        <Alert color="red" title="Erro ao iniciar" role="alert" maw={560}>
          {message}
        </Alert>
      </Center>
    </MantineProvider>
  );
}
