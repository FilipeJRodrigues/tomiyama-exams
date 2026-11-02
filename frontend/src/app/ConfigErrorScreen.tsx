import { Alert, Center, MantineProvider } from '@mantine/core';

import { colorSchemeManager, theme } from './theme';

/** Shown instead of the app when the configuration is missing or startup failed. */
export function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <MantineProvider theme={theme} colorSchemeManager={colorSchemeManager}>
      <Center mih="100dvh" p="md" component="main">
        <Alert color="red" title="Erro ao iniciar" role="alert" maw={560}>
          {message}
        </Alert>
      </Center>
    </MantineProvider>
  );
}
