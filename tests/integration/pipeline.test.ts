import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../../src/core/errors/AppError.js';
import { ok } from '../../src/core/http/envelope.js';
import { PAGE_LIMITS, paginationQuery } from '../../src/core/http/pagination.js';
import { getValidated, validate } from '../../src/core/middleware/validate.js';
import { ADMIN_ORIGIN, STOREFRONT_ORIGIN, buildTestApp } from '../helpers/testApp.js';

/** Test-only routes mounted through the real middleware pipeline under /api/v1. */
function fixtureRouter(): Router {
  const router = Router();

  const params = z.object({ itemId: z.uuid() });
  const query = paginationQuery(PAGE_LIMITS.adminList);
  const body = z.strictObject({ name: z.string().trim().min(2).max(60) });

  router.post('/fixtures/:itemId', validate({ params, query, body }), (req, res) => {
    ok(req, res, {
      params: getValidated(req, 'params', params),
      query: getValidated(req, 'query', query),
      body: getValidated(req, 'body', body),
    });
  });
  router.get('/fixtures-no-validate', (req) => {
    getValidated(req, 'query', query); // throws: validate() missing
  });
  router.get('/fixtures/conflict', () => {
    throw new AppError('INVALID_STATE_TRANSITION', 'Cannot cancel a shipped order.', {
      details: [{ field: 'status', message: 'Order is SHIPPED.', code: 'ALREADY_SHIPPED' }],
    });
  });
  router.get('/fixtures/boom', () => {
    throw new Error('mysql://root:hunter2@db.internal:3306 is unreachable');
  });
  router.get('/fixtures/async-boom', async () => {
    await Promise.resolve();
    throw new Error('async failure with internal detail');
  });
  router.get('/admin/fixtures', (req, res) => {
    ok(req, res, { admin: true });
  });
  router.get('/fixtures', (req, res) => {
    ok(req, res, { hello: 'world' });
  });
  return router;
}

const ITEM_ID = '3f2b8c1e-5d4a-4b6f-9a7e-2c1d0e9f8a7b';

describe('request id', () => {
  it('generates req_<ULID> and returns the same id in header and envelope', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/unknown');
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a well-formed inbound X-Request-Id and replaces a malformed one', async () => {
    const { app } = buildTestApp();
    const good = await request(app).get('/health/live').set('X-Request-Id', 'client-abc_123');
    expect(good.headers['x-request-id']).toBe('client-abc_123');
    const bad = await request(app).get('/health/live').set('X-Request-Id', 'bad id<script>');
    expect(bad.headers['x-request-id']).toMatch(/^req_/);
  });
});

describe('404 handling', () => {
  it.each(['/api/v1/does-not-exist', '/nowhere'])(
    '%s returns the canonical 404 envelope',
    async (path) => {
      const { app } = buildTestApp();
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Route not found.' },
        requestId: res.headers['x-request-id'],
      });
    },
  );
});

describe('security headers', () => {
  it('sets the JSON-API helmet profile and no X-Powered-By', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/unknown');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS (without preload) in production', async () => {
    const { app } = buildTestApp({
      env: {
        NODE_ENV: 'production',
        API_BASE_URL: 'https://api.example.com',
        STOREFRONT_URL: 'https://www.example.com',
        ADMIN_URL: 'https://admin.example.com',
        CORS_ORIGINS: 'https://www.example.com,https://admin.example.com',
      },
    });
    const res = await request(app).get('/health/live');
    expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  });
});

