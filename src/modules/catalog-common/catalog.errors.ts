/**
 * Error builders shared by the catalog-master modules (categories, brands, collections,
 * attributes) — API_DOCUMENTATION.md §2.3, §4.4. Pure.
 */
import { AppError } from '../../core/errors/AppError.js';

/** Friendly pre-check result: 409 DUPLICATE_RESOURCE with the offending field (§4.4 example). */
export function duplicateError(
  field: string,
  message: string,
  meta: Record<string, unknown> = {},
): AppError {
  return new AppError('DUPLICATE_RESOURCE', message, {
    details: [{ field, message, code: 'DUPLICATE', meta }],
  });
}

/** Delete/flag change blocked by references → 409 CONFLICT `code: IN_USE` (§4.4). */
export function inUseError(message: string, meta: Record<string, unknown> = {}): AppError {
  return new AppError('CONFLICT', message, { details: [{ message, code: 'IN_USE', meta }] });
}

export function notFoundError(entity: string): AppError {
  return new AppError('NOT_FOUND', `${entity} not found.`);
}

/** Business-rule validation failure (422) on one field with a sub-reason code. */
export function fieldError(field: string, message: string, code?: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    details: [{ field, message, ...(code === undefined ? {} : { code }) }],
  });
}
