// DEC-12 — vitest configuration of the REAL-DATABASE suite. Never used by `npm test`.
//
// NOT EXECUTED — requires explicit owner authorization (DEC-12). See tests/db/README.md.
//
//   npx vitest run --config tests/db/vitest.db.config.ts
//
// - Collects ONLY `tests/db/**/*.dbtest.ts`. The default configuration (`vitest.config.ts`)
//   includes `tests/**/*.test.ts`, which the `.dbtest.ts` suffix never matches.
// - `globalSetup` aborts the run before any worker starts unless the guard passes
//   (`tests/db/setup/globalGuard.ts`); `setupFiles` repeats the guard in the worker.
// - `envDir: false`: no `.env*` file is read by Vite. The variables must be set by the owner in
//   the shell session that runs the command.
// - One fork, files one after another: the scenarios share one database and each of them
//   empties it between iterations.
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: repositoryRoot,
  envDir: false,
  test: {
    environment: 'node',
    include: ['tests/db/**/*.dbtest.ts'],
    globalSetup: ['tests/setup/nodeVersion.ts', 'tests/db/setup/globalGuard.ts'],
    setupFiles: ['tests/db/setup/workerGuard.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    testTimeout: 300_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
    retry: 0,
    passWithNoTests: false,
    watch: false,
  },
});
