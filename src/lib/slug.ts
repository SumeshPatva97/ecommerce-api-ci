/**
 * Slugs — PROJECT_CONTEXT.md §3.5: lower, non-alphanumerics → `-`, collapse repeats, trim `-`,
 * max 160. Diacritics are stripped (NFKD) before the replacement. Pure.
 */
export const SLUG_MAX_LENGTH = 160;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

/** `base`, `base-2`, `base-3`… — first candidate for which `isTaken` returns false. */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  maxAttempts = 50,
): Promise<string> {
  const root = slugify(base) || 'item';
  for (let i = 1; i <= maxAttempts; i += 1) {
    const suffix = i === 1 ? '' : `-${i}`;
    const candidate = `${root.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('Could not allocate a unique slug.');
}
