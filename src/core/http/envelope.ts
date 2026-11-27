import type { Request, Response } from 'express';

import type { ErrorCode } from '../errors/errorCodes.js';
import type { ErrorDetail } from '../errors/AppError.js';
import type { PageMeta } from './pagination.js';
import { isPubliclyCacheable, payloadEtag } from './publicCache.js';
import { assertDeclaredSuccessStatus } from './successStatus.js';

/**
 * Canonical response envelopes (PROJECT_CONTEXT.md §8, API_DOCUMENTATION.md §2.2).
 * Every response carries `requestId`; `204 No Content` is not used.
 */
export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: PageMeta | Record<string, unknown>;
  requestId: string;
}

export interface ErrorEnvelope {
  success: false;
  error: { code: ErrorCode; message: string; details?: readonly ErrorDetail[] };
  requestId: string;
}

export function ok<T>(
  req: Request,
  res: Response,
  data: T,
  options: { status?: number; meta?: SuccessEnvelope<T>['meta'] } = {},
): void {
  const body: SuccessEnvelope<T> = {
    success: true,
    data,
    ...(options.meta === undefined ? {} : { meta: options.meta }),
    requestId: req.requestId,
  };
  const status = options.status ?? 200;
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  assertDeclaredSuccessStatus(
    res,
    status,
    `${req.method} ${req.baseUrl}${typeof routePath === 'string' ? routePath : ''}`,
  );
  // Publicly cacheable GETs: the ETag must not depend on `requestId` (see publicCache.ts).
  // Express then compares it with `If-None-Match` and answers 304.
  if (status === 200 && isPubliclyCacheable(res)) {
    res.setHeader(
      'ETag',
      payloadEtag(options.meta === undefined ? { data } : { data, meta: options.meta }),
    );
  }
  res.status(status).json(body);
}

export function buildErrorEnvelope(
  requestId: string,
  code: ErrorCode,
  message: string,
  details?: readonly ErrorDetail[],
): ErrorEnvelope {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
    },
    requestId,
  };
}
