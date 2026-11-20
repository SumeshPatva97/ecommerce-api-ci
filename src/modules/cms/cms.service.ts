/**
 * CMS use-cases — banners, pages, blocks (API_DOCUMENTATION.md §3.11, §4.14).
 *
 * - Rich text (`bodyHtml`, block `*html`) is sanitised on save with `sanitizeRichText`
 *   (SECURITY_GUIDELINES.md §5); public responses return the stored, already-sanitised HTML.
 * - Banner CTA links: site-relative path or https on the storefront host (no open redirects).
 *   Images: Cloudinary https URLs.
 * - Public banners are filtered by schedule: `is_active AND (starts_at IS NULL OR starts_at <= now)
 *   AND (ends_at IS NULL OR ends_at > now)`. Pages are public only when `PUBLISHED` and not deleted.
 * - Schema notes: banners have no `subtitle` / `ctaLabel` / image public-id columns (public DTO
 *   returns `subtitle: null, ctaLabel: null`); banners and blocks have no `deleted_at` → hard delete
 *   (audited with a full snapshot); pages are soft-deleted (slug stays reserved).
 * - Every mutation is audited (`banners` / `cms` module). No storefront cache exists yet to bust.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Banner, CmsBlock, CmsPage, Prisma } from '../../generated/prisma/client.js';
import { sanitizeRichText } from '../../lib/sanitizeHtml.js';
import type { AuditActor } from '../audit/audit.service.js';
import { isAllowedHref, prepareBlockContent } from './cms.content.js';
import type {
  BannerListQueryInput,
  BlockListQueryInput,
  CreateBannerInput,
  CreateBlockInput,
  CreatePageInput,
  PageListQueryInput,
  PublicBannersQueryInput,
  UpdateBannerInput,
  UpdateBlockInput,
  UpdatePageInput,
} from './cms.schemas.js';

export type BannerState = 'LIVE' | 'SCHEDULED' | 'EXPIRED' | 'INACTIVE';

export function bannerState(
  row: Pick<Banner, 'isActive' | 'startsAt' | 'endsAt'>,
  now: Date,
): BannerState {
  if (!row.isActive) return 'INACTIVE';
  if (row.endsAt !== null && row.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (row.startsAt !== null && row.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'LIVE';
}

/** Prisma filter for banners visible at `now` (schedule window, active). */
export function liveBannerWhere(now: Date): Prisma.BannerWhereInput {
  return {
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ],
  };
}

function stateWhere(state: BannerState, now: Date): Prisma.BannerWhereInput {
  switch (state) {
    case 'LIVE':
      return liveBannerWhere(now);
    case 'SCHEDULED':
      return { isActive: true, startsAt: { gt: now } };
    case 'EXPIRED':
      return { isActive: true, endsAt: { lte: now } };
    case 'INACTIVE':
      return { isActive: false };
  }
}

