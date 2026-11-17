import { describe, expect, it } from 'vitest';

import { Readiness } from '../../../src/core/health/readiness.js';

describe('Readiness', () => {
  it('is ready with no registered checks', async () => {
    await expect(new Readiness().evaluate()).resolves.toEqual({
      ready: true,
      shuttingDown: false,
      checks: {},
    });
  });

  it('reports each check and is not ready when one fails', async () => {
    const readiness = new Readiness();
    readiness.register('db', () => Promise.resolve());
    readiness.register('redis', () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:6379')));
    const report = await readiness.evaluate();
    expect(report).toEqual({
      ready: false,
      shuttingDown: false,
      checks: { db: 'ok', redis: 'fail' },
    });
  });

  it('fails a check that exceeds the timeout', async () => {
    const readiness = new Readiness(20);
    readiness.register('slow', () => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(readiness.evaluate()).resolves.toMatchObject({
      ready: false,
      checks: { slow: 'fail' },
    });
  });

  it('treats a non-Error rejection as a failure', async () => {
    const readiness = new Readiness();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing defensive path
    readiness.register('weird', () => Promise.reject('nope'));
    await expect(readiness.evaluate()).resolves.toMatchObject({ checks: { weird: 'fail' } });
  });

  it('is not ready once shutting down', async () => {
    const readiness = new Readiness();
    readiness.markShuttingDown();
    expect(readiness.isShuttingDown()).toBe(true);
    await expect(readiness.evaluate()).resolves.toMatchObject({ ready: false, shuttingDown: true });
  });

  it('rejects duplicate check names', () => {
    const readiness = new Readiness();
    readiness.register('db', () => Promise.resolve());
    expect(() => {
      readiness.register('db', () => Promise.resolve());
    }).toThrow(/already registered/);
  });
});
