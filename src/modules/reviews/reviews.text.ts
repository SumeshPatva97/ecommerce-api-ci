/**
 * Plain-text review content — API_DOCUMENTATION.md §3.7 ("plain text, HTML stripped"). Pure.
 * Tags (and the content of script/style-like elements) are removed with `sanitize-html` using an
 * empty allow-list; basic entities are decoded so the stored text is what the customer typed.
 * Clients must still render it as text (never as HTML).
 */
import sanitize from 'sanitize-html';

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function toPlainText(input: string): string {
  const stripped = sanitize(input, { allowedTags: [], allowedAttributes: {} });
  return (
    stripped
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
      // Strip control characters (except tab/newline/carriage return) — intentional.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}
