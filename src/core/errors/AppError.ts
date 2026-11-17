import { DEFAULT_ERROR_MESSAGE, ERROR_HTTP_STATUS, type ErrorCode } from './errorCodes.js';

/** One entry of `error.details[]` (API_DOCUMENTATION.md §2.2). Sub-reasons go in `code` (R-05). */
export interface ErrorDetail {
  field?: string;
  message: string;
  code?: string;
  meta?: Record<string, unknown>;
}

export interface AppErrorOptions {
  details?: readonly ErrorDetail[];
  /** Extra response headers, e.g. `Retry-After`. */
  headers?: Readonly<Record<string, string>>;
  cause?: unknown;
}

/**
 * Typed application error. The HTTP status is derived from the canonical code so the two can
 * never disagree. Messages must be safe to show to end users.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: readonly ErrorDetail[] | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? DEFAULT_ERROR_MESSAGE[code], { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}
