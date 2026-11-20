/**
 * RD-13 option B: route success-status markers and the test-time check in `ok()`.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ok } from '../../../src/core/http/envelope.js';
import {
  SUCCESS_STATUS,
  declaredSuccessStatuses,
  respondsWith,
} from '../../../src/core/http/successStatus.js';

function app() {
  const a = express();
  a.use((req, _res, next) => {
    req.requestId = 'req-1';
    next();
  });
  a.post('/declared', respondsWith(201), (req, res) => {
    ok(req, res, { id: 1 }, { status: 201 });
  });
  a.post('/either', respondsWith(200, 202), (req, res) => {
    ok(req, res, {}, { status: req.query.queued === '1' ? 202 : 200 });
  });
  a.post('/undeclared', (req, res) => {
    ok(req, res, {}, { status: 201 });
  });
  a.post('/declared-but-200', respondsWith(201), (req, res) => {
    ok(req, res, {});
  });
  a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: err.message });
  });
  return a;
}

describe('respondsWith / ok()', () => {
  it('tags the middleware for the OpenAPI generator', () => {
    expect(respondsWith(200, 202)[SUCCESS_STATUS]).toEqual([200, 202]);
  });

  it('allows declared statuses, including either of two', async () => {
    expect((await request(app()).post('/declared')).status).toBe(201);
    expect((await request(app()).post('/either')).status).toBe(200);
    expect((await request(app()).post('/either?queued=1')).status).toBe(202);
  });

  it('fails in tests when a handler answers an undeclared status, in both directions', async () => {
    const undeclared = await request(app()).post('/undeclared');
    expect(undeclared.status).toBe(500);
    expect(undeclared.body.message).toContain('answered 201 but declares 200');
    const wrong = await request(app()).post('/declared-but-200');
    expect(wrong.status).toBe(500);
    expect(wrong.body.message).toContain('answered 200 but declares 201');
  });

  it('defaults to 200 when nothing is declared', () => {
    expect(declaredSuccessStatuses({ locals: {} } as express.Response)).toEqual([200]);
  });
});
