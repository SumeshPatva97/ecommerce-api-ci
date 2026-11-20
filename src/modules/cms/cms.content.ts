/**
 * CMS content safety — SECURITY_GUIDELINES.md §5 (rich text sanitised server-side with the binding
 * allow-list, `sanitizeRichText`), NOTIFICATION/SECURITY "no open redirects". Pure.
 *
 * - Links (`href`, `url`, `link`, `*Href`, `*Url`, `*Link`) must be a site-relative path (`/…`, not
 *   `//…`) or an absolute https URL on an allow-listed host; images additionally must be https.
 * - Block `content` JSON: every string under a key named `html` / `*Html` is sanitised; other
 *   strings are capped; depth, item count and total size are bounded.
 */
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import type { CmsBlockType } from '../../generated/prisma/enums.js';
import { sanitizeRichText } from '../../lib/sanitizeHtml.js';

export const CLOUDINARY_HOST = 'res.cloudinary.com';
const MAX_DEPTH = 8;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_PLAIN_STRING = 5_000;
const MAX_HTML_STRING = 100_000;

/** Site-relative path or https URL on one of `allowedHosts`. */
export function isAllowedHref(value: string, allowedHosts: ReadonlySet<string>): boolean {
  if (/^\/(?!\/)[^\s\\]*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const LINK_KEY = /^(href|url|link)$|(Href|Url|Link)$/;
const IMAGE_KEY = /^(image|src)$|(Image|ImageUrl|Src)$/;
const HTML_KEY = /^html$|Html$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates and sanitises block content; returns the cleaned JSON or throws 422 with paths
 * (`content.items[2].href`).
 */
export function prepareBlockContent(
  type: CmsBlockType,
  content: unknown,
  allowedHosts: ReadonlySet<string>,
): Record<string, unknown> {
  const details: ErrorDetail[] = [];
  if (!isPlainObject(content)) {
    throw new AppError('VALIDATION_ERROR', 'Block content must be an object.', {
      details: [{ field: 'content', message: 'Must be a JSON object.' }],
    });
  }
  const linkHosts = new Set([...allowedHosts, CLOUDINARY_HOST]);

  const walk = (value: unknown, path: string, key: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      details.push({ field: path, message: 'Content is nested too deeply.' });
      return null;
    }
    if (typeof value === 'string') {
      if (HTML_KEY.test(key)) {
        if (value.length > MAX_HTML_STRING) details.push({ field: path, message: 'Too long.' });
        return sanitizeRichText(value);
      }
      if (value.length > MAX_PLAIN_STRING) details.push({ field: path, message: 'Too long.' });
      if (IMAGE_KEY.test(key) && value !== '') {
        try {
          if (new URL(value).protocol !== 'https:') throw new Error('not https');
        } catch {
          details.push({ field: path, message: 'Images must be https URLs.', code: 'INVALID_URL' });
        }
      } else if (LINK_KEY.test(key) && value !== '' && !isAllowedHref(value, linkHosts)) {
        details.push({
          field: path,
          message: 'Links must be site-relative paths or allow-listed https URLs.',
          code: 'INVALID_URL',
        });
      }
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
      if (value.length > 200) details.push({ field: path, message: 'Too many items.' });
      return value.slice(0, 200).map((v, i) => walk(v, `${path}[${String(i)}]`, key, depth + 1));
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(k)) {
          details.push({ field: `${path}.${k}`, message: 'Invalid key.' });
          continue;
        }
        out[k] = walk(v, `${path}.${k}`, k, depth + 1);
      }
      return out;
    }
    details.push({ field: path, message: 'Unsupported value.' });
    return null;
  };

  const cleaned = walk(content, 'content', 'content', 0) as Record<string, unknown>;
  if (type === 'RICH_TEXT' && typeof cleaned.html !== 'string') {
    details.push({ field: 'content.html', message: 'Rich-text blocks need an `html` string.' });
  }
  if (Buffer.byteLength(JSON.stringify(cleaned), 'utf8') > MAX_CONTENT_BYTES) {
    details.push({ field: 'content', message: 'Content is larger than 64 KB.' });
  }
  if (details.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'The block content is invalid.', { details });
  }
  return cleaned;
}
