/**
 * DEC-12 — vitest GLOBAL setup of the real-database suite (`tests/db/vitest.db.config.ts`).
 *
 * Runs once in the vitest main process BEFORE any worker is started or any test file is
 * imported. It imports only the pure guard and the pure options parser — no Prisma client, no
 * database driver, no application code — so when the guard refuses, the run aborts with a
 * `DbTestGuardError` and nothing that could open a database connection has even been loaded.
 */
import { resolveDbTestTarget } from '../harness/guard.js';
import { resolveIterations } from '../harness/options.js';

export default function setup(): void {
  const target = resolveDbTestTarget(process.env);
  const iterations = resolveIterations(process.env);
  // Fixed, non-secret facts only: never the URL, user, password or host.
  process.stdout.write(
    `[DEC-12] guard passed: database "${target.database}", loopback host: ${String(target.isLoopback)}, ` +
      `iterations per scenario: ${String(iterations)}\n`,
  );
}
