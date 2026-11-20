/**
 * HTTP helpers shared by the catalog-master modules.
 */
import type { RequestHandler } from 'express';

/**
 * Public catalogue GETs are cacheable (API_DOCUMENTATION.md §2.5): overrides the global
 * `Cache-Control: no-store`. Express adds a weak `ETag` and answers `If-None-Match` with 304.
 */
export const publicCache: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  next();
};
