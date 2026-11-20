/**
 * Server-side rich-text sanitising — SECURITY_GUIDELINES.md §5 (binding allowlist), used for product
 * descriptions and CMS pages/blocks on save. Library: `sanitize-html` (named in the guideline).
 *
 * Allowed tags: p, h2–h4, ul, ol, li, strong, em, a, br, blockquote, table, thead, tbody, tr, th, td, img.
 * Attributes: `href` (http/https/mailto only), `src` (Cloudinary only), `alt`, `title`.
 * Links get `rel="noopener noreferrer"`; `target` is not allowed. Everything else (style, on*,
 * iframe, script, svg, form, …) is stripped. The frontends sanitise again on render.
 */
import sanitize from 'sanitize-html';

const CLOUDINARY_HOST = 'res.cloudinary.com';

const OPTIONS: sanitize.IOptions = {
  allowedTags: [
    'p',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'a',
    'br',
    'blockquote',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'img',
  ],
  allowedAttributes: { a: ['href', 'title', 'rel'], img: ['src', 'alt', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'noscript',
    'iframe',
    'svg',
    'math',
    'form',
  ],
  transformTags: {
    a: sanitize.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
  exclusiveFilter: (frame) => {
    if (frame.tag !== 'img') return false;
    const src = frame.attribs.src;
    if (src === undefined) return true;
    try {
      return new URL(src).hostname !== CLOUDINARY_HOST;
    } catch {
      return true;
    }
  },
};

export function sanitizeRichText(input: string): string {
  return sanitize(input, OPTIONS);
}
