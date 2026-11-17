import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Readiness } from '../../src/core/health/readiness.js';
import { buildTestApp } from '../helpers/testApp.js';

describe('health endpoints', () => {
  it('GET /health/live returns 200 ok without dependency checks', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^req_/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /health/ready returns 200 with the check map', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: {} });
  });

  it('GET /health/ready returns 503 with failing check names only (no internals)', async () => {
    const readiness = new Readiness();
    readiness.register('db', () => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:3306')));
    const { app } = buildTestApp({ readiness });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toEqual({ status: 'not_ready', checks: { db: 'fail' } });
    expect(JSON.stringify(res.body)).not.toContain('10.1.2.3');
  });

  it('GET /health/ready returns 503 while shutting down', async () => {
    const { app, readiness } = buildTestApp();
    readiness.markShuttingDown();
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: {}, shuttingDown: true });
  });

  it('health endpoints are not rate limited', async () => {
    const { app } = buildTestApp({ env: { RATE_LIMIT_DEFAULT_PER_MIN: '1' } });
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
    }
  });
});
