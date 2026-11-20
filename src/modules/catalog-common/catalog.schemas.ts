/**
 * Zod building blocks shared by the catalog-master modules — API_DOCUMENTATION.md §2.4, §4.4;
 * PROJECT_CONTEXT.md §3.5. Admin bodies are strict (SECURITY_GUIDELINES.md §5). No I/O.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../../lib/slug.js';

export const idSchema = z.uuid({ message: 'Must be a valid id.' });

export const statusSchema = z.enum(['ACTIVE', 'INACTIVE']);
export type MasterStatus = z.infer<typeof statusSchema>;

export const nameSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(2, 'Must be at least 2 characters.')
    .max(max, `Must be at most ${max} characters.`);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens.');

export const descriptionSchema = z.string().trim().max(5000).nullable();
export const sortOrderSchema = z.number().int().min(0).max(1_000_000);

/** Cloudinary asset reference (upload happens via signed direct upload, not here). */
export const imageSchema = z
  .strictObject({
    url: z.url({ protocol: /^https$/, message: 'Must be an https URL.' }).max(500),
    publicId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_\-/.]+$/, 'Invalid Cloudinary public id.'),
  })
  .nullable();
export type ImageInput = z.infer<typeof imageSchema>;

export const seoSchema = z.strictObject({
  title: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(320).nullable().optional(),
});
export type SeoInput = z.infer<typeof seoSchema>;

export const booleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

/** `ACTIVE` / `INACTIVE` / `DELETED` (soft-deleted rows, e.g. for restore). */
export const adminStatusFilter = z.enum(['ACTIVE', 'INACTIVE', 'DELETED']);
export type AdminStatusFilter = z.infer<typeof adminStatusFilter>;

/** Admin list query: pagination (default 25, max 100), `q`, `status`, whitelisted `sort`. */
export function adminListQuery(sortFields: readonly [string, ...string[]]) {
  const sortValues = [...sortFields, ...sortFields.map((f) => `-${f}`)] as [string, ...string[]];
  return paginationQuery(PAGE_LIMITS.adminList).extend({
    q: z.string().trim().min(1).max(100).optional(),
    status: adminStatusFilter.optional(),
    sort: z.enum(sortValues).optional(),
  });
}

export interface ParsedSort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export function parseSort(sort: string | undefined, fallback: string): ParsedSort {
  const value = sort ?? fallback;
  return value.startsWith('-')
    ? { field: value.slice(1), direction: 'desc' }
    : { field: value, direction: 'asc' };
}

/** Prisma `where` fragment for the admin status filter (soft-deleted rows hidden by default). */
export function statusWhere(status: AdminStatusFilter | undefined): {
  deletedAt: null | { not: null };
  isActive?: boolean;
} {
  switch (status) {
    case 'ACTIVE':
      return { deletedAt: null, isActive: true };
    case 'INACTIVE':
      return { deletedAt: null, isActive: false };
    case 'DELETED':
      return { deletedAt: { not: null } };
    case undefined:
      return { deletedAt: null };
  }
}
