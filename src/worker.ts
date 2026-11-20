/**
 * Dedicated background worker entrypoint (D-61, Batch 9). `npm run dev:worker` (development) /
 * `npm run start:worker` (production, `node dist/worker.js`).
 *
 * Runs the scheduled jobs; the API process (`src/server.ts`) never does. No HTTP server is started.
 * Exactly one worker process may run (deployment discipline; no distributed lock). Jobs run only
 * when `JOBS_ENABLED=true`; otherwise the worker logs that and exits 0.
 */
import { assertRuntimeOrExit, createProcessRuntime, loadConfigOrExit } from './bootstrap.js';
import { runWorker } from './workerRuntime.js';

async function main(): Promise<void> {
  assertRuntimeOrExit();
  const config = loadConfigOrExit();
  const runtime = createProcessRuntime(config, 'worker');
  try {
    const handle = await runWorker({ runtime });
    if (!handle.started) {
      runtime.logger.flush();
      process.exit(0);
    }
  } catch (error) {
    runtime.logger.fatal({ err: error }, 'background worker failed to start');
    await runtime.database.disconnect().catch(() => undefined);
    runtime.logger.flush();
    process.exit(1);
  }
}

void main();
