import '@mantine/core/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';

import { AppProviders } from './app/AppProviders';
import { ConfigError, readConfig, type AppConfig } from './app/config';
import { ConfigErrorScreen } from './app/ConfigErrorScreen';
import { createQueryClient } from './app/queryClient';
import { createRoutes } from './app/routes';
import { createAuth } from './auth/createAuth';

async function bootstrap(config: AppConfig) {
  if (config.useMocks) {
    const { startMockWorker } = await import('./mocks/browser');
    await startMockWorker(config.apiUrl);
  }
  const auth = await createAuth(config);
  const router = createBrowserRouter(createRoutes({ useMocks: config.useMocks }));
  return { auth, router };
}

const container = document.getElementById('root');
if (!container) throw new Error('Elemento #root ausente');
const root = createRoot(container);

try {
  const config = readConfig(import.meta.env);
  const { auth, router } = await bootstrap(config);
  root.render(
    <StrictMode>
      <AppProviders auth={auth} apiUrl={config.apiUrl} queryClient={createQueryClient()}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
} catch (error) {
  const message =
    error instanceof ConfigError ? error.message : 'Não foi possível iniciar o sistema.';
  root.render(<ConfigErrorScreen message={message} />);
}
