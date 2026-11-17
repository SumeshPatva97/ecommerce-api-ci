/**
 * Canonical error codes → HTTP status (PROJECT_CONTEXT.md §8, API_DOCUMENTATION.md §2.3).
 * Do not add codes here without first adding them to PROJECT_CONTEXT.md.
 */
export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 422,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  PERMISSION_DENIED: 403,
  REAUTH_REQUIRED: 403,
  NOT_FOUND: 404,
  DUPLICATE_RESOURCE: 409,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  INSUFFICIENT_STOCK: 409,
  COUPON_INVALID: 422,
  PRICE_CHANGED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

/** Generic, customer-safe default messages. Services usually pass a more specific message. */
export const DEFAULT_ERROR_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'One or more fields are invalid.',
  BAD_REQUEST: 'The request could not be processed.',
  UNAUTHENTICATED: 'Authentication is required.',
  TOKEN_EXPIRED: 'Your session has expired. Please sign in again.',
  FORBIDDEN: 'You are not allowed to perform this action.',
  PERMISSION_DENIED: 'You do not have permission to perform this action.',
  REAUTH_REQUIRED: 'Please confirm your password to continue.',
  NOT_FOUND: 'The requested resource was not found.',
  DUPLICATE_RESOURCE: 'A record with the same value already exists.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  INVALID_STATE_TRANSITION: 'This action is not allowed in the current state.',
  INSUFFICIENT_STOCK: 'The requested quantity is not available.',
  COUPON_INVALID: 'The coupon cannot be applied.',
  PRICE_CHANGED: 'Prices have changed. Please review your order.',
  IDEMPOTENCY_CONFLICT: 'A request with this idempotency key is already being processed.',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  PAYLOAD_TOO_LARGE: 'The request body is too large.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Please try again later.',
};
