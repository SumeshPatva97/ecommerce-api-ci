/**
 * Attribute & attribute-value use-cases — API_DOCUMENTATION.md §4.4,
 * DATABASE_DESIGN.md §7.9–§7.10, PROJECT_CONTEXT.md §3.5–§3.6.
 *
 * - Attribute name global unique; value unique per attribute (normalized); value slug per
 *   attribute; attribute code global. Friendly pre-check + DB unique index as final guard.
 *   PROVISIONAL (OQ-39): soft-deleted names/values/slugs/codes stay reserved.
 * - Delete only when unused (variants, product specs, category rules) → else 409 IN_USE.
 * - `isVariantAxis` cannot be switched off while a variant uses the attribute as an axis or a
 *   category rule pre-selects it as an axis default → 409 IN_USE.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeText } from '../../lib/normalize.js';
import { slugify, uniqueSlug } from '../../lib/slug.js';
import type { AuditActor } from '../audit/audit.service.js';
import { changedKeys, updateAction } from '../catalog-common/catalog.audit.js';
import {
  duplicateError,
  fieldError,
  inUseError,
  notFoundError,
} from '../catalog-common/catalog.errors.js';
import { compact } from '../catalog-common/catalog.mapper.js';
import { parseSort, statusWhere } from '../catalog-common/catalog.schemas.js';
import {
  toAdminAttribute,
  toAdminAttributeValue,
  type AdminAttributeDto,
  type AdminAttributeValueDto,
} from './attributes.mapper.js';
import type {
  AttributeRow,
  AttributesRepository,
  AttributeUsage,
  AttributeValueRow,
} from './attributes.repository.js';
import {
  RESERVED_ATTRIBUTE_CODES,
  type AttributeListQueryInput,
  type AttributeValueListQueryInput,
  type CreateAttributeInput,
  type CreateAttributeValueInput,
  type UpdateAttributeInput,
  type UpdateAttributeValueInput,
} from './attributes.schemas.js';

const MODULE = 'attributes';
const MAX_CODE = 50;

function totalUsage(usage: AttributeUsage): number {
  return usage.variants + usage.products + usage.categoryRules;
}

/** `"Metal Finish"` → `metal_finish`; reserved listing keys get an `_attr` suffix. */
export function codeFromName(name: string): string {
  const base = slugify(name).replace(/-/g, '_').slice(0, MAX_CODE) || 'attr';
  return RESERVED_ATTRIBUTE_CODES.has(base) ? `${base}_attr` : base;
}

