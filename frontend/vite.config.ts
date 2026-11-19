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
    // CSS stays off, except a `?raw` import (the source scans of tests/app): with `css: false`,
    // Vitest turns `x.module.css?raw` into a class-name Proxy and `x.css?raw` into "", so the
    // scans would miss the CSS. Vite's own CSS plugins skip `?raw`, which loads the file text.
    css: { include: [/[?&]raw\b/] },
    // Headroom for slow CI runners; the default 5 s is too tight under load.
    testTimeout: 15000,
    env: {
      // UTC-3 (no DST since 2019), so date bugs show up as in Brazil.
      TZ: 'America/Sao_Paulo',
      VITE_API_URL: 'http://api.test',
      VITE_USE_MOCKS: 'true',
    },
  },
});
