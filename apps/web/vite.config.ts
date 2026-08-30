/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Resolve the workspace package to its source, never to dist. Same precedent as
// apps/api/jest.config.js: a stale build would typecheck clean and behave
// differently at runtime, which is the exact drift @scheduler/contracts exists
// to make impossible.
const CONTRACTS_SRC = fileURLToPath(
  new URL('../../packages/contracts/src/index.ts', import.meta.url),
);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [react()],
    resolve: { alias: { '@scheduler/contracts': CONTRACTS_SRC } },
    server: {
      port: 5173,
      // Not negotiable: apps/api/.env pins CORS_ORIGIN to http://localhost:5173.
      // Drifting to 5174 would break the documented no-proxy fallback in a way
      // that reads as a server bug. Fail loudly instead.
      strictPort: true,
      proxy: {
        // The API mounts no global prefix, so /api is stripped on the way out.
        '/api': {
          target,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/, ''),
        },
      },
      // The contracts alias points outside this package's root.
      fs: { allow: ['../..'] },
    },
    build: { outDir: 'dist', sourcemap: true },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
