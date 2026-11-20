/**
 * Worker graceful shutdown (D-61, Batch 9 WP2). Injected process / exit and fake timers; no real
 * signals, no database.
 */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../../src/core/logger/logger.js';
import {
  WORKER_HARD_EXIT_MS,
  registerWorkerShutdown,
} from '../../../src/core/lifecycle/workerLifecycle.js';
import { testConfig } from '../../helpers/testApp.js';

const logger = createLogger(testConfig());

function setup(onClose: () => Promise<void>) {
  const proc = new EventEmitter();
  const exit = vi.fn();
  const close = vi.fn(onClose);
  registerWorkerShutdown({ logger, onClose: close, processLike: proc, exit });
  return { proc, exit, close };
}

describe('registerWorkerShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the approved 60-second forced-exit limit', () => {
    expect(WORKER_HARD_EXIT_MS).toBe(60_000);
  });

  it('SIGTERM: waits for cleanup (jobs + database) before exiting 0', async () => {
    let release!: () => void;
    const { proc, exit, close } = setup(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled(); // still waiting for running jobs
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second signal does not run cleanup twice', async () => {
    const { proc, exit, close } = setup(() => Promise.resolve());
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces exit 1 after 60 s when cleanup hangs, and only once', async () => {
    const { proc, exit } = setup(() => new Promise<void>(() => undefined));
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(WORKER_HARD_EXIT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when cleanup fails, or after a fatal error', async () => {
    const failing = setup(() => Promise.reject(new Error('disconnect failed')));
    failing.proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.exit).toHaveBeenCalledWith(1);

    const fatal = setup(() => Promise.resolve());
    fatal.proc.emit('uncaughtException', new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fatal.close).toHaveBeenCalledTimes(1);
    expect(fatal.exit).toHaveBeenCalledWith(1);
  });
});