export interface AdminBannerDto {
  readonly id: string;
  readonly placement: Banner['placement'];
  readonly title: string | null;
  readonly image: {
    readonly desktopUrl: string | null;
    readonly mobileUrl: string | null;
    readonly altText: string | null;
  };
  readonly ctaHref: string | null;
  readonly categoryId: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly sortOrder: number;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly state: BannerState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAdminBanner(row: Banner, now: Date): AdminBannerDto {
  return {
    id: row.id,
    placement: row.placement,
    title: row.title,
    image: { desktopUrl: row.desktopImageUrl, mobileUrl: row.mobileImageUrl, altText: row.altText },
    ctaHref: row.linkUrl,
    categoryId: row.categoryId,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    sortOrder: row.sortOrder,
    status: row.isActive ? 'ACTIVE' : 'INACTIVE',
    state: bannerState(row, now),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPublicBanner(row: Banner) {
  return {
    id: row.id,
    placement: row.placement,
    title: row.title,
    subtitle: null,
    image: { desktopUrl: row.desktopImageUrl, mobileUrl: row.mobileImageUrl, altText: row.altText },
    ctaLabel: null,
    ctaHref: row.linkUrl,
    sortOrder: row.sortOrder,
  };
}

export interface AdminPageDto {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly pageType: string;
  readonly status: CmsPage['status'];
  readonly bodyHtml: string;
  readonly seo: { readonly title: string | null; readonly description: string | null };
  readonly version: number;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAdminPage(row: CmsPage): AdminPageDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    pageType: row.pageType,
    status: row.status,
    bodyHtml: row.content ?? '',
    seo: { title: row.seoTitle, description: row.seoDescription },
    version: row.version,
    deleted: row.deletedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AdminBlockDto {
  readonly id: string;
  readonly key: string;
  readonly type: CmsBlock['type'];
  readonly placement: string;
  readonly content: unknown;
  readonly categoryId: string | null;
  readonly sortOrder: number;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAdminBlock(row: CmsBlock): AdminBlockDto {
  return {
    id: row.id,
    key: row.blockKey,
    type: row.type,
    placement: row.page,
    content: row.content,
    categoryId: row.categoryId,
    sortOrder: row.sortOrder,
    status: row.isActive ? 'ACTIVE' : 'INACTIVE',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notFound(entity: string): AppError {
  return new AppError('NOT_FOUND', `${entity} not found.`);
}

function fieldError(field: string, message: string, code?: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    details: [{ field, message, ...(code === undefined ? {} : { code }) }],
  });
}

function duplicate(field: string, message: string): AppError {
  return new AppError('DUPLICATE_RESOURCE', message, {
    details: [{ field, message, code: 'DUPLICATE' }],
  });
}

export function createCmsService(container: AppContainer) {
  const { db, audit, clock, config } = container;
  const allowedHosts = new Set([new URL(config.storefrontUrl).hostname.toLowerCase()]);

  function checkHref(href: string | null | undefined): void {
    if (href === null || href === undefined) return;
    if (!isAllowedHref(href, allowedHosts)) {
      throw fieldError(
        'ctaHref',
        'Use a site path such as /collections/bridal or an https link to the storefront.',
        'INVALID_URL',
      );
    }
  }

  async function checkCategory(q: Queryable, categoryId: string | null | undefined): Promise<void> {
    if (categoryId === null || categoryId === undefined) return;
    const row = await q.category.findUnique({
      where: { id: categoryId },
      select: { deletedAt: true },
    });
    if (row?.deletedAt !== null) throw fieldError('categoryId', 'Category not found.');
  }

  const date = (v: string | null | undefined): Date | null | undefined =>
    v === undefined ? undefined : v === null ? null : new Date(v);

  return {
    // ── Banners ──────────────────────────────────────────────────────────────────────────────
    async listBanners(
      query: BannerListQueryInput,
    ): Promise<{ items: AdminBannerDto[]; meta: PageMeta }> {
      const now = clock();
      const where: Prisma.BannerWhereInput = {
        ...(query.placement === undefined ? {} : { placement: query.placement }),
        ...(query.state === undefined ? {} : stateWhere(query.state, now)),
      };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.banner.findMany({
          where,
          orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
          skip,
          take,
        }),
        db.banner.count({ where }),
      ]);
      return {
        items: rows.map((r) => toAdminBanner(r, now)),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async getBanner(id: string): Promise<AdminBannerDto> {
      const row = await db.banner.findUnique({ where: { id } });
      if (row === null) throw notFound('Banner');
      return toAdminBanner(row, clock());
    },

    async createBanner(actor: AuditActor, input: CreateBannerInput): Promise<AdminBannerDto> {
      checkHref(input.ctaHref);
      return withTransaction(db, async ({ tx }) => {
        await checkCategory(tx, input.categoryId);
        const row = await tx.banner.create({
          data: {
            id: randomUUID(),
            placement: input.placement,
            title: input.title ?? null,
            desktopImageUrl: input.desktopImageUrl,
            mobileImageUrl: input.mobileImageUrl ?? null,
            altText: input.altText,
            linkUrl: input.ctaHref ?? null,
            categoryId: input.categoryId ?? null,
            startsAt: date(input.startsAt) ?? null,
            endsAt: date(input.endsAt) ?? null,
            isActive: input.status === 'ACTIVE',
            sortOrder: input.sortOrder,
          },
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: 'banners',
          entityType: 'Banner',
          entityId: row.id,
          after: { ...row },
        });
        return toAdminBanner(row, clock());
      });
    },

    async updateBanner(
      actor: AuditActor,
      id: string,
      input: UpdateBannerInput,
    ): Promise<AdminBannerDto> {
      checkHref(input.ctaHref);
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.banner.findUnique({ where: { id } });
        if (before === null) throw notFound('Banner');
        await checkCategory(tx, input.categoryId);
        const startsAt = input.startsAt === undefined ? before.startsAt : date(input.startsAt);
        const endsAt = input.endsAt === undefined ? before.endsAt : date(input.endsAt);
        if (
          startsAt !== null &&
          startsAt !== undefined &&
          endsAt !== null &&
          endsAt !== undefined &&
          endsAt.getTime() <= startsAt.getTime()
        ) {
          throw fieldError('endsAt', 'End must be after start.');
        }
        const data: Prisma.BannerUncheckedUpdateInput = {
          ...(input.placement === undefined ? {} : { placement: input.placement }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.desktopImageUrl === undefined
            ? {}
            : { desktopImageUrl: input.desktopImageUrl }),
          ...(input.mobileImageUrl === undefined ? {} : { mobileImageUrl: input.mobileImageUrl }),
          ...(input.altText === undefined ? {} : { altText: input.altText }),
          ...(input.ctaHref === undefined ? {} : { linkUrl: input.ctaHref }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...(input.startsAt === undefined ? {} : { startsAt: date(input.startsAt) ?? null }),
          ...(input.endsAt === undefined ? {} : { endsAt: date(input.endsAt) ?? null }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.status === undefined ? {} : { isActive: input.status === 'ACTIVE' }),
        };
        const after = await tx.banner.update({ where: { id }, data });
        await audit.record(tx, actor, {
          action:
            Object.keys(data).length === 1 && input.status !== undefined
              ? 'STATUS_CHANGE'
              : 'UPDATE',
          module: 'banners',
          entityType: 'Banner',
          entityId: id,
          before: { ...before },
          after: { ...after },
        });
        return toAdminBanner(after, clock());
      });
    },

    async deleteBanner(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.banner.findUnique({ where: { id } });
        if (before === null) throw notFound('Banner');
        await tx.banner.delete({ where: { id } });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: 'banners',
          entityType: 'Banner',
          entityId: id,
          before: { ...before },
          diff: false,
        });
        return { id, deleted: true as const };
      });
    },

    async publicBanners(query: PublicBannersQueryInput) {
      const rows = await db.banner.findMany({
        where: {
          ...liveBannerWhere(clock()),
          ...(query.placement === undefined ? {} : { placement: query.placement }),
          ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        take: 50,
      });
      return rows.map(toPublicBanner);
    },

    // ── Pages ────────────────────────────────────────────────────────────────────────────────
    async listPages(query: PageListQueryInput): Promise<{ items: AdminPageDto[]; meta: PageMeta }> {
      const where: Prisma.CmsPageWhereInput = {
        deletedAt: null,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.q === undefined
          ? {}
          : { OR: [{ title: { contains: query.q } }, { slug: { contains: query.q } }] }),
      };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.cmsPage.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take }),
        db.cmsPage.count({ where }),
      ]);
      return { items: rows.map(toAdminPage), meta: buildPageMeta(query.page, query.limit, total) };
    },

    async getPage(id: string): Promise<AdminPageDto> {
      const row = await db.cmsPage.findUnique({ where: { id } });
      if (row?.deletedAt !== null) throw notFound('Page');
      return toAdminPage(row);
    },

    async createPage(actor: AuditActor, input: CreatePageInput): Promise<AdminPageDto> {
      return withTransaction(db, async ({ tx }) => {
        const clash = await tx.cmsPage.findUnique({ where: { slug: input.slug } });
        if (clash !== null) throw duplicate('slug', `A page with slug "${input.slug}" exists.`);
        const row = await tx.cmsPage.create({
          data: {
            id: randomUUID(),
            slug: input.slug,
            title: input.title,
            pageType: input.pageType,
            status: input.status,
            content: sanitizeRichText(input.bodyHtml),
            version: 1,
            seoTitle: input.seo?.title ?? null,
            seoDescription: input.seo?.description ?? null,
          },
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: 'cms',
          entityType: 'CmsPage',
          entityId: row.id,
          after: { ...row },
        });
        return toAdminPage(row);
      });
    },

    async updatePage(actor: AuditActor, id: string, input: UpdatePageInput): Promise<AdminPageDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.cmsPage.findUnique({ where: { id } });
        if (before?.deletedAt !== null) throw notFound('Page');
        if (input.slug !== undefined && input.slug !== before.slug) {
          const clash = await tx.cmsPage.findUnique({ where: { slug: input.slug } });
          if (clash !== null) throw duplicate('slug', `A page with slug "${input.slug}" exists.`);
        }
        const contentChanged =
          input.bodyHtml !== undefined || input.title !== undefined || input.seo !== undefined;
        const after = await tx.cmsPage.update({
          where: { id },
          data: {
            ...(input.slug === undefined ? {} : { slug: input.slug }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.pageType === undefined ? {} : { pageType: input.pageType }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.bodyHtml === undefined ? {} : { content: sanitizeRichText(input.bodyHtml) }),
            ...(input.seo?.title === undefined ? {} : { seoTitle: input.seo.title }),
            ...(input.seo?.description === undefined
              ? {}
              : { seoDescription: input.seo.description }),
            ...(contentChanged ? { version: { increment: 1 } } : {}),
          },
        });
        await audit.record(tx, actor, {
          action:
            Object.keys(input).length === 1 && input.status !== undefined
              ? 'STATUS_CHANGE'
              : 'UPDATE',
          module: 'cms',
          entityType: 'CmsPage',
          entityId: id,
          before: { ...before },
          after: { ...after },
        });
        return toAdminPage(after);
      });
    },

    async deletePage(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.cmsPage.findUnique({ where: { id } });
        if (before?.deletedAt !== null) throw notFound('Page');
        const after = await tx.cmsPage.update({ where: { id }, data: { deletedAt: clock() } });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: 'cms',
          entityType: 'CmsPage',
          entityId: id,
          before: { ...before },
          after: { ...after },
        });
        return { id, deleted: true as const };
      });
    },

    async publicPage(slug: string) {
      const row = await db.cmsPage.findUnique({ where: { slug } });
      if (row?.deletedAt !== null || row.status !== 'PUBLISHED') {
        throw notFound('Page');
      }
      return {
        slug: row.slug,
        title: row.title,
        pageType: row.pageType,
        bodyHtml: row.content ?? '',
        seo: { title: row.seoTitle, description: row.seoDescription },
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    // ── Blocks ───────────────────────────────────────────────────────────────────────────────
    async listBlocks(
      query: BlockListQueryInput,
    ): Promise<{ items: AdminBlockDto[]; meta: PageMeta }> {
      const where: Prisma.CmsBlockWhereInput = {
        ...(query.placement === undefined ? {} : { page: query.placement }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.status === undefined ? {} : { isActive: query.status === 'ACTIVE' }),
      };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.cmsBlock.findMany({
          where,
          orderBy: [{ page: 'asc' }, { sortOrder: 'asc' }],
          skip,
          take,
        }),
        db.cmsBlock.count({ where }),
      ]);
      return { items: rows.map(toAdminBlock), meta: buildPageMeta(query.page, query.limit, total) };
    },

    async getBlock(id: string): Promise<AdminBlockDto> {
      const row = await db.cmsBlock.findUnique({ where: { id } });
      if (row === null) throw notFound('Block');
      return toAdminBlock(row);
    },

    async createBlock(actor: AuditActor, input: CreateBlockInput): Promise<AdminBlockDto> {
      const content = prepareBlockContent(input.type, input.content, allowedHosts);
      return withTransaction(db, async ({ tx }) => {
        const clash = await tx.cmsBlock.findUnique({ where: { blockKey: input.key } });
        if (clash !== null) throw duplicate('key', `A block with key "${input.key}" exists.`);
        await checkCategory(tx, input.categoryId);
        const row = await tx.cmsBlock.create({
          data: {
            id: randomUUID(),
            blockKey: input.key,
            page: input.placement,
            type: input.type,
            content: content as Prisma.InputJsonValue,
            categoryId: input.categoryId ?? null,
            sortOrder: input.sortOrder,
            isActive: input.status === 'ACTIVE',
          },
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: 'cms',
          entityType: 'CmsBlock',
          entityId: row.id,
          after: { ...row },
        });
        return toAdminBlock(row);
      });
    },

    async updateBlock(
      actor: AuditActor,
      id: string,
      input: UpdateBlockInput,
    ): Promise<AdminBlockDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.cmsBlock.findUnique({ where: { id } });
        if (before === null) throw notFound('Block');
        const type = input.type ?? before.type;
        const content =
          input.content !== undefined || input.type !== undefined
            ? prepareBlockContent(type, input.content ?? before.content, allowedHosts)
            : undefined;
        if (input.key !== undefined && input.key !== before.blockKey) {
          const clash = await tx.cmsBlock.findUnique({ where: { blockKey: input.key } });
          if (clash !== null) throw duplicate('key', `A block with key "${input.key}" exists.`);
        }
        await checkCategory(tx, input.categoryId);
        const data: Prisma.CmsBlockUncheckedUpdateInput = {
          ...(input.key === undefined ? {} : { blockKey: input.key }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.placement === undefined ? {} : { page: input.placement }),
          ...(content === undefined ? {} : { content: content as Prisma.InputJsonValue }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.status === undefined ? {} : { isActive: input.status === 'ACTIVE' }),
        };
        const after = await tx.cmsBlock.update({ where: { id }, data });
        await audit.record(tx, actor, {
          action:
            Object.keys(data).length === 1 && input.status !== undefined
              ? 'STATUS_CHANGE'
              : 'UPDATE',
          module: 'cms',
          entityType: 'CmsBlock',
          entityId: id,
          before: { ...before },
          after: { ...after },
        });
        return toAdminBlock(after);
      });
    },

    async deleteBlock(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.cmsBlock.findUnique({ where: { id } });
        if (before === null) throw notFound('Block');
        await tx.cmsBlock.delete({ where: { id } });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: 'cms',
          entityType: 'CmsBlock',
          entityId: id,
          before: { ...before },
          diff: false,
        });
        return { id, deleted: true as const };
      });
    },

    /**
     * `GET /cms/home` — ordered active blocks of placement `home`. PROVISIONAL (OQ-50): product
     * rails are not resolved server-side yet; the block `content` carries the rail definition and
     * the storefront fetches cards via `GET /products`.
     */
    async home() {
      const rows = await db.cmsBlock.findMany({
        where: { page: 'home', isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 50,
      });
      return {
        sections: rows.map((row) => {
          const content =
            typeof row.content === 'object' && row.content !== null && !Array.isArray(row.content)
              ? (row.content as Record<string, unknown>)
              : {};
          return {
            key: row.blockKey,
            type: row.type,
            title: typeof content.title === 'string' ? content.title : null,
            content,
          };
        }),
      };
    },
  };
}

export type CmsService = ReturnType<typeof createCmsService>;
