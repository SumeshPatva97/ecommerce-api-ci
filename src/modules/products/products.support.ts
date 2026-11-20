/**
 * Internal helpers shared by the product, variant and image services (same module).
 */
import type { TxClient, Queryable } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { isPrismaKnownError } from '../../core/errors/prismaErrorMapper.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import type { MediaDelivery } from '../media/cloudinary.js';
import type { KeyValueStore } from '../../core/store/memoryStore.js';
import type { DbClient } from '../../core/db/transaction.js';
import { effectiveCategoryRules, missingRequiredAttributes } from './products.rules.js';
import type {
  AttributeRef,
  AttributeValueRef,
  CategoryNode,
  ProductsRepository,
} from './products.repository.js';

export const MODULE = 'products';

export interface ProductsDeps {
  readonly db: DbClient;
  readonly audit: AuditService;
  readonly clock: () => Date;
  readonly store: KeyValueStore;
  readonly delivery: MediaDelivery;
  readonly uploadFolder: string;
  readonly repo: ProductsRepository;
}

export function notFound(entity: string): AppError {
  return new AppError('NOT_FOUND', `${entity} not found.`);
}

export function invalid(details: ErrorDetail[], message?: string): AppError {
  return new AppError('VALIDATION_ERROR', message, { details });
}

export function conflict(code: string, message: string, meta?: Record<string, unknown>): AppError {
  return new AppError('CONFLICT', message, {
    details: [{ code, message, ...(meta === undefined ? {} : { meta }) }],
  });
}

export function assertNotStale(current: Date, expected: string | undefined): void {
  if (expected === undefined) return;
  if (new Date(expected).getTime() !== current.getTime()) {
    throw new AppError('CONFLICT', 'This record was changed by someone else. Reload and retry.', {
      details: [
        {
          field: 'expectedUpdatedAt',
          code: 'STALE_WRITE',
          message: 'The record changed since it was loaded.',
          meta: { currentUpdatedAt: current.toISOString() },
        },
      ],
    });
  }
}

// ----------------------------------------------------------------------------- variant drafts
export interface VariantDraft {
  /** Error path prefix, e.g. `variants[1]` or `combinations[<key>]`. */
  readonly field: string;
  readonly label: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly combinationKey: string;
  readonly mrp: string;
  readonly sellingPrice: string;
  readonly compareAtPrice: string | null;
  readonly costPrice: string | null;
  readonly weightGrams: string | null;
  readonly lengthMm: number | null;
  readonly widthMm: number | null;
  readonly heightMm: number | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly isDefault: boolean;
  readonly sortOrder: number;
  readonly lowStockThreshold: number | null;
  readonly values: readonly { readonly attributeId: string; readonly attributeValueId: string }[];
}

/** 422 for SKUs/barcodes repeated inside the same request. */
export function requestDuplicateDetails(drafts: readonly VariantDraft[]): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  const seen = { sku: new Map<string, string>(), barcode: new Map<string, string>() };
  for (const d of drafts) {
    for (const field of ['sku', 'barcode'] as const) {
      const value = d[field];
      if (value === null) continue;
      const first = seen[field].get(value);
      if (first === undefined) seen[field].set(value, d.field);
      else {
        details.push({
          field: `${d.field}.${field}`,
          code: field === 'sku' ? 'DUPLICATE_SKU_IN_REQUEST' : 'DUPLICATE_BARCODE_IN_REQUEST',
          message: `${field === 'sku' ? 'SKU' : 'Barcode'} ${value} is used twice in this request (also ${first}).`,
        });
      }
    }
  }
  return details;
}

