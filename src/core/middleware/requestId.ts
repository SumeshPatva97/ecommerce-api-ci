import type { RequestHandler } from 'express';

import { ulid } from '../../lib/ulid.js';
import { runWithRequestContext } from '../logger/context.js';

/** Accepted inbound format (BACKEND_STRUCTURE.md §5.1, API_DOCUMENTATION.md §2.5). */
export const INBOUND_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function generateRequestId(): string {
  return `req_${ulid()}`;
}

/**
 * Stage 1: accept a well-formed `X-Request-Id` or generate `req_<ULID>`; echo it on the
 * response and run the rest of the pipeline inside the request's AsyncLocalStorage context.
 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get('x-request-id');
    const id =
      inbound !== undefined && INBOUND_REQUEST_ID.test(inbound) ? inbound : generateRequestId();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    runWithRequestContext({ requestId: id }, next);
  };
}
