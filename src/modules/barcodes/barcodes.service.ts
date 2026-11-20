/**
 * Barcode use-cases — API_DOCUMENTATION.md §4.6, PRODUCT_VARIANT_AND_INVENTORY_WORKFLOWS.md §14.
 *
 * Encoded value [PROPOSED]: the variant's `barcode`; when it has none, the SKU — and printing
 * labels assigns `barcode = SKU` so labels always scan back through `/admin/inventory/lookup`.
 * PROVISIONAL (OQ-40): Code 128; MRP wording on labels to be confirmed (legal metrology).
 */
import type { DbClient } from '../../core/db/transaction.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { toMoneyString } from '../../lib/money.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import {
  LAYOUTS,
  SYMBOLOGY,
  mayNotFit,
  renderBarcodePng,
  renderBarcodeSvg,
  renderLabelsPdf,
  type LabelSpec,
  type LayoutKey,
} from './barcodes.render.js';
import type {
  BarcodeImageInput,
  LabelFieldsInput,
  LabelsInput,
  PreviewInput,
} from './barcodes.schemas.js';

/** Sync PDF generation limit (BACKEND_STRUCTURE §18); larger jobs must be split. */
export const MAX_LABELS_PER_REQUEST = 500;
const PRODUCT_NAME_MAX = 24;

const DEFAULT_FIELDS: Required<LabelFieldsInput> = {
  productName: true,
  variantName: true,
  sku: true,
  mrp: true,
  sellingPrice: false,
  brandName: false,
};

export interface BarcodeServiceDeps {
  readonly db: DbClient;
  readonly audit: AuditService;
  readonly clock: () => Date;
}

interface VariantRow {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  mrp: { toString(): string };
  sellingPrice: { toString(): string };
  product: { name: string; brand: { name: string } | null };
}

interface ResolvedLabel {
  readonly variant: VariantRow;
  readonly copies: number;
}

export interface Warning {
  variantId: string;
  code: 'BARCODE_ASSIGNED_FROM_SKU' | 'BARCODE_MAY_NOT_FIT';
  message: string;
}

export interface BarcodeService {
  image(
    variantId: string,
    query: BarcodeImageInput,
  ): Promise<{ contentType: string; body: string | Buffer; encodedValue: string }>;
  preview(input: PreviewInput): Promise<Record<string, unknown>>;
  labels(
    actor: AuditActor,
    input: LabelsInput,
  ): Promise<{ pdf: Buffer; filename: string; totalLabels: number }>;
}

const VARIANT_SELECT = {
  id: true,
  sku: true,
  barcode: true,
  name: true,
  mrp: true,
  sellingPrice: true,
  productId: true,
  sortOrder: true,
  product: { select: { name: true, brand: { select: { name: true } } } },
} as const;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function labelLines(variant: VariantRow, fields: Required<LabelFieldsInput>): string[] {
  const lines: string[] = [];
  if (fields.brandName && variant.product.brand !== null) lines.push(variant.product.brand.name);
  if (fields.productName) lines.push(truncate(variant.product.name, PRODUCT_NAME_MAX));
  if (fields.variantName) lines.push(variant.name);
  if (fields.mrp) lines.push(`MRP ₹${toMoneyString(variant.mrp.toString())} (incl. of all taxes)`);
  if (fields.sellingPrice) lines.push(`Price ₹${toMoneyString(variant.sellingPrice.toString())}`);
  return lines;
}

const encodedValueOf = (variant: VariantRow): string => variant.barcode ?? variant.sku;

function warningsFor(labels: readonly ResolvedLabel[], layout: LayoutKey): Warning[] {
  const warnings: Warning[] = [];
  for (const { variant } of labels) {
    if (variant.barcode === null) {
      warnings.push({
        variantId: variant.id,
        code: 'BARCODE_ASSIGNED_FROM_SKU',
        message: 'No barcode on file; the SKU is encoded and saved as the barcode when printed.',
      });
    }
    if (mayNotFit(encodedValueOf(variant), layout)) {
      warnings.push({
        variantId: variant.id,
        code: 'BARCODE_MAY_NOT_FIT',
        message: 'The value is long for this label width and may not scan reliably.',
      });
    }
  }
  return warnings;
}

/** `labels-YYYYMMDD-HHmm.pdf` in IST (fixed +05:30, no DST). */
export function filenameFor(now: Date): string {
  const ist = new Date(now.getTime() + 330 * 60_000).toISOString();
  return `labels-${ist.slice(0, 10).replace(/-/g, '')}-${ist.slice(11, 16).replace(':', '')}.pdf`;
}