/** 409 details for SKUs/barcodes already used anywhere (incl. soft-deleted — never reusable). */
export async function codeConflictDetails(
  repo: ProductsRepository,
  db: Queryable,
  drafts: readonly Pick<VariantDraft, 'field' | 'sku' | 'barcode'>[],
  excludeVariantId?: string,
): Promise<ErrorDetail[]> {
  const skus = drafts.map((d) => d.sku);
  const barcodes = drafts.map((d) => d.barcode).filter((b): b is string => b !== null);
  const [skuHits, barcodeHits] = await Promise.all([
    repo.findCodeConflicts(db, 'sku', skus, excludeVariantId),
    repo.findCodeConflicts(db, 'barcode', barcodes, excludeVariantId),
  ]);
  const details: ErrorDetail[] = [];
  for (const d of drafts) {
    const sku = skuHits.find((h) => h.sku === d.sku);
    if (sku !== undefined) {
      details.push({
        field: `${d.field}.sku`,
        code: 'DUPLICATE_RESOURCE',
        message: `SKU ${d.sku} is already used${sku.deletedAt === null ? '' : ' (by a deleted variant — SKUs are never reusable)'}.`,
        meta: {
          existingVariantId: sku.id,
          productName: sku.product.name,
          deleted: sku.deletedAt !== null,
        },
      });
    }
    const barcode =
      d.barcode === null ? undefined : barcodeHits.find((h) => h.barcode === d.barcode);
    if (barcode !== undefined && d.barcode !== null) {
      details.push({
        field: `${d.field}.barcode`,
        code: 'DUPLICATE_RESOURCE',
        message: `Barcode ${d.barcode} is already used.`,
        meta: {
          existingVariantId: barcode.id,
          productName: barcode.product.name,
          deleted: barcode.deletedAt !== null,
        },
      });
    }
  }
  return details;
}

function uniqueTargetOf(error: unknown): string {
  if (!isPrismaKnownError(error)) return '';
  return JSON.stringify(error.meta ?? {}).toLowerCase();
}

/**
 * Inserts variant + `variant_attribute_values` + its `inventory` row (0/0) in the caller's
 * transaction (BACKEND_STRUCTURE §7) and writes the audit row. Stock is never set here
 * (inventory movements only). A racing unique violation becomes 409 naming the combination.
 */
