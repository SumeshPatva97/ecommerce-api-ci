/**
 * CMS schemas — API_DOCUMENTATION.md §3.11 (public), §4.14 (admin). Admin bodies strict.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { BannerPlacement, CmsBlockType } from '../../generated/prisma/enums.js';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../../lib/slug.js';
import { CLOUDINARY_HOST } from './cms.content.js';

const id = z.uuid({ message: 'Must be a valid id.' });
const instant = z.iso.datetime({ offset: true });
const status = z.enum(['ACTIVE', 'INACTIVE']);
const sortOrder = z.number().int().min(0).max(1_000_000);

const cloudinaryUrl = z
  .url({ protocol: /^https$/, message: 'Must be an https URL.' })
  .max(500)
  .refine((v) => new URL(v).hostname === CLOUDINARY_HOST, 'Images must be Cloudinary URLs.');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, 'Use lowercase letters, digits and single hyphens.');

export const IdParams = {
  banner: z.object({ bannerId: id }),
  page: z.object({ pageId: id }),
  block: z.object({ blockId: id }),
};
export const PageSlugParams = z.object({ slug: slugSchema });

// ── Banners ──────────────────────────────────────────────────────────────────────────────────────

const scheduleOrder = (b: {
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
}) =>
  b.startsAt === undefined ||
  b.startsAt === null ||
  b.endsAt === undefined ||
  b.endsAt === null ||
  new Date(b.startsAt).getTime() < new Date(b.endsAt).getTime();
const scheduleIssue = { message: 'End must be after start.', path: ['endsAt'] };

const bannerFields = {
  placement: z.enum(BannerPlacement),
  title: z.string().trim().min(1).max(150).nullable(),
  desktopImageUrl: cloudinaryUrl,
  mobileImageUrl: cloudinaryUrl.nullable(),
  altText: z.string().trim().min(1).max(200),
  ctaHref: z.string().trim().min(1).max(500).nullable(),
  categoryId: id.nullable(),
  startsAt: instant.nullable(),
  endsAt: instant.nullable(),
  sortOrder,
  status,
};

export const CreateBannerBody = z
  .strictObject({
    placement: bannerFields.placement,
    title: bannerFields.title.optional(),
    desktopImageUrl: bannerFields.desktopImageUrl,
    mobileImageUrl: bannerFields.mobileImageUrl.optional(),
    altText: bannerFields.altText,
    ctaHref: bannerFields.ctaHref.optional(),
    categoryId: bannerFields.categoryId.optional(),
    startsAt: bannerFields.startsAt.optional(),
    endsAt: bannerFields.endsAt.optional(),
    sortOrder: sortOrder.default(0),
    status: status.default('ACTIVE'),
  })
  .refine(scheduleOrder, scheduleIssue);
export type CreateBannerInput = z.infer<typeof CreateBannerBody>;

export const UpdateBannerBody = z
  .strictObject({
    placement: bannerFields.placement.optional(),
    title: bannerFields.title.optional(),
    desktopImageUrl: bannerFields.desktopImageUrl.optional(),
    mobileImageUrl: bannerFields.mobileImageUrl.optional(),
    altText: bannerFields.altText.optional(),
    ctaHref: bannerFields.ctaHref.optional(),
    categoryId: bannerFields.categoryId.optional(),
    startsAt: bannerFields.startsAt.optional(),
    endsAt: bannerFields.endsAt.optional(),
    sortOrder: sortOrder.optional(),
    status: status.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update.' })
  .refine(scheduleOrder, scheduleIssue);
export type UpdateBannerInput = z.infer<typeof UpdateBannerBody>;

export const BannerListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  placement: z.enum(BannerPlacement).optional(),
  state: z.enum(['LIVE', 'SCHEDULED', 'EXPIRED', 'INACTIVE']).optional(),
});
export type BannerListQueryInput = z.infer<typeof BannerListQuery>;

export const PublicBannersQuery = z.object({
  placement: z.enum(BannerPlacement).optional(),
  categoryId: id.optional(),
});
export type PublicBannersQueryInput = z.infer<typeof PublicBannersQuery>;

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────

const seo = z.strictObject({
  title: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(320).nullable().optional(),
});
const pageType = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z_]{2,50}$/, 'Use capital letters and underscores, e.g. POLICY.');

export const CreatePageBody = z.strictObject({
  slug: slugSchema,
  title: z.string().trim().min(2).max(200),
  pageType: pageType.default('GENERIC'),
  bodyHtml: z.string().max(500_000).default(''),
  seo: seo.optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
});
export type CreatePageInput = z.infer<typeof CreatePageBody>;

export const UpdatePageBody = z
  .strictObject({
    slug: slugSchema.optional(),
    title: z.string().trim().min(2).max(200).optional(),
    pageType: pageType.optional(),
    bodyHtml: z.string().max(500_000).optional(),
    seo: seo.optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update.' });
export type UpdatePageInput = z.infer<typeof UpdatePageBody>;

export const PageListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type PageListQueryInput = z.infer<typeof PageListQuery>;

// ── Blocks ───────────────────────────────────────────────────────────────────────────────────────

const blockKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,99}$/, 'Use 2–100 lowercase letters, digits, ".", "_" or "-".');
const placement = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{2,50}$/, 'Use 2–50 lowercase letters, digits, "_" or "-".');

export const CreateBlockBody = z.strictObject({
  key: blockKey,
  type: z.enum(CmsBlockType),
  placement: placement.default('home'),
  content: z.record(z.string(), z.unknown()),
  categoryId: id.nullable().optional(),
  sortOrder: sortOrder.default(0),
  status: status.default('ACTIVE'),
});
export type CreateBlockInput = z.infer<typeof CreateBlockBody>;

export const UpdateBlockBody = z
  .strictObject({
    key: blockKey.optional(),
    type: z.enum(CmsBlockType).optional(),
    placement: placement.optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    categoryId: id.nullable().optional(),
    sortOrder: sortOrder.optional(),
    status: status.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateBlockInput = z.infer<typeof UpdateBlockBody>;

export const BlockListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  placement: placement.optional(),
  type: z.enum(CmsBlockType).optional(),
  status: status.optional(),
});
export type BlockListQueryInput = z.infer<typeof BlockListQuery>;