describe('CORS', () => {
  it('allows a listed origin with credentials and exposes X-Request-Id', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get('/api/v1/fixtures').set('Origin', STOREFRONT_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(STOREFRONT_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    // Exact list from CROSS_APPLICATION_INTEGRATION.md §3.2
    expect(res.headers['access-control-expose-headers']).toBe(
      'X-Request-Id,ETag,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset,Retry-After,' +
        'Idempotent-Replayed,Deprecation,Sunset,Link,Content-Disposition,X-API-Version',
    );
    expect(res.headers.vary).toContain('Origin');
  });

  it('answers preflight with allowed headers and a 600 s max-age', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app)
      .options('/api/v1/fixtures')
      .set('Origin', STOREFRONT_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, Idempotency-Key');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Authorization,Content-Type,Idempotency-Key,X-Request-Id,X-Client,If-None-Match',
    );
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
  });

  it('rejects an unlisted origin with 403 FORBIDDEN and no CORS headers', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get('/api/v1/fixtures').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts only the admin origin on /api/v1/admin/*', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const fromStorefront = await request(app)
      .get('/api/v1/admin/fixtures')
      .set('Origin', STOREFRONT_ORIGIN);
    expect(fromStorefront.status).toBe(403);
    const fromAdmin = await request(app).get('/api/v1/admin/fixtures').set('Origin', ADMIN_ORIGIN);
    expect(fromAdmin.status).toBe(200);
    expect(fromAdmin.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
  });

  it('rejects the admin origin on customer/public routes (route-family restriction)', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get('/api/v1/fixtures').set('Origin', ADMIN_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not block requests without an Origin header', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get('/api/v1/fixtures');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { hello: 'world' },
      requestId: res.headers['x-request-id'],
    });
  });
});

describe('CORS admin route family is case-insensitive (review D1)', () => {
  // Express routing is case-insensitive: every one of these paths reaches the admin fixture route.
  const ADMIN_PATHS = [
    ['lowercase', '/api/v1/admin/fixtures'],
    ['uppercase', '/API/V1/ADMIN/fixtures'],
    ['mixed-case', '/api/v1/Admin/fixtures'],
    ['mixed-case prefix', '/Api/V1/aDmIn/fixtures'],
  ] as const;

  it.each(ADMIN_PATHS)(
    'storefront origin + %s admin path → 403, no CORS headers',
    async (_l, path) => {
      const { app } = buildTestApp({ v1Router: fixtureRouter() });
      const res = await request(app).get(path).set('Origin', STOREFRONT_ORIGIN);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.body.data).toBeUndefined(); // the admin handler never ran
    },
  );

  it.each(ADMIN_PATHS)('admin origin + %s admin path → allowed', async (_l, path) => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get(path).set('Origin', ADMIN_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ admin: true });
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
  });

  it.each([
    ['lowercase', '/api/v1/admin'],
    ['uppercase', '/API/V1/ADMIN'],
  ])('storefront origin + bare %s admin prefix → 403', async (_l, path) => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get(path).set('Origin', STOREFRONT_ORIGIN);
    expect(res.status).toBe(403);
  });

  it('storefront origin preflight to an uppercase admin path → 403 without CORS headers', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app)
      .options('/API/V1/ADMIN/fixtures')
      .set('Origin', STOREFRONT_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    ['lowercase', '/api/v1/fixtures'],
    ['uppercase', '/API/V1/FIXTURES'],
  ])(
    'customer route (%s) still rejects the admin origin and accepts the storefront',
    async (_l, path) => {
      const { app } = buildTestApp({ v1Router: fixtureRouter() });
      const fromAdmin = await request(app).get(path).set('Origin', ADMIN_ORIGIN);
      expect(fromAdmin.status).toBe(403);
      expect(fromAdmin.headers['access-control-allow-origin']).toBeUndefined();
      const fromStorefront = await request(app).get(path).set('Origin', STOREFRONT_ORIGIN);
      expect(fromStorefront.status).toBe(200);
    },
  );

  it('paths that merely start with "admin" text are not treated as admin routes', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get('/api/v1/administrators').set('Origin', ADMIN_ORIGIN);
    expect(res.status).toBe(403); // customer family → admin origin rejected
  });
});

describe('request body handling', () => {
  it('rejects malformed JSON with 400 BAD_REQUEST', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app)
      .post(`/api/v1/fixtures/${ITEM_ID}`)
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'BAD_REQUEST', message: 'Malformed JSON body.' });
  });

  it('rejects non-JSON bodies with 400 BAD_REQUEST', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app)
      .post(`/api/v1/fixtures/${ITEM_ID}`)
      .set('Content-Type', 'text/plain')
      .send('name=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Content-Type must be application/json.');
  });

  it('rejects bodies over the limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter(), env: { REQUEST_BODY_LIMIT: '1kb' } });
    const res = await request(app)
      .post(`/api/v1/fixtures/${ITEM_ID}`)
      .send({ name: 'x'.repeat(2048) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('validation', () => {
  it('returns parsed, trimmed, defaulted input on success', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app)
      .post(`/api/v1/fixtures/${ITEM_ID}?page=2`)
      .send({ name: '  Gold Ring  ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      params: { itemId: ITEM_ID },
      query: { page: 2, limit: 25 },
      body: { name: 'Gold Ring' },
    });
  });

  it('collects params, query and body issues into one 422 VALIDATION_ERROR', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app)
      .post('/api/v1/fixtures/not-a-uuid?limit=500')
      .send({ name: 'x', isSuperadmin: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('One or more fields are invalid.');
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['itemId', 'limit', 'name']));
    // strictObject rejects mass-assignment attempts (SECURITY_GUIDELINES.md §5)
    expect(JSON.stringify(res.body.error.details)).toContain('isSuperadmin');
  });

  it('getValidated without validate() is a programming error → 500', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get('/api/v1/fixtures-no-validate');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('error handling', () => {
  it('renders AppError with its canonical status and details', async () => {
    const { app } = buildTestApp({ v1Router: fixtureRouter() });
    const res = await request(app).get('/api/v1/fixtures/conflict');
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'INVALID_STATE_TRANSITION',
      message: 'Cannot cancel a shipped order.',
      details: [{ field: 'status', message: 'Order is SHIPPED.', code: 'ALREADY_SHIPPED' }],
    });
  });

  it.each(['/api/v1/fixtures/boom', '/api/v1/fixtures/async-boom'])(
    '%s → generic 500 without leaking internals',
    async (path) => {
      const { app } = buildTestApp({ v1Router: fixtureRouter() });
      const res = await request(app).get(path);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
        requestId: res.headers['x-request-id'],
      });
      expect(res.text).not.toContain('hunter2');
      expect(res.text).not.toContain('internal detail');
      expect(res.text).not.toContain('stack');
    },
  );
});

describe('rate limiting', () => {
  it('returns 429 RATE_LIMITED with Retry-After and RateLimit headers once exhausted', async () => {
    const { app } = buildTestApp({
      v1Router: fixtureRouter(),
      env: { RATE_LIMIT_DEFAULT_PER_MIN: '2' },
    });
    const first = await request(app).get('/api/v1/fixtures');
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    await request(app).get('/api/v1/fixtures');
    const third = await request(app).get('/api/v1/fixtures');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(third.headers['ratelimit-remaining']).toBe('0');
  });

  it('can be disabled outside production', async () => {
    const { app } = buildTestApp({
      v1Router: fixtureRouter(),
      env: { RATE_LIMIT_DEFAULT_PER_MIN: '1', RATE_LIMIT_ENABLED: 'false' },
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/v1/fixtures')).status).toBe(200);
    }
  });
});
