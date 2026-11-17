import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Keep resource use low on 8 GB development machines.
    pool: 'forks',
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entrypoint (listen + signal handling) is exercised manually, not in unit tests.
      exclude: ['src/server.ts', 'src/types/**'],
      reporter: ['text', 'html'],
      // TESTING_STRATEGY.md §17 — API overall floor.
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 75 },
    },
  },
});
