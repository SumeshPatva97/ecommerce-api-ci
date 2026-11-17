import type { RequestHandler } from 'express';

import { AppError } from '../errors/AppError.js';

/** Unmatched routes → canonical 404 envelope. */
export function notFound(): RequestHandler {
  return (_req, _res, next) => {
    next(new AppError('NOT_FOUND', 'Route not found.'));
  };
}
