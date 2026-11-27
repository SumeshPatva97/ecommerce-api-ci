/**
 * HTTP helpers shared by the catalog-master modules.
 */

/**
 * Public catalogue GETs are cacheable (API_DOCUMENTATION.md §2.5): overrides the global
 * `Cache-Control: no-store` and makes `ok()` send a payload-based `ETag`, so `If-None-Match`
 * is answered with 304 (see `core/http/publicCache.ts`).
 */
export { publicCache } from '../../core/http/publicCache.js';
