/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    css: false,
    env: {
      // UTC-3 (no DST since 2019), so date bugs show up as in Brazil.
      TZ: 'America/Sao_Paulo',
      VITE_API_URL: 'http://api.test',
      VITE_USE_MOCKS: 'true',
    },
  },
});
