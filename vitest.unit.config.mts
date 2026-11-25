import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/schema-integration/**'],
  },
});
