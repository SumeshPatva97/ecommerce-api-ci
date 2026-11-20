/**
 * Brand use-cases — API_DOCUMENTATION.md §4.4, DATABASE_DESIGN.md §7.3,
 * PROJECT_CONTEXT.md §3.5–§3.6 (name global unique, slug global).
 *
 * Uniqueness: friendly pre-check (409 DUPLICATE_RESOURCE with field details) inside the
 * transaction; the DB unique indexes stay the final guard (P2002 → 409, mapped centrally).
 * PROVISIONAL (OQ-39): soft-deleted rows keep their name/slug reserved (restore or rename).
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import { normalizeText } from '../../lib/normalize.js';
import { uniqueSlug } from '../../lib/slug.js';
import type { AuditActor } from '../audit/audit.service.js';
import { changedKeys, updateAction } from '../catalog-common/catalog.audit.js';
import { duplicateError, inUseError, notFoundError } from '../catalog-common/catalog.errors.js';
import { compact, imageColumns, seoColumns } from '../catalog-common/catalog.mapper.js';
import { parseSort, statusWhere } from '../catalog-common/catalog.schemas.js';
import { AppError } from '../../core/errors/AppError.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  toAdminBrand,
  toPublicBrand,
  type AdminBrandDto,
  type PublicBrandDto,
} from './brands.mapper.js';
import type { BrandRow, BrandsRepository } from './brands.repository.js';
import type { BrandListQueryInput, CreateBrandInput, UpdateBrandInput } from './brands.schemas.js';

const MODULE = 'brands';
const ENTITY = 'Brand';

export function createBrandsService(container: AppContainer, repo: BrandsRepository) {
  const { db, audit, clock } = container;

  async function assertNameFree(tx: Queryable, name: string, selfId?: string): Promise<string> {
    const normalized = normalizeText(name);
    const existing = await repo.findByNameNormalized(tx, normalized);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('name', `Brand "${name}" already exists.`, {
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
      throw duplicateError('slug', `Slug "${slug}" is already used by another brand.`, {
        existingId: existing.id,
      });
    }
  }

  async function loadLive(tx: Queryable, id: string): Promise<BrandRow> {
    const row = await repo.findById(tx, id);
    if (row?.deletedAt !== null) throw notFoundError('Brand');
    return row;
  }

  return {
    async list(query: BrandListQueryInput): Promise<{ items: AdminBrandDto[]; meta: PageMeta }> {
      const where: Prisma.BrandWhereInput = {
        ...statusWhere(query.status),
        ...(query.q === undefined ? {} : { name: { contains: query.q } }),
      };
      const sort = parseSort(query.sort, 'sortOrder');
      const orderBy: Prisma.BrandOrderByWithRelationInput[] = [
        { [sort.field]: sort.direction },
        { name: 'asc' },
      ];
      const { skip, take } = toSkipTake(query.page, query.limit);
      const { rows, total } = await repo.list(db, where, orderBy, skip, take);
      return {
        items: rows.map(toAdminBrand),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(id: string): Promise<AdminBrandDto> {
      const row = await repo.findByIdWithCount(db, id);
      if (row === null) throw notFoundError('Brand');
      return toAdminBrand(row);
    },

    async create(actor: AuditActor, input: CreateBrandInput): Promise<AdminBrandDto> {
      return withTransaction(db, async ({ tx }) => {
        const nameNormalized = await assertNameFree(tx, input.name);
        let slug: string;
        if (input.slug === undefined) {
          slug = await uniqueSlug(input.name, async (c) => (await repo.findBySlug(tx, c)) !== null);
        } else {
          await assertSlugFree(tx, input.slug);
          slug = input.slug;
        }
        const logo = imageColumns(input.logo);
        const row = await repo.create(tx, {
          id: randomUUID(),
          name: input.name,
          nameNormalized,
          slug,
          description: input.description ?? null,
          logoUrl: logo?.url ?? null,
          logoPublicId: logo?.publicId ?? null,
          isActive: (input.status ?? 'ACTIVE') === 'ACTIVE',
          isFeatured: input.isFeatured ?? false,
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
        return toAdminBrand(row);
      });
    },

    async update(actor: AuditActor, id: string, input: UpdateBrandInput): Promise<AdminBrandDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        const logo = imageColumns(input.logo);
        const patch = compact({
          name: input.name,
          nameNormalized:
            input.name === undefined ? undefined : await assertNameFree(tx, input.name, id),
          slug: input.slug,
          description: input.description,
          logoUrl: logo?.url,
          logoPublicId: logo?.publicId,
          isActive: input.status === undefined ? undefined : input.status === 'ACTIVE',
          isFeatured: input.isFeatured,
          sortOrder: input.sortOrder,
          ...seoColumns(input.seo),
        });
        if (input.slug !== undefined && input.slug !== before.slug) {
          await assertSlugFree(tx, input.slug, id);
        }
        const changed = changedKeys(before, patch);
        if (changed.length === 0) return toAdminBrand(before);
        const after = await repo.update(tx, id, patch);
        await audit.record(tx, actor, {
          action: updateAction(changed),
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before,
          after,
        });
        return toAdminBrand(after);
      });
    },

    async remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        const activeProducts = await repo.countActiveProducts(tx, id);
        if (activeProducts > 0) {
          throw inUseError('This brand is used by active products and cannot be deleted.', {
            activeProducts,
          });
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

    async restore(actor: AuditActor, id: string): Promise<AdminBrandDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await repo.findById(tx, id);
        if (before === null) throw notFoundError('Brand');
        if (before.deletedAt === null) {
          throw new AppError('INVALID_STATE_TRANSITION', 'This brand is not deleted.');
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
        return toAdminBrand(after);
      });
    },

    async listPublic(): Promise<PublicBrandDto[]> {
      return (await repo.listPublic(db)).map(toPublicBrand);
    },
  };
}

export type BrandsService = ReturnType<typeof createBrandsService>;
