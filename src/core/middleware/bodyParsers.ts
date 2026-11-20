import express, { type RequestHandler } from 'express';

import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors/AppError.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Only `application/json` bodies are accepted on JSON routes. Requests without a body pass
 * through. Webhook routes (raw body + signature) will be mounted before this middleware.
 *
 * Status mapping: SECURITY_GUIDELINES.md §5 says an unsupported media type ("415") is
 * "mapped to BAD_REQUEST". The canonical table (PROJECT_CONTEXT.md §8, which wins on conflict)
 * defines BAD_REQUEST = 400 and has no 415 code, so the response is HTTP 400 BAD_REQUEST.
 * Returning 415 would require a new canonical code in PROJECT_CONTEXT.md first.
 */
export function requireJsonContentType(): RequestHandler {
  return (req, _res, next) => {
    // A body-less action request (`Content-Length: 0`, e.g. POST …/restore) has nothing to parse;
    // type-is treats a zero length as "has body", so it is excluded explicitly.
    const emptyBody =
      req.get('content-length') === '0' && req.get('transfer-encoding') === undefined;
    if (METHODS_WITH_BODY.has(req.method) && !emptyBody && req.is('application/json') === false) {
      next(new AppError('BAD_REQUEST', 'Content-Type must be application/json.'));
      return;
    }
    next();
  };
}

/**
 * JSON parser with the default size limit (100 KB; bulk routes raise it per route).
 * Parse/size failures are mapped to canonical codes by the error handler.
 */
export function jsonBody(config: Pick<AppConfig, 'requestBodyLimit'>): RequestHandler {
  return express.json({ limit: config.requestBodyLimit, strict: true, type: 'application/json' });
}
