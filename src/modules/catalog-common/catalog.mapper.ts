/**
 * Row ↔ DTO helpers shared by the catalog-master modules. Pure.
 */
import type { ImageInput, MasterStatus, SeoInput } from './catalog.schemas.js';

export interface ImageDto {
  readonly url: string;
  readonly publicId: string | null;
}

export interface SeoDto {
  readonly title: string | null;
  readonly description: string | null;
}

export function toImage(url: string | null, publicId: string | null): ImageDto | null {
  return url === null ? null : { url, publicId };
}

/** Public image: the Cloudinary public id is an internal detail and is not exposed. */
export function toPublicImage(url: string | null): { url: string } | null {
  return url === null ? null : { url };
}

export function toStatus(isActive: boolean): MasterStatus {
  return isActive ? 'ACTIVE' : 'INACTIVE';
}

export function toSeo(title: string | null, description: string | null): SeoDto {
  return { title, description };
}

/** `undefined` → leave unchanged; `null` → clear; object → set both columns. */
export function imageColumns(
  input: ImageInput | undefined,
): { url: string | null; publicId: string | null } | undefined {
  if (input === undefined) return undefined;
  if (input === null) return { url: null, publicId: null };
  return { url: input.url, publicId: input.publicId };
}

export function seoColumns(input: SeoInput | undefined): {
  seoTitle?: string | null;
  seoDescription?: string | null;
} {
  if (input === undefined) return {};
  return {
    ...(input.title === undefined ? {} : { seoTitle: input.title }),
    ...(input.description === undefined ? {} : { seoDescription: input.description }),
  };
}

/** Removes `undefined` values so the object satisfies `exactOptionalPropertyTypes`. */
export function compact<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