export async function insertVariant(
  tx: TxClient,
  audit: AuditService,
  actor: AuditActor,
  productId: string,
  draft: VariantDraft,
): Promise<{ id: string }> {
  let created: { id: string };
  try {
    created = await tx.productVariant.create({
      data: {
        productId,
        sku: draft.sku,
        barcode: draft.barcode,
        name: draft.name,
        combinationKey: draft.combinationKey,
        mrp: draft.mrp,
        sellingPrice: draft.sellingPrice,
        compareAtPrice: draft.compareAtPrice,
        costPrice: draft.costPrice,
        weightGrams: draft.weightGrams,
        lengthMm: draft.lengthMm,
        widthMm: draft.widthMm,
        heightMm: draft.heightMm,
        status: draft.status,
        isDefault: draft.isDefault,
        sortOrder: draft.sortOrder,
        createdById: actor.userId ?? null,
        updatedById: actor.userId ?? null,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isPrismaKnownError(error) && error.code === 'P2002') {
      const target = uniqueTargetOf(error);
      const field = target.includes('barcode')
        ? 'barcode'
        : target.includes('combination')
          ? 'combination'
          : target.includes('sku')
            ? 'sku'
            : 'combination';
      const message =
        field === 'combination'
          ? `Combination "${draft.label}" already exists for this product.`
          : `${field === 'sku' ? 'SKU' : 'Barcode'} ${field === 'sku' ? draft.sku : (draft.barcode ?? '')} is already used (combination "${draft.label}").`;
      throw new AppError('DUPLICATE_RESOURCE', message, {
        cause: error,
        details: [
          {
            field: `${draft.field}.${field === 'combination' ? 'attributeValueIds' : field}`,
            code: field === 'combination' ? 'DUPLICATE_COMBINATION' : 'DUPLICATE_RESOURCE',
            message,
            meta: { combinationKey: draft.combinationKey, label: draft.label },
          },
        ],
      });
    }
    throw error;
  }
  if (draft.values.length > 0) {
    await tx.variantAttributeValue.createMany({
      data: draft.values.map((v) => ({
        variantId: created.id,
        attributeId: v.attributeId,
        attributeValueId: v.attributeValueId,
      })),
    });
  }
  await tx.inventory.create({
    data: {
      variantId: created.id,
      quantityOnHand: 0,
      quantityReserved: 0,
      lowStockThreshold: draft.lowStockThreshold,
      updatedById: actor.userId ?? null,
    },
  });
  await audit.record(tx, actor, {
    action: 'CREATE',
    module: MODULE,
    entityType: 'ProductVariant',
    entityId: created.id,
    after: {
      id: created.id,
      productId,
      sku: draft.sku,
      barcode: draft.barcode,
      name: draft.name,
      combinationKey: draft.combinationKey,
      mrp: draft.mrp,
      sellingPrice: draft.sellingPrice,
      costPrice: draft.costPrice,
      status: draft.status,
      isDefault: draft.isDefault,
    },
    metadata: { entityLabel: draft.sku },
  });
  return created;
}

export function draftDto(id: string, d: VariantDraft) {
  return {
    id,
    sku: d.sku,
    barcode: d.barcode,
    name: d.name,
    combinationKey: d.combinationKey,
    isDefault: d.isDefault,
    status: d.status,
    mrp: d.mrp,
    sellingPrice: d.sellingPrice,
    attributeValueIds: d.values.map((v) => v.attributeValueId),
    inventory: { onHand: 0, reserved: 0, available: 0 },
  };
}

// ----------------------------------------------------------------------------- axes & values
export function usableAttribute(a: AttributeRef | undefined): a is AttributeRef {
  return a?.isActive === true && a.deletedAt === null;
}

export function usableValue(v: AttributeValueRef | undefined): v is AttributeValueRef {
  return v?.isActive === true && v.deletedAt === null && usableAttribute(v.attribute);
}

/** 422 details for axis attributes that are unknown, inactive or not variant axes. */
export function axisAttributeDetails(
  axisIds: readonly string[],
  attributes: readonly AttributeRef[],
  pathOf: (index: number) => string,
): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  axisIds.forEach((id, i) => {
    const attribute = attributes.find((a) => a.id === id);
    if (!usableAttribute(attribute)) {
      details.push({
        field: pathOf(i),
        code: 'ATTRIBUTE_NOT_FOUND',
        message: 'Unknown or inactive attribute.',
      });
    } else if (!attribute.isVariantAxis) {
      details.push({
        field: pathOf(i),
        code: 'NOT_A_VARIANT_AXIS',
        message: `Attribute "${attribute.name}" is not a variant axis.`,
      });
    }
  });
  return details;
}

/**
 * Validates one variant's value IDs against the ordered axis list: exactly one usable value per
 * axis. Returns the values ordered by axis, or pushes details.
 */
export function valuesForAxes(
  valueIds: readonly string[],
  axisIds: readonly string[],
  valueById: ReadonlyMap<string, AttributeValueRef>,
  field: string,
  details: ErrorDetail[],
): AttributeValueRef[] | null {
  const values: AttributeValueRef[] = [];
  for (const id of valueIds) {
    const value = valueById.get(id);
    if (!usableValue(value)) {
      details.push({
        field,
        code: 'ATTRIBUTE_VALUE_NOT_FOUND',
        message: `Unknown or inactive attribute value ${id}.`,
      });
      return null;
    }
    values.push(value);
  }
  const attrs = values.map((v) => v.attributeId);
  const exact =
    attrs.length === axisIds.length &&
    new Set(attrs).size === attrs.length &&
    axisIds.every((a) => attrs.includes(a));
  if (!exact) {
    details.push({
      field,
      code: 'AXIS_VALUES_MISMATCH',
      message: 'Provide exactly one value for each variant axis.',
      meta: { axes: axisIds },
    });
    return null;
  }
  return axisIds.flatMap((axisId) => values.find((v) => v.attributeId === axisId) ?? []);
}

export function variantLabel(values: readonly AttributeValueRef[]): string {
  return values.map((v) => v.value).join(' / ');
}

// ----------------------------------------------------------------------------- category rules
export async function missingRequired(
  repo: ProductsRepository,
  db: Queryable,
  chain: readonly CategoryNode[],
  productAttributeIds: ReadonlySet<string>,
  variantAttributeSets: readonly ReadonlySet<string>[],
): Promise<{ id: string; name: string }[]> {
  if (chain.length === 0) return [];
  const rows = await repo.categoryRules(
    db,
    chain.map((c) => c.id),
  );
  const rules = effectiveCategoryRules(
    chain.map((c) => c.id),
    rows,
  );
  const missing = missingRequiredAttributes(rules, productAttributeIds, variantAttributeSets);
  return missing.map((id) => ({
    id,
    name: rows.find((r) => r.attributeId === id)?.attribute.name ?? id,
  }));
}

export function categoryUsable(chain: readonly CategoryNode[]): boolean {
  const leaf = chain[chain.length - 1];
  return leaf !== undefined && leaf.isActive && leaf.deletedAt === null;
}
