import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';

import { AppError, type ErrorDetail } from '../errors/AppError.js';

type Location = 'params' | 'query' | 'body';
export type ValidationSchemas = Partial<Record<Location, z.ZodType>>;

/** `['variants', 2, 'sku']` → `variants[2].sku` (API_DOCUMENTATION.md §2.2). */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

export function zodIssuesToDetails(issues: readonly z.core.$ZodIssue[]): ErrorDetail[] {
  return issues.map((issue) => {
    const field = formatIssuePath(issue.path);
    return field === '' ? { message: issue.message } : { field, message: issue.message };
  });
}

/**
 * Stage 9 (BACKEND_STRUCTURE.md §5.1): Zod-validates params, query and body. All failures are
 * collected into one `422 VALIDATION_ERROR`. Parsed output (after trims/defaults/transforms) is
 * stored on `req.validated`; `req.body` is replaced so unvalidated keys cannot be used later.
 *
 * Whether unknown keys are rejected is decided by each schema (`z.strictObject` / `.strict()`);
 * SECURITY_GUIDELINES.md §5 asks for strict schemas on security-sensitive and admin bodies.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const validated: NonNullable<Request['validated']> = {};

    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (schema === undefined) continue;
      const input: unknown = location === 'body' ? (req.body ?? {}) : req[location];
      const result = schema.safeParse(input);
      if (result.success) validated[location] = result.data;
      else details.push(...zodIssuesToDetails(result.error.issues));
    }

    if (details.length > 0) {
      next(new AppError('VALIDATION_ERROR', undefined, { details }));
      return;
    }
    req.validated = validated;
    if (validated.body !== undefined) req.body = validated.body;
    next();
  };
}

/** Typed accessor for validated input in controllers (no re-parse). */
export function getValidated<S extends z.ZodType>(
  req: Request,
  location: Location,
  _schema: S,
): z.output<S> {
  if (req.validated?.[location] === undefined) {
    throw new Error(`No validated ${location} on request; is validate() missing from the route?`);
  }
  return req.validated[location] as z.output<S>;
}
