/**
 * Declared success statuses per route (RD-13 option B, approved 2026-11-20).
 *
 *   router.post('/brands', requirePermission('brands.create'), validate(…), respondsWith(201), ctl.create)
 *
 * - The OpenAPI generator reads the marker (`SUCCESS_STATUS`) and documents exactly these statuses
 *   (default: 200 when a route has no marker).
 * - `ok()` checks the status it sends against the declaration. In the TEST environment a mismatch
 *   throws, so every route test also proves the documentation matches the real status code. In
 *   other environments nothing changes at runtime (no default status, no throw).
 */
import type { RequestHandler, Response } from 'express';

export const SUCCESS_STATUS = Symbol.for('ecommerce.successStatus');

export type SuccessStatusCode = 200 | 201 | 202;

const LOCALS_KEY = 'declaredSuccessStatuses';

/** Marker middleware: declares the success status(es) this route can answer with. */
export function respondsWith(
  ...statuses: [SuccessStatusCode, ...SuccessStatusCode[]]
): RequestHandler & { readonly [SUCCESS_STATUS]: readonly SuccessStatusCode[] } {
  const declared: readonly SuccessStatusCode[] = Object.freeze([...statuses]);
  const handler: RequestHandler = (_req, res, next) => {
    res.locals[LOCALS_KEY] = declared;
    next();
  };
  return Object.assign(handler, { [SUCCESS_STATUS]: declared });
}

/** Statuses declared for the current request's route (`[200]` when undeclared). */
export function declaredSuccessStatuses(res: Response): readonly number[] {
  const value: unknown = (res.locals as Record<string, unknown> | undefined)?.[LOCALS_KEY];
  return Array.isArray(value) ? (value as number[]) : [200];
}

/**
 * Throws (test environment only) when a handler sends a success status its route did not declare.
 */
export function assertDeclaredSuccessStatus(res: Response, status: number, route: string): void {
  if (process.env.NODE_ENV !== 'test') return;
  const declared = declaredSuccessStatuses(res);
  if (!declared.includes(status)) {
    throw new Error(
      `Route ${route} answered ${String(status)} but declares ${declared.join('/')}: ` +
        'add or fix respondsWith(...) so the OpenAPI document stays correct (RD-13).',
    );
  }
}
