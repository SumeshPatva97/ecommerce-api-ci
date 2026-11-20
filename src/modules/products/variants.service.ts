/**
 * Variant use-cases — API_DOCUMENTATION.md §4.3, workflow §6–§10, BACKEND_STRUCTURE §7.
 *
 * - Every variant insert also inserts its `inventory` row (0/0) in the same transaction; stock is
 *   never changed here (inventory movements are owned by the inventory module).
 * - Generate commit is atomic: one transaction for all variants + `variant_attribute_values` +
 *   `inventory`; a racing unique violation (SKU/combination) rolls everything back → 409 naming
 *   the combination.
 * - Preview tokens live 15 min in the in-memory KeyValueStore (single-instance only, D-38) and
 *   bind the commit to the same axes/defaults/SKU inputs and the same set of existing variants.
 */
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { dec } from '../../lib/money.js';
import { slugify } from '../../lib/slug.js';
import { ulid } from '../../lib/ulid.js';
import { addMinutes } from '../../lib/time.js';
import type { AuditActor } from '../audit/audit.service.js';
import { mapAdminVariant } from './products.mapper.js';
import type { AttributeValueRef, VariantAdminRow } from './products.repository.js';
import {
  buildSku,
  cartesian,
  combinationKey,
  defaultSkuPattern,
  isValidSku,
  MAX_COMBINATIONS_PER_REQUEST,
  MAX_VARIANTS_PER_PRODUCT,
  previewFingerprint,
  valueCode,
} from './products.rules.js';
import type {
  AxisVariantInput,
  GenerateVariantsInput,
  UpdateVariantInput,
} from './products.schemas.js';
import { toDraft } from './products.service.js';
import {
  assertNotStale,
  axisAttributeDetails,
  codeConflictDetails,
  conflict,
  draftDto,
  insertVariant,
  invalid,
  MODULE,
  notFound,
  usableValue,
  valuesForAxes,
  variantLabel,
  type ProductsDeps,
  type VariantDraft,
} from './products.support.js';

export const PREVIEW_TTL_SECONDS = 15 * 60;

interface ViewOptions {
  readonly canSeeCost: boolean;
}

type CombinationStatus = 'NEW' | 'EXISTS' | 'EXISTS_DELETED';

interface PlannedCombination {
  readonly combinationKey: string;
  readonly label: string;
  readonly values: AttributeValueRef[];
  readonly status: CombinationStatus;
  readonly existingVariantId?: string;
  readonly existingVariantStatus?: string;
  readonly existingSku?: string;
}

function variantSnapshot(v: VariantAdminRow): Record<string, unknown> {
  return {
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    mrp: v.mrp,
    sellingPrice: v.sellingPrice,
    compareAtPrice: v.compareAtPrice,
    costPrice: v.costPrice,
    weightGrams: v.weightGrams,
    lengthMm: v.lengthMm,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
    status: v.status,
    sortOrder: v.sortOrder,
  };
}

