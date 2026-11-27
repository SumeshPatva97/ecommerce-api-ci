import { createHash } from 'node:crypto';

import type { RequestHandler, Response } from 'express';

/**
 * Public cacheable GETs (API_DOCUMENTATION.md §2.5): `Cache-Control` overrides the global
 * `no-store`, and the response carries an `ETag` that answers `If-None-Match` with 304.
 *
 * The ETag is computed from the payload (`data` + `meta`) only. Every envelope also carries a
 * per-request `requestId`, so Express's default ETag over the whole body would differ on every
 * response and a conditional request could never match.
 */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

const LOCALS_KEY = 'publiclyCacheable';

/** Marks the current response as publicly cacheable (use when the decision is made in a handler). */
export function markPublicCache(res: Response): void {
  res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.locals[LOCALS_KEY] = true;
}

/** Route middleware form of {@link markPublicCache}. */
export const publicCache: RequestHandler = (_req, res, next) => {
  markPublicCache(res);
  next();
};

export function isPubliclyCacheable(res: Response): boolean {
  const value: unknown = (res.locals as Record<string, unknown> | undefined)?.[LOCALS_KEY];
  return value === true;
}

/** Weak ETag over a JSON payload: `W/"<byte length, hex>-<SHA-256, 27 base64url chars>"`. */
export function payloadEtag(payload: unknown): string {
  const json = JSON.stringify(payload);
  const digest = createHash('sha256').update(json).digest('base64url').slice(0, 27);
  return `W/"${Buffer.byteLength(json).toString(16)}-${digest}"`;
}