export function createBarcodeService(deps: BarcodeServiceDeps): BarcodeService {
  const { db, audit, clock } = deps;

  async function resolveItems(input: PreviewInput): Promise<ResolvedLabel[]> {
    const variantIds: string[] = [];
    const productIds: string[] = [];
    for (const item of input.items) {
      if ('variantId' in item) variantIds.push(item.variantId);
      else productIds.push(item.productId);
    }
    const rows = await db.productVariant.findMany({
      where: {
        deletedAt: null,
        OR: [
          ...(variantIds.length > 0 ? [{ id: { in: variantIds } }] : []),
          ...(productIds.length > 0 ? [{ productId: { in: productIds } }] : []),
        ],
      },
      select: VARIANT_SELECT,
      orderBy: [{ productId: 'asc' }, { sortOrder: 'asc' }, { sku: 'asc' }],
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const details: ErrorDetail[] = [];
    const resolved: ResolvedLabel[] = [];
    input.items.forEach((item, index) => {
      if ('variantId' in item) {
        const variant = byId.get(item.variantId);
        if (variant === undefined) {
          details.push({
            field: `items[${String(index)}].variantId`,
            message: 'Variant not found.',
          });
        } else {
          resolved.push({ variant, copies: item.copies });
        }
        return;
      }
      const variants = rows.filter((r) => r.productId === item.productId);
      if (variants.length === 0) {
        details.push({
          field: `items[${String(index)}].productId`,
          message: 'Product not found or has no variants.',
        });
      }
      for (const variant of variants) resolved.push({ variant, copies: item.copiesEach });
    });
    if (details.length > 0) throw new AppError('VALIDATION_ERROR', undefined, { details });

    // Merge repeated variants (copies add up).
    const merged = new Map<string, ResolvedLabel>();
    for (const label of resolved) {
      const prev = merged.get(label.variant.id);
      merged.set(label.variant.id, {
        variant: label.variant,
        copies: (prev?.copies ?? 0) + label.copies,
      });
    }
    const list = [...merged.values()];
    const total = list.reduce((acc, l) => acc + l.copies, 0);
    if (total > MAX_LABELS_PER_REQUEST) {
      throw new AppError('VALIDATION_ERROR', 'Too many labels in one request.', {
        details: [
          {
            field: 'items',
            code: 'TOO_MANY_LABELS',
            message: `At most ${String(MAX_LABELS_PER_REQUEST)} labels per request; split the job.`,
            meta: { requested: total, max: MAX_LABELS_PER_REQUEST },
          },
        ],
      });
    }
    return list;
  }

  return {
    async image(variantId, query) {
      const variant = await db.productVariant.findFirst({
        where: { id: variantId, deletedAt: null },
        select: { sku: true, barcode: true },
      });
      if (variant === null) throw new AppError('NOT_FOUND', 'Variant not found.');
      const value = variant.barcode ?? variant.sku;
      const options = {
        scale: query.scale,
        heightMm: query.height,
        includeText: query.includeText,
      };
      if (query.format === 'png') {
        return {
          contentType: 'image/png',
          body: await renderBarcodePng(value, options),
          encodedValue: value,
        };
      }
      return {
        contentType: 'image/svg+xml',
        body: renderBarcodeSvg(value, options),
        encodedValue: value,
      };
    },

    async preview(input) {
      const labels = await resolveItems(input);
      const fields = { ...DEFAULT_FIELDS, ...input.fields };
      const layout = LAYOUTS[input.layout];
      return {
        layout: input.layout,
        labelSizeMm: { width: layout.labelWidthMm, height: layout.labelHeightMm },
        totalLabels: labels.reduce((acc, l) => acc + l.copies, 0),
        labels: labels.map(({ variant, copies }) => ({
          variantId: variant.id,
          sku: variant.sku,
          copies,
          encodedValue: encodedValueOf(variant),
          symbology: SYMBOLOGY,
          lines: labelLines(variant, fields),
          caption: fields.sku ? variant.sku : null,
          svg: renderBarcodeSvg(encodedValueOf(variant), {
            scale: 2,
            heightMm: 8,
            includeText: false,
          }),
        })),
        warnings: warningsFor(labels, input.layout),
      };
    },

    async labels(actor, input) {
      const labels = await resolveItems(input);
      const fields = { ...DEFAULT_FIELDS, ...input.fields };
      const now = clock();
      const toAssign = labels.filter((l) => l.variant.barcode === null).map((l) => l.variant);

      // Render first (pure, outside the transaction), then persist barcode + audit atomically.
      const specs: LabelSpec[] = labels.flatMap(({ variant, copies }) =>
        Array.from({ length: copies }, () => ({
          encodedValue: encodedValueOf(variant),
          lines: labelLines(variant, fields),
          caption: fields.sku ? variant.sku : null,
        })),
      );
      const pdf = await renderLabelsPdf(input.layout, specs, {
        startPosition: input.startPosition,
        title: 'Barcode labels',
        now,
      });

      await withTransaction(db, async ({ tx }) => {
        if (toAssign.length > 0) {
          const clash = await tx.productVariant.findMany({
            where: {
              barcode: { in: toAssign.map((v) => v.sku) },
              id: { notIn: toAssign.map((v) => v.id) },
            },
            select: { id: true, barcode: true },
          });
          if (clash.length > 0) {
            throw new AppError('CONFLICT', 'A SKU is already used as another variant’s barcode.', {
              details: clash.map((c) => ({
                code: 'BARCODE_CONFLICT',
                message: 'Barcode already assigned to another variant.',
                meta: { variantId: c.id, barcode: c.barcode },
              })),
            });
          }
          for (const variant of toAssign) {
            await tx.productVariant.updateMany({
              where: { id: variant.id, barcode: null },
              data: {
                barcode: variant.sku,
                ...(actor.userId === undefined ? {} : { updatedById: actor.userId }),
              },
            });
          }
        }
        await audit.record(tx, actor, {
          action: 'PRINT',
          module: 'barcodes',
          entityType: 'ProductVariant',
          entityId: labels.length === 1 ? (labels[0]?.variant.id ?? null) : null,
          diff: false,
          metadata: {
            layout: input.layout,
            startPosition: input.startPosition,
            totalLabels: specs.length,
            variants: labels.map((l) => ({
              variantId: l.variant.id,
              sku: l.variant.sku,
              copies: l.copies,
            })),
            barcodesAssigned: toAssign.map((v) => v.id),
          },
        });
      });

      return { pdf, filename: filenameFor(now), totalLabels: specs.length };
    },
  };
}
