import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Cross-origin isolation (needed for SharedArrayBuffer in the sim worker, ADR-0006).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const backend = process.env.TRAFFICSIM_BACKEND ?? 'http://localhost:5080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: isolationHeaders,
    proxy: {
      '/api': backend,
      '/healthz': backend,
      '/readyz': backend,
    },
  },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'cobertura', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      // Rendering and bootstrap glue are smoke-tested only (ADR-0013); src/test holds test support code.
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/generated/**',
        'src/scene/**',
        'src/views/**',
        'src/main.tsx',
        'src/App.tsx',
        'src/sim/*.worker.ts',
      ],
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    },
  },
});
