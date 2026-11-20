/**
 * Dedicated worker runtime (D-61, Batch 9 WP3/WP4) and the API process boundary. MOCKED database
 * (no connection), injected process / exit, fake timers. Proves process wiring only; it does NOT prove
 * real signal delivery, MySQL behaviour or multi-process safety.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { warnIfJobsEnabledForApi, type ProcessRuntime } from '../../src/bootstrap.js';
import type { Database } from '../../src/core/db/prisma.js';
import { createLogger } from '../../src/core/logger/logger.js';
import type { ScheduledJob } from '../../src/jobs/scheduler.js';
import { runWorker } from '../../src/workerRuntime.js';
import { buildModuleTestApp } from '../helpers/container.js';
import { testConfig } from '../helpers/testApp.js';

const REGISTERED_JOBS = [
  'reservation-expiry',
  'unpaid-order-cancel',
  'notification-dispatch',
  'payment-reconciliation',
  'shipment-tracking-poll',
  'promotion-activation',
  'best-seller-refresh',
  'rating-aggregate',
  'abandoned-carts',
  'token-cleanup',
];

function setup(jobsEnabled: boolean) {
  const t = buildModuleTestApp([], { env: { JOBS_ENABLED: jobsEnabled ? 'true' : 'false' } });
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(testConfig({ LOG_LEVEL: 'info' }), {
    write: (msg: string) => {
      lines.push(JSON.parse(msg) as Record<string, unknown>);
    },
  });
  const database = {
    client: t.container.db,
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
    ping: vi.fn(() => Promise.resolve()),
  };
  const runtime = {
    config: t.container.config,
    logger,
    database: database as unknown as Database,
    container: t.container,
  } satisfies ProcessRuntime;
  const proc = new EventEmitter();
  const exit = vi.fn();
  const messages = () => lines.map((l) => String(l.msg));
  return { runtime, database, proc, exit, messages };
}

describe('dedicated worker runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('JOBS_ENABLED=false: logs that jobs are disabled and starts/connects nothing', async () => {
    const { runtime, database, messages } = setup(false);
    const buildJobs = vi.fn(() => []);
    const handle = await runWorker({ runtime, buildJobs });
    expect(handle.started).toBe(false);
    expect(buildJobs).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
    expect(messages().some((m) => m.includes('JOBS_ENABLED is not true'))).toBe(true);
  });

  it('JOBS_ENABLED=true: registers all 10 jobs exactly once, never listens on a port, logs start + heartbeat', async () => {
    const listen = vi.spyOn(net.Server.prototype, 'listen');
    const { runtime, database, proc, exit, messages } = setup(true);
    const handle = await runWorker({ runtime, processLike: proc, exit, heartbeatMs: 60_000 });
    expect(handle.started).toBe(true);
    expect(handle.jobs).toEqual(REGISTERED_JOBS);
    expect(new Set(handle.jobs).size).toBe(10);
    expect(database.connect).toHaveBeenCalledTimes(1);
    expect(messages().some((m) => m.includes('exactly ONE worker process'))).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages().filter((m) => m === 'worker heartbeat').length).toBeGreaterThanOrEqual(1);
    expect(listen).not.toHaveBeenCalled();
    handle.shutdown('test', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(database.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('SIGTERM waits for the running job (which sees the stop signal), then disconnects, then exits 0', async () => {
    const { runtime, database, proc, exit } = setup(true);
    let release!: () => void;
    let sawStop = false;
    const job: ScheduledJob = {
      name: 'long-job',
      intervalMs: 1000,
      run: async (signal) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        sawStop = signal.aborted;
      },
    };
    const handle = await runWorker({ runtime, buildJobs: () => [job], processLike: proc, exit });
    await vi.advanceTimersByTimeAsync(1000); // job is now running
    proc.emit('SIGTERM');
    proc.emit('SIGTERM'); // second signal: ignored
    await vi.advanceTimersByTimeAsync(5000);
    expect(database.disconnect).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sawStop).toBe(true);
    expect(database.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(handle.started).toBe(true);
  });

  it('keeps running when the database is unreachable at start (job runs fail and are retried)', async () => {
    const { runtime, database, proc, exit, messages } = setup(true);
    database.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const handle = await runWorker({ runtime, buildJobs: () => [], processLike: proc, exit });
    expect(handle.started).toBe(true);
    expect(messages().some((m) => m.includes('database connection failed during startup'))).toBe(
      true,
    );
    handle.shutdown('test', 0);
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('API process boundary (B2)', () => {
  it('ignores JOBS_ENABLED=true with a clear warning', () => {
    const lines: string[] = [];
    const logger = createLogger(testConfig({ LOG_LEVEL: 'info' }), {
      write: (msg: string) => {
        lines.push(msg);
      },
    });
    expect(warnIfJobsEnabledForApi({ jobs: { enabled: false } }, logger)).toBe(false);
    expect(lines).toHaveLength(0);
    expect(warnIfJobsEnabledForApi({ jobs: { enabled: true } }, logger)).toBe(true);
    expect(lines.join('')).toContain('ignored by the API process');
  });

  it('the API entrypoint never builds or starts the job scheduler; the worker never builds the HTTP app', () => {
    const server = readFileSync('src/server.ts', 'utf8');
    expect(server).not.toMatch(
      /createJobScheduler|buildScheduledJobs|jobs\/registry|jobs\/scheduler/,
    );
    expect(server).toContain('warnIfJobsEnabledForApi(config, logger)');
    for (const file of [
      'src/worker.ts',
      'src/workerRuntime.ts',
      'src/core/lifecycle/workerLifecycle.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from '\.\/app\.js'|from 'express'|startHttpServer\(/);
    }
  });
});
