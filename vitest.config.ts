import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./src'),
      '@config': r('./src/config'),
      '@common': r('./src/common'),
      '@modules': r('./src/modules'),
      '@infra': r('./src/infra'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['tests/**', '**/*.d.ts', 'dist/**'],
    },
  },
});
