import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { AppError } from '../errors/AppError.js';
import { buildErrorEnvelope } from '../http/envelope.js';
import type { Logger } from '../logger/logger.js';
import { zodIssuesToDetails } from './validate.js';

interface BodyParserError {
  type: string;
}

function isBodyParserError(value: unknown): value is BodyParserError {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

/** Maps any thrown value to an `AppError` (BACKEND_STRUCTURE.md §21). */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError('VALIDATION_ERROR', undefined, {
      details: zodIssuesToDetails(error.issues),
      cause: error,
    });
  }
  if (isBodyParserError(error)) {
    switch (error.type) {
      case 'entity.too.large':
        return new AppError('PAYLOAD_TOO_LARGE', undefined, { cause: error });
      case 'entity.parse.failed':
        return new AppError('BAD_REQUEST', 'Malformed JSON body.', { cause: error });
      case 'encoding.unsupported':
      case 'charset.unsupported':
      case 'request.aborted':
      case 'request.size.invalid':
        return new AppError('BAD_REQUEST', undefined, { cause: error });
      default:
        break;
    }
  }
  // Prisma error mapping (P2002/P2003/P2025/P2034) is added with the database increment.
  return new AppError('INTERNAL_ERROR', undefined, { cause: error });
}

/**
 * Final error middleware: canonical error envelope, never leaks stack traces or internal
 * messages to clients. Unexpected errors (5xx) are logged with their stack.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const appError = toAppError(error);

    if (appError.httpStatus >= 500) {
      logger.error({ err: error, path: req.path, method: req.method }, 'unhandled error');
    }

    if (appError.headers) {
      for (const [name, value] of Object.entries(appError.headers)) res.setHeader(name, value);
    }
    res
      .status(appError.httpStatus)
      .json(buildErrorEnvelope(req.requestId, appError.code, appError.message, appError.details));
  };
}
