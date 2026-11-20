/**
 * Collection use-cases — API_DOCUMENTATION.md §4.4, §3.3; DATABASE_DESIGN.md §7.4–§7.5.
 *
 * - Name/slug global unique: friendly pre-check + DB unique index as final guard.
 *   PROVISIONAL (OQ-39): soft-deleted names/slugs stay reserved.
 * - Delete follows the §4.4 standard rule (blocked while ACTIVE products are members).
 *   PROVISIONAL (D-56): stricter than strictly necessary for a junction-only relation.
 * - `PUT /:collectionId/products` replaces the ordered membership (≤ 500 products).
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeText } from '../../lib/normalize.js';
import { uniqueSlug } from '../../lib/slug.js';
import type { AuditActor } from '../audit/audit.service.js';
import { changedKeys, updateAction } from '../catalog-common/catalog.audit.js';
import {
  duplicateError,
  fieldError,
  inUseError,
  notFoundError,
} from '../catalog-common/catalog.errors.js';
import { compact, imageColumns, seoColumns } from '../catalog-common/catalog.mapper.js';
import { parseSort, statusWhere } from '../catalog-common/catalog.schemas.js';
import {
  toAdminCollection,
  toPublicCollection,
  toPublicCollectionDetail,
  type AdminCollectionDto,
  type PublicCollectionDetailDto,
  type PublicCollectionDto,
} from './collections.mapper.js';
import type { CollectionRow, CollectionsRepository } from './collections.repository.js';
import type {
  CollectionListQueryInput,
  CreateCollectionInput,
  PublicCollectionListQueryInput,
  ReplaceCollectionProductsInput,
  UpdateCollectionInput,
} from './collections.schemas.js';

const MODULE = 'collections';
const ENTITY = 'Collection';

export interface CollectionMembershipDto {
  collectionId: string;
  productIds: string[];
  count: number;
}

export function createCollectionsService(container: AppContainer, repo: CollectionsRepository) {
  const { db, audit, clock } = container;

  async function assertNameFree(tx: Queryable, name: string, selfId?: string): Promise<string> {
    const normalized = normalizeText(name);
    const existing = await repo.findByNameNormalized(tx, normalized);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('name', `Collection "${name}" already exists.`, {
        normalized,
        existingId: existing.id,
        ...(existing.deletedAt === null ? {} : { deleted: true }),
      });
    }
    return normalized;
  }

  async function assertSlugFree(tx: Queryable, slug: string, selfId?: string): Promise<void> {
    const existing = await repo.findBySlug(tx, slug);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('slug', `Slug "${slug}" is already used by another collection.`, {
        existingId: existing.id,
      });
    }
  }

  async function loadLive(tx: Queryable, id: string): Promise<CollectionRow> {
    const row = await repo.findById(tx, id);
    if (row?.deletedAt !== null) throw notFoundError('Collection');
    return row;
  }

  return {
    async list(
      query: CollectionListQueryInput,
    ): Promise<{ items: AdminCollectionDto[]; meta: PageMeta }> {
      const where: Prisma.CollectionWhereInput = {
        ...statusWhere(query.status),
        ...(query.q === undefined ? {} : { name: { contains: query.q } }),
      };
      const sort = parseSort(query.sort, 'sortOrder');
      const { skip, take } = toSkipTake(query.page, query.limit);
      const { rows, total } = await repo.list(
        db,
        where,
        [{ [sort.field]: sort.direction }, { name: 'asc' }],
        skip,
        take,
      );
      return {
        items: rows.map((r) => toAdminCollection(r)),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(id: string): Promise<AdminCollectionDto> {
      const row = await repo.findByIdWithCount(db, id);
      if (row === null) throw notFoundError('Collection');
      return toAdminCollection(row, await repo.memberIds(db, id));
    },

    async create(actor: AuditActor, input: CreateCollectionInput): Promise<AdminCollectionDto> {
      return withTransaction(db, async ({ tx }) => {
        const nameNormalized = await assertNameFree(tx, input.name);
        let slug: string;
        if (input.slug === undefined) {
          slug = await uniqueSlug(input.name, async (c) => (await repo.findBySlug(tx, c)) !== null);
        } else {
          await assertSlugFree(tx, input.slug);
          slug = input.slug;
        }
        const hero = imageColumns(input.heroImage);
        const row = await repo.create(tx, {
          id: randomUUID(),
          name: input.name,
          nameNormalized,
          slug,
          description: input.description ?? null,
          bannerImageUrl: hero?.url ?? null,
          bannerImagePid: hero?.publicId ?? null,
          isActive: (input.status ?? 'ACTIVE') === 'ACTIVE',
          isFeatured: input.isFeatured ?? false,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          sortOrder: input.sortOrder ?? 0,
          ...seoColumns(input.seo),
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: row.id,
          after: row,
        });
        return toAdminCollection(row);
      });
    },

    async update(
      actor: AuditActor,
      id: string,
      input: UpdateCollectionInput,
    ): Promise<AdminCollectionDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        const startsAt = input.startsAt === undefined ? before.startsAt : input.startsAt;
        const endsAt = input.endsAt === undefined ? before.endsAt : input.endsAt;
        if (startsAt !== null && endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
          throw fieldError('endsAt', 'Must be after startsAt.', 'INVALID_WINDOW');
        }
        const hero = imageColumns(input.heroImage);
        const patch = compact({
          name: input.name,
          nameNormalized:
            input.name === undefined ? undefined : await assertNameFree(tx, input.name, id),
          slug: input.slug,
          description: input.description,
          bannerImageUrl: hero?.url,
          bannerImagePid: hero?.publicId,
          isActive: input.status === undefined ? undefined : input.status === 'ACTIVE',
          isFeatured: input.isFeatured,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          sortOrder: input.sortOrder,
          ...seoColumns(input.seo),
        });
        if (input.slug !== undefined && input.slug !== before.slug) {
          await assertSlugFree(tx, input.slug, id);
        }
        const changed = changedKeys(before, patch);
        if (changed.length === 0) return toAdminCollection(before);
        const after = await repo.update(tx, id, patch);
        await audit.record(tx, actor, {
          action: updateAction(changed),
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before,
          after,
        });
        return toAdminCollection(after);
      });
    },

    async remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        const activeProducts = await repo.countActiveProducts(tx, id);
        if (activeProducts > 0) {
          throw inUseError(
            'This collection contains active products. Remove them or deactivate it instead.',
            { activeProducts },
          );
        }
        const after = await repo.update(tx, id, { deletedAt: clock() });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before,
          after,
        });
        return { id, deleted: true as const };
      });
    },

    async restore(actor: AuditActor, id: string): Promise<AdminCollectionDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await repo.findById(tx, id);
        if (before === null) throw notFoundError('Collection');
        if (before.deletedAt === null) {
          throw new AppError('INVALID_STATE_TRANSITION', 'This collection is not deleted.');
        }
        const after = await repo.update(tx, id, { deletedAt: null });
        await audit.record(tx, actor, {
          action: 'RESTORE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before,
          after,
        });
        return toAdminCollection(after);
      });
    },

    async replaceProducts(
      actor: AuditActor,
      id: string,
      input: ReplaceCollectionProductsInput,
    ): Promise<CollectionMembershipDto> {
      return withTransaction(db, async ({ tx }) => {
        await loadLive(tx, id);
        const existing = await repo.existingProductIds(tx, input.productIds);
        const missing = input.productIds
          .map((productId, index) => ({ productId, index }))
          .filter(({ productId }) => !existing.has(productId));
        if (missing.length > 0) {
          throw new AppError('VALIDATION_ERROR', 'Some products do not exist.', {
            details: missing.map(({ productId, index }) => ({
              field: `productIds[${index}]`,
              message: 'Product not found.',
              code: 'PRODUCT_NOT_FOUND',
              meta: { productId },
            })),
          });
        }
        const beforeIds = await repo.memberIds(tx, id);
        await repo.replaceMembers(tx, id, input.productIds, actor.userId ?? null, clock());
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          eventKey: 'collections.membership_replaced',
          before: { productIds: beforeIds },
          after: { productIds: [...input.productIds] },
          metadata: { sortMode: input.sortMode, count: input.productIds.length },
        });
        return {
          collectionId: id,
          productIds: [...input.productIds],
          count: input.productIds.length,
        };
      });
    },

    async listPublic(query: PublicCollectionListQueryInput): Promise<PublicCollectionDto[]> {
      // FR-SF-004: the query already excludes empty collections; the count guard keeps the
      // contract even if a member turned inactive between the filter and the count.
      return (await repo.listPublic(db, clock(), query.featured))
        .filter((row) => row._count.products > 0)
        .map(toPublicCollection);
    },

    async getPublic(slug: string): Promise<PublicCollectionDetailDto> {
      const row = await repo.findPublicBySlug(db, slug, clock());
      if (row === null) throw notFoundError('Collection');
      return toPublicCollectionDetail(row);
    },
  };
}

export type CollectionsService = ReturnType<typeof createCollectionsService>;