export function createVariantsService(deps: ProductsDeps) {
  const { db, repo, audit, clock, store } = deps;

  async function loadVariableProduct(productId: string) {
    const product = await repo.findCore(db, productId);
    if (product === null) throw notFound('Product');
    if (product.productType === 'SIMPLE') {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        'A SIMPLE product has exactly one (default) variant.',
        {
          details: [
            {
              code: 'SIMPLE_PRODUCT_SINGLE_VARIANT',
              message: 'Converting SIMPLE → VARIABLE is not supported yet.',
            },
          ],
        },
      );
    }
    return product;
  }

  /** Axis attribute IDs already used by the product's variants (incl. deleted), or null. */
  function existingAxes(
    variants: readonly { variantValues: readonly { attributeId: string }[] }[],
  ): string[] | null {
    const withValues = variants.find((v) => v.variantValues.length > 0);
    return withValues === undefined ? null : withValues.variantValues.map((v) => v.attributeId);
  }

  function sameSet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((x) => b.includes(x));
  }

  const service = {
    async list(productId: string, view: ViewOptions) {
      const product = await repo.findCore(db, productId);
      if (product === null) throw notFound('Product');
      const rows = await repo.listVariants(db, productId);
      return rows.map((v) => mapAdminVariant(v, view.canSeeCost));
    },

    async add(actor: AuditActor, productId: string, input: AxisVariantInput) {
      const product = await loadVariableProduct(productId);
      const existing = await repo.variantsWithValues(db, productId, true);
      const live = existing.filter((v) => v.deletedAt === null);
      if (live.length + 1 > MAX_VARIANTS_PER_PRODUCT) {
        throw invalid([
          {
            code: 'TOO_MANY_VARIANTS',
            message: `A product can have at most ${String(MAX_VARIANTS_PER_PRODUCT)} variants.`,
            meta: { current: live.length },
          },
        ]);
      }
      const values = await repo.attributeValues(db, input.attributeValueIds);
      const valueById = new Map(values.map((v) => [v.id, v]));
      const details: ErrorDetail[] = [];
      let axisIds = existingAxes(existing);
      if (axisIds === null) {
        // First variant defines the axes: one value per distinct variant-axis attribute.
        axisIds = values.map((v) => v.attributeId);
        const attributes = values.map((v) => v.attribute);
        details.push(...axisAttributeDetails(axisIds, attributes, () => 'attributeValueIds'));
      }
      const ordered =
        details.length === 0
          ? valuesForAxes(input.attributeValueIds, axisIds, valueById, 'attributeValueIds', details)
          : null;
      if (ordered === null || details.length > 0) throw invalid(details);

      const key = combinationKey(ordered.map((v) => v.id));
      const label = variantLabel(ordered);
      const clash = existing.find((v) => v.combinationKey === key);
      if (clash !== undefined) {
        throw new AppError('DUPLICATE_RESOURCE', `Combination "${label}" already exists.`, {
          details: [
            {
              field: 'attributeValueIds',
              code: 'DUPLICATE_COMBINATION',
              message: `Combination "${label}" already exists${clash.deletedAt === null ? '' : ' (deleted variant — restore it instead)'}.`,
              meta: {
                existingVariantId: clash.id,
                deleted: clash.deletedAt !== null,
                combinationKey: key,
              },
            },
          ],
        });
      }
      const draft = toDraft('variant', input, {
        name: label,
        label,
        combinationKey: key,
        isDefault: false,
        values: ordered.map((v) => ({ attributeId: v.attributeId, attributeValueId: v.id })),
        sortOrder: input.sortOrder ?? live.length,
      });
      const conflicts = await codeConflictDetails(repo, db, [draft]);
      if (conflicts.length > 0) {
        throw new AppError('DUPLICATE_RESOURCE', 'Some values are already in use.', {
          details: conflicts,
        });
      }
      const id = await withTransaction(db, async ({ tx }) => {
        const created = await insertVariant(tx, audit, actor, product.id, draft);
        await repo.refreshListingFields(tx, product.id);
        return created.id;
      });
      return {
        ...draftDto(id, draft),
        warnings:
          input.initialStock !== undefined && input.initialStock > 0
            ? [
                {
                  code: 'INITIAL_STOCK_NOT_APPLIED',
                  message: 'Record opening stock via POST /admin/inventory/movements.',
                },
              ]
            : [],
      };
    },

    async update(
      actor: AuditActor,
      variantId: string,
      input: UpdateVariantInput,
      view: ViewOptions,
    ) {
      const current = await repo.findVariant(db, variantId);
      if (current === null) throw notFound('Variant');
      assertNotStale(current.updatedAt, input.expectedUpdatedAt);

      const mrp = input.mrp ?? current.mrp.toFixed(2);
      const sellingPrice = input.sellingPrice ?? current.sellingPrice.toFixed(2);
      const compareAt =
        input.compareAtPrice === undefined
          ? (current.compareAtPrice?.toFixed(2) ?? null)
          : input.compareAtPrice;
      const details: ErrorDetail[] = [];
      if (dec(sellingPrice).gt(dec(mrp))) {
        details.push({
          field: 'sellingPrice',
          message: 'Selling price cannot be greater than MRP.',
        });
      }
      if (compareAt !== null && dec(compareAt).lt(dec(sellingPrice))) {
        details.push({
          field: 'compareAtPrice',
          message: 'Compare-at price cannot be lower than the selling price.',
        });
      }
      if (details.length > 0) throw invalid(details);

      const skuChanged = input.sku !== undefined && input.sku !== current.sku;
      const barcodeChanged = input.barcode !== undefined && input.barcode !== current.barcode;
      if (skuChanged) {
        // PROVISIONAL (workflow §7.5): SKU immutable once stock moved or ordered (labels/barcodes).
        const history = await repo.variantHistory(db, variantId);
        if (history.inventoryTxns > 0 || history.orderItems > 0) {
          throw conflict(
            'SKU_LOCKED',
            'The SKU cannot change after stock movements or orders exist for this variant.',
            history,
          );
        }
      }
      const taken: ErrorDetail[] = [];
      for (const field of ['sku', 'barcode'] as const) {
        const value = field === 'sku' ? input.sku : input.barcode;
        const changed = field === 'sku' ? skuChanged : barcodeChanged;
        if (!changed || value === undefined || value === null) continue;
        const hit = (await repo.findCodeConflicts(db, field, [value], variantId))[0];
        if (hit !== undefined) {
          taken.push({
            field,
            code: 'DUPLICATE_RESOURCE',
            message: `${field === 'sku' ? 'SKU' : 'Barcode'} ${value} is already used.`,
            meta: {
              existingVariantId: hit.id,
              productName: hit.product.name,
              deleted: hit.deletedAt !== null,
            },
          });
        }
      }
      if (taken.length > 0) {
        throw new AppError('DUPLICATE_RESOURCE', 'Some values are already in use.', {
          details: taken,
        });
      }

      const data = {
        ...(input.sku === undefined ? {} : { sku: input.sku }),
        ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
        ...(input.mrp === undefined ? {} : { mrp: input.mrp }),
        ...(input.sellingPrice === undefined ? {} : { sellingPrice: input.sellingPrice }),
        ...(input.compareAtPrice === undefined ? {} : { compareAtPrice: input.compareAtPrice }),
        ...(input.costPrice === undefined ? {} : { costPrice: input.costPrice }),
        ...(input.weightGrams === undefined ? {} : { weightGrams: input.weightGrams }),
        ...(input.lengthMm === undefined ? {} : { lengthMm: input.lengthMm }),
        ...(input.widthMm === undefined ? {} : { widthMm: input.widthMm }),
        ...(input.heightMm === undefined ? {} : { heightMm: input.heightMm }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      };
      await withTransaction(db, async ({ tx }) => {
        await tx.productVariant.update({
          where: { id: variantId },
          data: { ...data, updatedById: actor.userId ?? null },
          select: { id: true },
        });
        if (
          input.mrp !== undefined ||
          input.sellingPrice !== undefined ||
          input.status !== undefined
        ) {
          await repo.refreshListingFields(tx, current.productId);
        }
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ProductVariant',
          entityId: variantId,
          before: variantSnapshot(current),
          after: { ...variantSnapshot(current), ...data },
          metadata: { entityLabel: current.sku, productId: current.productId },
        });
      });
      const fresh = await repo.findVariant(db, variantId);
      if (fresh === null) throw notFound('Variant');
      return mapAdminVariant(fresh, view.canSeeCost);
    },

    async remove(actor: AuditActor, variantId: string) {
      const variant = await repo.findVariant(db, variantId);
      if (variant === null) throw notFound('Variant');
      if (variant.isDefault || variant.product.productType === 'SIMPLE') {
        throw conflict(
          'DEFAULT_VARIANT',
          'The default variant of a SIMPLE product cannot be deleted; archive or delete the product instead.',
        );
      }
      const siblings = await repo.variantsWithValues(db, variant.productId);
      if (siblings.length <= 1) {
        throw conflict('LAST_VARIANT', 'A product must keep at least one variant.');
      }
      const otherActive = siblings.filter((s) => s.id !== variantId && s.status === 'ACTIVE');
      if (variant.product.status === 'ACTIVE' && otherActive.length === 0) {
        throw conflict(
          'LAST_ACTIVE_VARIANT',
          'This is the last ACTIVE variant of an ACTIVE product; set the product INACTIVE first.',
        );
      }
      // PROVISIONAL (workflow §9): any order item, stock movement or reservation blocks deletion.
      const history = await repo.variantHistory(db, variantId);
      if (history.orderItems > 0 || history.inventoryTxns > 0 || history.reservations > 0) {
        throw conflict(
          'VARIANT_HAS_HISTORY',
          'This variant has orders, stock movements or reservations; deactivate it instead.',
          history,
        );
      }
      const now = clock();
      await withTransaction(db, async ({ tx }) => {
        await tx.productVariant.update({
          where: { id: variantId },
          data: { deletedAt: now, deletedById: actor.userId ?? null },
          select: { id: true },
        });
        await repo.refreshListingFields(tx, variant.productId);
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: 'ProductVariant',
          entityId: variantId,
          before: variantSnapshot(variant),
          after: null,
          metadata: { entityLabel: variant.sku, productId: variant.productId, softDelete: true },
        });
      });
      return { id: variantId, deleted: true };
    },

    async generate(
      actor: AuditActor,
      productId: string,
      mode: 'preview' | 'commit',
      input: GenerateVariantsInput,
    ) {
      const product = await loadVariableProduct(productId);
      const axisIds = input.axes.map((a) => a.attributeId);

      // ---- validate axes & values
      const allValueIds = input.axes.flatMap((a) => a.valueIds);
      const [attributes, values, existing] = await Promise.all([
        repo.attributes(db, axisIds),
        repo.attributeValues(db, allValueIds),
        repo.variantsWithValues(db, productId, true),
      ]);
      const details = axisAttributeDetails(
        axisIds,
        attributes,
        (i) => `axes[${String(i)}].attributeId`,
      );
      const valueById = new Map(values.map((v) => [v.id, v]));
      input.axes.forEach((axis, i) => {
        axis.valueIds.forEach((id, j) => {
          const value = valueById.get(id);
          const field = `axes[${String(i)}].valueIds[${String(j)}]`;
          if (!usableValue(value)) {
            details.push({
              field,
              code: 'ATTRIBUTE_VALUE_NOT_FOUND',
              message: 'Unknown or inactive value.',
            });
          } else if (value.attributeId !== axis.attributeId) {
            details.push({
              field,
              code: 'VALUE_NOT_IN_AXIS',
              message: `Value "${value.value}" belongs to another attribute.`,
            });
          }
        });
      });
      const currentAxes = existingAxes(existing);
      if (currentAxes !== null && !sameSet(currentAxes, axisIds)) {
        details.push({
          field: 'axes',
          code: 'AXIS_MISMATCH',
          message:
            "Axes must match the product's existing variant axes (adding/removing an axis is not supported).",
          meta: { existingAxes: currentAxes },
        });
      }
      const total = input.axes.reduce((n, a) => n * a.valueIds.length, 1);
      if (total > MAX_COMBINATIONS_PER_REQUEST) {
        details.push({
          field: 'axes',
          code: 'TOO_MANY_COMBINATIONS',
          message: `At most ${String(MAX_COMBINATIONS_PER_REQUEST)} combinations per request.`,
          meta: { count: total },
        });
      }
      if (details.length > 0) throw invalid(details);

      // ---- plan combinations
      const byKey = new Map(existing.map((v) => [v.combinationKey, v]));
      const plan: PlannedCombination[] = cartesian(
        input.axes.map((a) => a.valueIds.flatMap((id) => valueById.get(id) ?? [])),
      ).map((combo) => {
        const key = combinationKey(combo.map((v) => v.id));
        const label = variantLabel(combo);
        const hit = byKey.get(key);
        if (hit === undefined) return { combinationKey: key, label, values: combo, status: 'NEW' };
        return {
          combinationKey: key,
          label,
          values: combo,
          status: hit.deletedAt === null ? 'EXISTS' : 'EXISTS_DELETED',
          existingVariantId: hit.id,
          existingVariantStatus: hit.status,
          existingSku: hit.sku,
        };
      });

      const overrides = new Map((input.overrides ?? []).map((o) => [o.combinationKey, o]));
      const overrideDetails: ErrorDetail[] = [];
      (input.overrides ?? []).forEach((o, i) => {
        const row = plan.find((p) => p.combinationKey === o.combinationKey);
        if (row?.status !== 'NEW') {
          overrideDetails.push({
            field: `overrides[${String(i)}].combinationKey`,
            code: row === undefined ? 'UNKNOWN_COMBINATION' : 'COMBINATION_EXISTS',
            message:
              row === undefined
                ? 'This combination is not produced by the given axes.'
                : 'This combination already exists and is skipped.',
          });
        }
      });
      if (overrideDetails.length > 0) throw invalid(overrideDetails);

      // ---- SKU proposals
      const pattern = input.skuPattern ?? defaultSkuPattern(input.axes.length);
      const tokensOf = (combo: readonly AttributeValueRef[]) =>
        combo.map((v) => ({
          keys: [v.attribute.code.toLowerCase(), slugify(v.attribute.name)],
          code: valueCode(v.slug),
        }));
      const proposals = new Map<string, string>();
      for (const row of plan) {
        if (row.status !== 'NEW') continue;
        const override = overrides.get(row.combinationKey);
        if (override?.sku !== undefined) {
          proposals.set(row.combinationKey, override.sku);
          continue;
        }
        const built = buildSku(pattern, input.skuBase, tokensOf(row.values));
        if (!built.ok) {
          throw invalid([
            {
              field: built.token.toLowerCase() === 'base' ? 'skuBase' : 'skuPattern',
              code: 'SKU_PATTERN_INVALID',
              message:
                built.token.toLowerCase() === 'base'
                  ? 'skuBase is required when the pattern uses {BASE}.'
                  : `Unknown SKU pattern token {${built.token}}.`,
            },
          ]);
        }
        proposals.set(row.combinationKey, built.sku);
      }
      const proposedSkus = [...new Set(proposals.values())].filter(isValidSku);
      const skuHits = await repo.findCodeConflicts(db, 'sku', proposedSkus);
      const counts = new Map<string, number>();
      for (const sku of proposals.values()) counts.set(sku, (counts.get(sku) ?? 0) + 1);

      const newRows = plan.filter((p) => p.status === 'NEW');
      const toCreate = newRows.filter((p) => overrides.get(p.combinationKey)?.skip !== true);
      const liveCount = existing.filter((v) => v.deletedAt === null).length;

      const describe = (row: PlannedCombination) => {
        const base = {
          combinationKey: row.combinationKey,
          label: row.label,
          values: Object.fromEntries(row.values.map((v) => [v.attribute.code, v.slug])),
          status: row.status,
        };
        if (row.status !== 'NEW') {
          return {
            ...base,
            existingVariantId: row.existingVariantId,
            existingVariantStatus: row.existingVariantStatus,
            sku: row.existingSku,
          };
        }
        const override = overrides.get(row.combinationKey);
        const sku = proposals.get(row.combinationKey) ?? '';
        const hit = skuHits.find((h) => h.sku === sku);
        return {
          ...base,
          proposedSku: sku,
          skuValid: isValidSku(sku),
          skuAvailable: isValidSku(sku) && hit === undefined && (counts.get(sku) ?? 0) === 1,
          ...(hit === undefined
            ? {}
            : {
                skuConflict: {
                  variantId: hit.id,
                  productName: hit.product.name,
                  deleted: hit.deletedAt !== null,
                },
              }),
          mrp: override?.mrp ?? input.defaults.mrp,
          sellingPrice: override?.sellingPrice ?? input.defaults.sellingPrice,
          skip: override?.skip === true,
        };
      };

      const fingerprint = previewFingerprint({
        productId,
        axes: input.axes,
        defaults: input.defaults,
        skuBase: input.skuBase ?? null,
        skuPattern: input.skuPattern ?? null,
        existingKeys: [...byKey.keys()].sort(),
      });
      const storeKey = (token: string) => `variants-preview:${productId}:${token}`;

      if (mode === 'preview') {
        const token = `pvw_${ulid(clock().getTime())}`;
        store.set(storeKey(token), fingerprint, PREVIEW_TTL_SECONDS);
        const combinations = plan.map(describe);
        return {
          status: 200,
          data: {
            mode: 'preview' as const,
            previewToken: token,
            expiresAt: addMinutes(clock(), PREVIEW_TTL_SECONDS / 60).toISOString(),
            totalCombinations: plan.length,
            toCreate: toCreate.length,
            existing: plan.length - newRows.length,
            conflicts: combinations.filter((c) => 'skuAvailable' in c && !c.skuAvailable).length,
            maxVariantsExceeded: liveCount + toCreate.length > MAX_VARIANTS_PER_PRODUCT,
            combinations,
          },
        };
      }

      // ---- commit
      if (input.previewToken === undefined) {
        throw invalid([
          {
            field: 'previewToken',
            code: 'PREVIEW_REQUIRED',
            message: 'Run a preview first and send its previewToken.',
          },
        ]);
      }
      if (store.get(storeKey(input.previewToken)) !== fingerprint) {
        throw conflict(
          'PREVIEW_STALE',
          'The preview expired or no longer matches the product. Preview again before committing.',
        );
      }
      if (liveCount + toCreate.length > MAX_VARIANTS_PER_PRODUCT) {
        throw invalid([
          {
            code: 'TOO_MANY_VARIANTS',
            message: `A product can have at most ${String(MAX_VARIANTS_PER_PRODUCT)} variants.`,
            meta: { current: liveCount, toCreate: toCreate.length },
          },
        ]);
      }
      const drafts: VariantDraft[] = toCreate.map((row, i) => {
        const override = overrides.get(row.combinationKey);
        return {
          field: `combinations[${row.combinationKey}]`,
          label: row.label,
          sku: proposals.get(row.combinationKey) ?? '',
          barcode: override?.barcode ?? null,
          name: row.label,
          combinationKey: row.combinationKey,
          mrp: override?.mrp ?? input.defaults.mrp,
          sellingPrice: override?.sellingPrice ?? input.defaults.sellingPrice,
          compareAtPrice: input.defaults.compareAtPrice ?? null,
          costPrice: input.defaults.costPrice ?? null,
          weightGrams: input.defaults.weightGrams ?? null,
          lengthMm: null,
          widthMm: null,
          heightMm: null,
          status: input.defaults.status,
          isDefault: false,
          sortOrder: liveCount + i,
          lowStockThreshold: input.defaults.lowStockThreshold ?? null,
          values: row.values.map((v) => ({ attributeId: v.attributeId, attributeValueId: v.id })),
        };
      });
      const commitDetails: ErrorDetail[] = [];
      for (const d of drafts) {
        if (!isValidSku(d.sku)) {
          commitDetails.push({
            field: `${d.field}.sku`,
            code: 'SKU_INVALID',
            message: `Proposed SKU "${d.sku}" for "${d.label}" is invalid or longer than 32 characters; override it.`,
            meta: { combinationKey: d.combinationKey },
          });
        } else if ((counts.get(d.sku) ?? 0) > 1) {
          commitDetails.push({
            field: `${d.field}.sku`,
            code: 'DUPLICATE_SKU_IN_REQUEST',
            message: `SKU ${d.sku} is proposed for more than one combination.`,
            meta: { combinationKey: d.combinationKey },
          });
        }
        if (dec(d.sellingPrice).gt(dec(d.mrp))) {
          commitDetails.push({
            field: `${d.field}.sellingPrice`,
            message: `Selling price of "${d.label}" cannot be greater than MRP.`,
            meta: { combinationKey: d.combinationKey },
          });
        }
      }
      if (commitDetails.length > 0) throw invalid(commitDetails);
      const taken = await codeConflictDetails(repo, db, drafts);
      if (taken.length > 0) {
        // API §4.3: unresolved SKU/barcode conflicts at commit → 422 (admin must override).
        throw invalid(
          taken.map((t) => ({ ...t, code: 'SKU_CONFLICT' })),
          'Some proposed SKUs or barcodes are already in use; override them before committing.',
        );
      }

      const created = await withTransaction(db, async (txc) => {
        const { tx } = txc;
        const out: { id: string; sku: string; combinationKey: string; name: string }[] = [];
        for (const draft of drafts) {
          const v = await insertVariant(tx, audit, actor, product.id, draft);
          out.push({
            id: v.id,
            sku: draft.sku,
            combinationKey: draft.combinationKey,
            name: draft.name,
          });
        }
        await repo.refreshListingFields(tx, product.id);
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Product',
          entityId: product.id,
          diff: false,
          eventKey: 'products.variants.generated',
          metadata: {
            entityLabel: product.name,
            created: out.length,
            skipped: plan.length - out.length,
            axes: axisIds,
          },
        });
        txc.afterCommit(() => {
          store.delete(storeKey(input.previewToken ?? ''));
        });
        return out;
      });
      const skipped = plan
        .filter((p) => !created.some((c) => c.combinationKey === p.combinationKey))
        .map((p) => ({
          combinationKey: p.combinationKey,
          label: p.label,
          reason: p.status === 'NEW' ? 'SKIPPED' : p.status,
        }));
      const stockOverrides = (input.overrides ?? []).some(
        (o) => o.initialStock !== undefined && o.initialStock > 0,
      );
      return {
        status: 201,
        data: {
          mode: 'commit' as const,
          created,
          skipped,
          warnings: stockOverrides
            ? [
                {
                  code: 'INITIAL_STOCK_NOT_APPLIED',
                  message: 'Record opening stock via POST /admin/inventory/movements.',
                },
              ]
            : [],
        },
      };
    },
  };
  return service;
}

export type VariantsService = ReturnType<typeof createVariantsService>;
