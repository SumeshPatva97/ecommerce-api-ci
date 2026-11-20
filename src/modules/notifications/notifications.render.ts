/**
 * Template rendering — NOTIFICATION_WORKFLOWS.md §9 ("templates rendered with auto-escaping;
 * variables never inserted as raw HTML"), §10 (allow-listed variables per event). Pure.
 *
 * Syntax: `{{name}}` (email) and `{{1}}` positional (WhatsApp). Values are HTML-escaped in bodies;
 * variables whose name ends in `Url` must be absolute http(s) URLs or render empty (no
 * `javascript:` links); subjects are single-line (CR/LF removed — header-injection guard).
 */
import sanitize from 'sanitize-html';

export type TemplateValue = string | number | boolean | null;
export type TemplateVariables = Readonly<Record<string, TemplateValue>>;

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*|\d{1,2})\s*\}\}/g;

/** Placeholder names used in a template string (deduplicated, in order of appearance). */
export function extractPlaceholders(template: string): string[] {
  const out = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) if (match[1] !== undefined) out.add(match[1]);
  return [...out];
}

/** Placeholders not in `allowed` (positional `{{n}}` are WhatsApp-only and never allowed here). */
export function unknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return extractPlaceholders(template).filter((name) => !set.has(name));
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringValue(name: string, value: TemplateValue | undefined): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (/url$/i.test(name) && !/^https?:\/\/[^\s"'<>]+$/i.test(text)) return '';
  return text;
}

export type RenderMode = 'html' | 'text' | 'subject';

export function renderTemplate(
  template: string,
  variables: TemplateVariables,
  mode: RenderMode,
): string {
  const rendered = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = stringValue(name, variables[name]);
    return mode === 'html' ? escapeHtml(value) : value;
  });
  return mode === 'subject' ? rendered.replace(/[\r\n]+/g, ' ').trim() : rendered;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Plain-text alternative of a rendered HTML body (tags removed, basic entities decoded). */
export function htmlToText(html: string): string {
  const stripped = sanitize(html.replace(/<(br|\/p|\/li|\/h[2-4])\s*\/?>/gi, '\n$&'), {
    allowedTags: [],
    allowedAttributes: {},
  });
  return stripped
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Ordered WhatsApp parameters `{ "1": …, "2": … }` from the template's variable order. */
export function whatsappParameters(
  order: readonly string[],
  variables: TemplateVariables,
): Record<string, string> {
  const out: Record<string, string> = {};
  order.forEach((name, index) => {
    out[String(index + 1)] = stringValue(name, variables[name]);
  });
  return out;
}