export function createAttributesService(container: AppContainer, repo: AttributesRepository) {
  const { db, audit, clock } = container;

  async function assertNameFree(tx: Queryable, name: string, selfId?: string): Promise<string> {
    const normalized = normalizeText(name);
    const existing = await repo.findByNameNormalized(tx, normalized);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('name', `Attribute "${name}" already exists.`, {
        normalized,
        existingId: existing.id,
        ...(existing.deletedAt === null ? {} : { deleted: true }),
      });
    }
    return normalized;
  }

  async function allocateCode(tx: Queryable, input: CreateAttributeInput): Promise<string> {
    if (input.code !== undefined) {
      const existing = await repo.findByCode(tx, input.code);
      if (existing !== null) {
        throw duplicateError('code', `Code "${input.code}" is already used.`, {
          existingId: existing.id,
        });
      }
      return input.code;
    }
    const base = codeFromName(input.name);
    for (let i = 1; i <= 50; i += 1) {
      const suffix = i === 1 ? '' : `_${i}`;
      const candidate = `${base.slice(0, MAX_CODE - suffix.length)}${suffix}`;
      if ((await repo.findByCode(tx, candidate)) === null) return candidate;
    }
    throw new AppError('CONFLICT', 'Could not allocate a unique attribute code.');
  }

  async function loadLive(tx: Queryable, id: string): Promise<AttributeRow> {
    const row = await repo.findById(tx, id);
    if (row?.deletedAt !== null) throw notFoundError('Attribute');
    return row;
  }

  async function loadValue(
    tx: Queryable,
    attributeId: string,
    valueId: string,
  ): Promise<AttributeValueRow> {
    const row = await repo.findValueById(tx, valueId);
    if (row?.attributeId !== attributeId || row.deletedAt !== null) {
      throw notFoundError('Attribute value');
    }
    return row;
  }

  async function assertValueFree(
    tx: Queryable,
    attribute: AttributeRow,
    value: string,
    selfId?: string,
  ): Promise<string> {
    const normalized = normalizeText(value);
    const existing = await repo.findValueByNormalized(tx, attribute.id, normalized);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('value', `Value "${value}" already exists for ${attribute.name}.`, {
        normalized,
        existingId: existing.id,
        ...(existing.deletedAt === null ? {} : { deleted: true }),
      });
    }
    return normalized;
  }

  async function assertValueSlugFree(
    tx: Queryable,
    attributeId: string,
    slug: string,
    selfId?: string,
  ): Promise<void> {
    const existing = await repo.findValueBySlug(tx, attributeId, slug);
    if (existing !== null && existing.id !== selfId) {
      throw duplicateError('slug', `Slug "${slug}" is already used by another value.`, {
        existingId: existing.id,
      });
    }
  }

  function assertSwatchFields(
    attribute: AttributeRow,
    input: { hexColor?: string | null | undefined; swatchImageUrl?: string | null | undefined },
  ): void {
    if (attribute.displayType === 'SWATCH') return;
    if (input.hexColor !== undefined && input.hexColor !== null) {
      throw fieldError('hexColor', 'Only SWATCH attributes can have a colour.', 'SWATCH_ONLY');
    }
    if (input.swatchImageUrl !== undefined && input.swatchImageUrl !== null) {
      throw fieldError(
        'swatchImageUrl',
        'Only SWATCH attributes can have a swatch image.',
        'SWATCH_ONLY',
      );
    }
  }

  return {
    // ---- attributes ---------------------------------------------------------------------

    async list(
      query: AttributeListQueryInput,
    ): Promise<{ items: AdminAttributeDto[]; meta: PageMeta }> {
      const where: Prisma.AttributeWhereInput = {
        ...statusWhere(query.status),
        ...(query.q === undefined
          ? {}
          : { OR: [{ name: { contains: query.q } }, { code: { contains: query.q } }] }),
        ...(query.isVariantAxis === undefined ? {} : { isVariantAxis: query.isVariantAxis }),
        ...(query.isFilterable === undefined ? {} : { isFilterable: query.isFilterable }),
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
        items: rows.map(toAdminAttribute),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(id: string): Promise<AdminAttributeDto> {
      const row = await repo.findByIdWithCount(db, id);
      if (row === null) throw notFoundError('Attribute');
      return toAdminAttribute(row);
    },

    async create(actor: AuditActor, input: CreateAttributeInput): Promise<AdminAttributeDto> {
      return withTransaction(db, async ({ tx }) => {
        const nameNormalized = await assertNameFree(tx, input.name);
        const code = await allocateCode(tx, input);
        const row = await repo.create(tx, {
          id: randomUUID(),
          name: input.name,
          nameNormalized,
          code,
          displayType: input.displayType ?? 'BUTTON',
          isVariantAxis: input.isVariantAxis ?? false,
          isFilterable: input.isFilterable ?? false,
          isVisibleOnPdp: input.isVisibleOnPdp ?? true,
          unit: input.unit ?? null,
          sortOrder: input.sortOrder ?? 0,
          isActive: (input.status ?? 'ACTIVE') === 'ACTIVE',
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Attribute',
          entityId: row.id,
          after: row,
        });
        return toAdminAttribute(row);
      });
    },

    async update(
      actor: AuditActor,
      id: string,
      input: UpdateAttributeInput,
    ): Promise<AdminAttributeDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        if (before.isVariantAxis && input.isVariantAxis === false) {
          const usage = await repo.attributeUsage(tx, id);
          const axisDefaults = await repo.countAxisDefaultRules(tx, id);
          if (usage.variants > 0 || axisDefaults > 0) {
            throw inUseError(
              'This attribute is used as a variant axis and cannot stop being one.',
              { variants: usage.variants, categoryAxisDefaults: axisDefaults },
            );
          }
        }
        const patch = compact({
          name: input.name,
          nameNormalized:
            input.name === undefined ? undefined : await assertNameFree(tx, input.name, id),
          displayType: input.displayType,
          isVariantAxis: input.isVariantAxis,
          isFilterable: input.isFilterable,
          isVisibleOnPdp: input.isVisibleOnPdp,
          unit: input.unit,
          sortOrder: input.sortOrder,
          isActive: input.status === undefined ? undefined : input.status === 'ACTIVE',
        });
        const changed = changedKeys(before, patch);
        if (changed.length === 0) return toAdminAttribute(before);
        const after = await repo.update(tx, id, patch);
        await audit.record(tx, actor, {
          action: updateAction(changed),
          module: MODULE,
          entityType: 'Attribute',
          entityId: id,
          before,
          after,
        });
        return toAdminAttribute(after);
      });
    },

    async remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLive(tx, id);
        const usage = await repo.attributeUsage(tx, id);
        if (totalUsage(usage) > 0) {
          throw inUseError(
            'This attribute is in use and cannot be deleted. Deactivate it instead.',
            {
              ...usage,
            },
          );
        }
        const after = await repo.update(tx, id, { deletedAt: clock() });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Attribute',
          entityId: id,
          before,
          after,
        });
        return { id, deleted: true as const };
      });
    },

    async restore(actor: AuditActor, id: string): Promise<AdminAttributeDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await repo.findById(tx, id);
        if (before === null) throw notFoundError('Attribute');
        if (before.deletedAt === null) {
          throw new AppError('INVALID_STATE_TRANSITION', 'This attribute is not deleted.');
        }
        const after = await repo.update(tx, id, { deletedAt: null });
        await audit.record(tx, actor, {
          action: 'RESTORE',
          module: MODULE,
          entityType: 'Attribute',
          entityId: id,
          before,
          after,
        });
        return toAdminAttribute(after);
      });
    },

    // ---- values -------------------------------------------------------------------------

    async listValues(
      attributeId: string,
      query: AttributeValueListQueryInput,
    ): Promise<{ items: AdminAttributeValueDto[]; meta: PageMeta }> {
      const attribute = await repo.findById(db, attributeId);
      if (attribute === null) throw notFoundError('Attribute');
      const where: Prisma.AttributeValueWhereInput = {
        attributeId,
        ...statusWhere(query.status),
        ...(query.q === undefined ? {} : { value: { contains: query.q } }),
      };
      const sort = parseSort(query.sort, 'sortOrder');
      const { skip, take } = toSkipTake(query.page, query.limit);
      const { rows, total } = await repo.listValues(
        db,
        where,
        [{ [sort.field]: sort.direction }, { value: 'asc' }],
        skip,
        take,
      );
      return {
        items: rows.map(toAdminAttributeValue),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async getValue(attributeId: string, valueId: string): Promise<AdminAttributeValueDto> {
      const row = await repo.findValueById(db, valueId);
      if (row?.attributeId !== attributeId) throw notFoundError('Attribute value');
      return toAdminAttributeValue(row);
    },

    async createValue(
      actor: AuditActor,
      attributeId: string,
      input: CreateAttributeValueInput,
    ): Promise<AdminAttributeValueDto> {
      return withTransaction(db, async ({ tx }) => {
        const attribute = await loadLive(tx, attributeId);
        assertSwatchFields(attribute, input);
        const valueNormalized = await assertValueFree(tx, attribute, input.value);
        let slug: string;
        if (input.slug === undefined) {
          slug = await uniqueSlug(
            input.value,
            async (c) => (await repo.findValueBySlug(tx, attributeId, c)) !== null,
          );
        } else {
          await assertValueSlugFree(tx, attributeId, input.slug);
          slug = input.slug;
        }
        const row = await repo.createValue(tx, {
          id: randomUUID(),
          attributeId,
          value: input.value,
          valueNormalized,
          slug,
          swatchHex: input.hexColor ?? null,
          swatchImageUrl: input.swatchImageUrl ?? null,
          sortOrder: input.sortOrder ?? 0,
          isActive: (input.status ?? 'ACTIVE') === 'ACTIVE',
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: 'AttributeValue',
          entityId: row.id,
          after: row,
        });
        return toAdminAttributeValue(row);
      });
    },

    async updateValue(
      actor: AuditActor,
      attributeId: string,
      valueId: string,
      input: UpdateAttributeValueInput,
    ): Promise<AdminAttributeValueDto> {
      return withTransaction(db, async ({ tx }) => {
        const attribute = await loadLive(tx, attributeId);
        const before = await loadValue(tx, attributeId, valueId);
        assertSwatchFields(attribute, input);
        const patch = compact({
          value: input.value,
          valueNormalized:
            input.value === undefined
              ? undefined
              : await assertValueFree(tx, attribute, input.value, valueId),
          slug: input.slug,
          swatchHex: input.hexColor,
          swatchImageUrl: input.swatchImageUrl,
          sortOrder: input.sortOrder,
          isActive: input.status === undefined ? undefined : input.status === 'ACTIVE',
        });
        if (input.slug !== undefined && input.slug !== before.slug) {
          await assertValueSlugFree(tx, attributeId, input.slug, valueId);
        }
        const changed = changedKeys(before, patch);
        if (changed.length === 0) return toAdminAttributeValue(before);
        const after = await repo.updateValue(tx, valueId, patch);
        await audit.record(tx, actor, {
          action: updateAction(changed),
          module: MODULE,
          entityType: 'AttributeValue',
          entityId: valueId,
          before,
          after,
        });
        return toAdminAttributeValue(after);
      });
    },

    async removeValue(
      actor: AuditActor,
      attributeId: string,
      valueId: string,
    ): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadValue(tx, attributeId, valueId);
        const usage = await repo.valueUsage(tx, valueId);
        if (totalUsage(usage) > 0) {
          throw inUseError('This value is in use and cannot be deleted. Deactivate it instead.', {
            variants: usage.variants,
            products: usage.products,
          });
        }
        const after = await repo.updateValue(tx, valueId, { deletedAt: clock() });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: 'AttributeValue',
          entityId: valueId,
          before,
          after,
        });
        return { id: valueId, deleted: true as const };
      });
    },
  };
}

export type AttributesService = ReturnType<typeof createAttributesService>;
