import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { Readiness } from '../../src/core/health/readiness.js';
import { createLogger } from '../../src/core/logger/logger.js';
import { testConfig } from '../helpers/testApp.js';

/** Real app + logger writing to an in-memory stream: checks what the access log contains. */
function appWithCapturedLogs() {
  const lines: string[] = [];
  const config = testConfig({ LOG_LEVEL: 'info' });
  const logger = createLogger(config, { write: (chunk: string) => lines.push(chunk) });
  const router = Router();
  router.post('/echo', (_req, res) => {
    res.json({ ok: true });
  });
  router.get('/boom', () => {
    throw new Error('internal failure detail');
  });
  const app = createApp({ config, logger, readiness: new Readiness(), v1Router: router });
  const records = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { app, lines, records };
}

describe('access log never contains credentials, query strings or bodies', () => {
  it('logs method, path, status and requestId only', async () => {
    const { app, lines, records } = appWithCapturedLogs();
    const res = await request(app)
      .post('/api/v1/echo?email=user@example.test&token=SECRET-QUERY-TOKEN')
      .set('Authorization', 'Bearer SECRET-ACCESS-TOKEN')
      .set('Cookie', 'sf_rt=SECRET-REFRESH-COOKIE')
      .send({ email: 'user@example.test', password: 'SECRET-BODY-PASSWORD' });
    expect(res.status).toBe(200);

    const out = lines.join('');
    expect(out).not.toContain('SECRET-'); // no header, cookie, query or body secret
    expect(out).not.toContain('user@example.test'); // query string and body not logged

    const access = records().find((r) => r.msg === 'request completed') as {
      req: Record<string, unknown>;
      res: Record<string, unknown>;
      requestId: string;
    };
    expect(access.req).toEqual({ method: 'POST', path: '/api/v1/echo', userAgent: undefined });
    expect(access.res).toEqual({ statusCode: 200 });
    expect(access.requestId).toBe(res.headers['x-request-id']);
  });

  it('health probes are not access-logged', async () => {
    const { app, lines } = appWithCapturedLogs();
    await request(app).get('/health/live');
    await request(app).get('/health/ready');
    expect(lines).toHaveLength(0);
  });

  it('unexpected errors are logged server-side with the requestId, never returned to the client', async () => {
    const { app, records } = appWithCapturedLogs();
    const res = await request(app).get('/api/v1/boom');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('internal failure detail');
    const errorLog = records().find((r) => r.msg === 'unhandled error') as {
      err: { message: string };
      requestId: string;
    };
    expect(errorLog.err.message).toBe('internal failure detail');
    expect(errorLog.requestId).toBe(res.headers['x-request-id']);
  });
});
