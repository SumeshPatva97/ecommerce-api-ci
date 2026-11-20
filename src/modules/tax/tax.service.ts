/**
 * Tax service — admin tax masters (rates, HSN codes, effective-dated assignments), GST settings,
 * configuration preview, and the rate-resolution API used by checkout.
 * API_DOCUMENTATION.md §4.10, TAX_AND_GST_WORKFLOWS.md §3–§5, §21, §23–§24.
 *
 * No tax rate is hard-coded [CONFIRMED]: every rate comes from `tax_rates` via
 * `product_tax_assignments` (effective-dated, IST calendar dates — see lib/tax/resolution.ts).
 *
 * Schema note: the approved `tax_rates` table has no effective-date columns (only `is_active`);
 * effective dating lives on `product_tax_assignments`. A rate change = new rate row + new
 * assignment window (the old assignment is end-dated).
 */
import type { DbClient, Queryable } from '../../core/db/transaction.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { isPrismaKnownError } from '../../core/errors/prismaErrorMapper.js';
import { toSkipTake } from '../../core/http/pagination.js';
import { dec, type Decimal } from '../../lib/money.js';
import { normalizeText } from '../../lib/normalize.js';
import {
  TaxEngineError,
  computeTax,
  deriveComponentRates,
  gstinStateCode,
  isValidGstin,
  selectAssignment,
  toIstDateString,
  toTaxResultDto,
  windowsOverlap,
  type AssignmentSource,
  type EffectiveWindow,
} from '../../lib/tax/index.js';
import { addDays, istDayRange, startOfIstDay } from '../../lib/time.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import {
  toAssignmentDto,
  toHsnDto,
  toTaxRateDto,
  type AssignmentRow,
  type TaxRateRow,
} from './tax.mapper.js';
import type {
  CreateAssignmentInput,
  CreateHsnInput,
  CreateRateInput,
  ListAssignmentsInput,
  ListHsnInput,
  ListRatesInput,
  PreviewInput,
  UpdateAssignmentInput,
  UpdateHsnInput,
  UpdateRateInput,
  UpdateTaxSettingsInput,
} from './tax.schemas.js';
import { loadTaxSettings, saveTaxSettings, type TaxSettings } from './tax.settings.js';

// ── Rate resolution (public API for checkout) ───────────────────────────────────────────────

export type RateResolutionFailure =
  'PRODUCT_NOT_FOUND' | 'NO_ASSIGNMENT' | 'RATE_INACTIVE' | 'HSN_MISSING';

export type RateResolution =
  | {
      readonly ok: true;
      readonly productId: string;
      readonly taxRateId: string;
      readonly taxRateName: string;
      readonly ratePercent: Decimal;
      readonly hsnCode: string;
      readonly assignmentId: string;
      readonly source: AssignmentSource;
      /** Category whose assignment applied (`null` for a product-level assignment). */
      readonly sourceCategoryId: string | null;
    }
  | { readonly ok: false; readonly productId: string; readonly reason: RateResolutionFailure };

/** Max category depth is 3 (PROJECT_CONTEXT); a small guard against malformed cycles. */
const MAX_CATEGORY_HOPS = 5;

/**
 * Resolves HSN + rate for each product at instant `at` (checkout passes `placed_at`/quote time;
 * the IST calendar date decides). Precedence: product assignment → nearest category → ancestors.
 * Never returns a silent 0 %: unresolved products come back as `{ ok: false, reason }` and the
 * caller must block the line (TAX_AND_GST_WORKFLOWS §5 checkout guard).
 *
 * Pass the transaction client when called inside the order-placement transaction.
 */
export async function resolveRates(
  tx: Queryable,
  productIds: readonly string[],
  at: Date,
): Promise<ReadonlyMap<string, RateResolution>> {
  const ids = [...new Set(productIds)];
  const out = new Map<string, RateResolution>();
  if (ids.length === 0) return out;

  const products = await tx.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, categoryId: true, hsnCode: true },
  });
  const parentOf = new Map<string, string | null>();
  let pending = [...new Set(products.map((p) => p.categoryId))];
  for (let hop = 0; hop < MAX_CATEGORY_HOPS && pending.length > 0; hop += 1) {
    const rows = await tx.category.findMany({
      where: { id: { in: pending } },
      select: { id: true, parentId: true },
    });
    for (const row of rows) parentOf.set(row.id, row.parentId);
    pending = rows
      .map((r) => r.parentId)
      .filter((id): id is string => id !== null && !parentOf.has(id));
  }
  const chainOf = (categoryId: string): string[] => {
    const chain: string[] = [];
    let current: string | null | undefined = categoryId;
    while (
      current !== null &&
      current !== undefined &&
      !chain.includes(current) &&
      chain.length <= MAX_CATEGORY_HOPS
    ) {
      chain.push(current);
      current = parentOf.get(current);
    }
    return chain;
  };

  const assignments = await tx.productTaxAssignment.findMany({
    where: {
      effectiveFrom: { lte: at },
      AND: [
        { OR: [{ productId: { in: ids } }, { categoryId: { in: [...parentOf.keys()] } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gte: startOfIstDay(at) } }] },
      ],
    },
    select: {
      id: true,
      targetType: true,
      productId: true,
      categoryId: true,
      taxRateId: true,
      hsnCode: true,
      effectiveFrom: true,
      effectiveTo: true,
      taxRate: { select: { id: true, name: true, rate: true, isActive: true } },
    },
  });

  const byId = new Map(products.map((p) => [p.id, p]));
  for (const productId of ids) {
    const product = byId.get(productId);
    if (product === undefined) {
      out.set(productId, { ok: false, productId, reason: 'PRODUCT_NOT_FOUND' });
      continue;
    }
    const selected = selectAssignment(assignments, productId, chainOf(product.categoryId), at);
    if (typeof selected === 'string') {
      out.set(productId, { ok: false, productId, reason: selected });
      continue;
    }
    const hsnCode = selected.assignment.hsnCode ?? product.hsnCode;
    if (hsnCode === null) {
      out.set(productId, { ok: false, productId, reason: 'HSN_MISSING' });
      continue;
    }
    out.set(productId, {
      ok: true,
      productId,
      taxRateId: selected.assignment.taxRate.id,
      taxRateName: selected.assignment.taxRate.name,
      ratePercent: dec(selected.assignment.taxRate.rate),
      hsnCode,
      assignmentId: selected.assignment.id,
      source: selected.source,
      sourceCategoryId: selected.categoryId,
    });
  }
  return out;
}

// ── Errors ───────────────────────────────────────────────────────────────────────────────────

const notFound = (what: string): AppError => new AppError('NOT_FOUND', `${what} not found.`);
const invalid = (details: ErrorDetail[]): AppError =>
  new AppError('VALIDATION_ERROR', undefined, { details });
const inUse = (message: string, meta?: Record<string, unknown>): AppError =>
  new AppError('CONFLICT', message, {
    details: [{ code: 'IN_USE', message, ...(meta === undefined ? {} : { meta }) }],
  });

function duplicate(field: string, message: string): (error: unknown) => never {
  return (error) => {
    if (isPrismaKnownError(error) && error.code === 'P2002') {
      throw new AppError('DUPLICATE_RESOURCE', message, {
        details: [{ field, message: 'Must be unique.' }],
      });
    }
    throw error;
  };
}

// ── Service ──────────────────────────────────────────────────────────────────────────────────

export interface TaxServiceDeps {
  readonly db: DbClient;
  readonly audit: AuditService;
  readonly clock: () => Date;
}

export interface Paged<T> {
  readonly items: T[];
  readonly total: number;
}

type Dto = Record<string, unknown>;

export interface TaxService {
  listRates(query: ListRatesInput): Promise<Paged<Dto>>;
  getRate(id: string): Promise<Dto>;
  createRate(actor: AuditActor, input: CreateRateInput): Promise<Dto>;
  updateRate(actor: AuditActor, id: string, input: UpdateRateInput): Promise<Dto>;
  deleteRate(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }>;

  listHsnCodes(query: ListHsnInput): Promise<Paged<Dto>>;
  getHsnCode(id: string): Promise<Dto>;
  createHsnCode(actor: AuditActor, input: CreateHsnInput): Promise<Dto>;
  updateHsnCode(actor: AuditActor, id: string, input: UpdateHsnInput): Promise<Dto>;
  deleteHsnCode(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }>;

  listAssignments(query: ListAssignmentsInput): Promise<Paged<Dto>>;
  getAssignment(id: string): Promise<Dto>;
  createAssignment(actor: AuditActor, input: CreateAssignmentInput): Promise<Dto>;
  updateAssignment(actor: AuditActor, id: string, input: UpdateAssignmentInput): Promise<Dto>;
  deleteAssignment(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }>;

  getSettings(db?: Queryable): Promise<TaxSettings>;
  updateSettings(actor: AuditActor, input: UpdateTaxSettingsInput): Promise<TaxSettings>;

  preview(input: PreviewInput): Promise<Dto>;
  resolveRates(
    tx: Queryable,
    productIds: readonly string[],
    at: Date,
  ): Promise<ReadonlyMap<string, RateResolution>>;
}

const RATE_SELECT = {
  id: true,
  name: true,
  rate: true,
  cgstRate: true,
  sgstRate: true,
  utgstRate: true,
  igstRate: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const HSN_SELECT = {
  id: true,
  hsnCode: true,
  description: true,
  defaultTaxRateId: true,
  createdAt: true,
  updatedAt: true,
  defaultTaxRate: { select: { id: true, name: true, rate: true } },
} as const;

const ASSIGNMENT_SELECT = {
  id: true,
  targetType: true,
  productId: true,
  categoryId: true,
  taxRateId: true,
  hsnCode: true,
  effectiveFrom: true,
  effectiveTo: true,
  createdAt: true,
  updatedAt: true,
  taxRate: { select: { id: true, name: true, rate: true, isActive: true } },
  hsn: { select: { id: true, hsnCode: true } },
  product: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
} as const;

const AUDIT_MODULE = 'tax';

function rateAuditView(row: TaxRateRow): Record<string, unknown> {
  return { name: row.name, rate: row.rate.toFixed(2), isActive: row.isActive };
}

function assignmentAuditView(row: AssignmentRow): Record<string, unknown> {
  return {
    targetType: row.targetType,
    productId: row.productId,
    categoryId: row.categoryId,
    taxRateId: row.taxRateId,
    hsnCode: row.hsnCode,
    effectiveFrom: toIstDateString(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : toIstDateString(row.effectiveTo),
  };
}

const istDate = (value: string): Date => istDayRange(value).start;

export function createTaxService(deps: TaxServiceDeps): TaxService {
  const { db, audit, clock } = deps;

  async function lockAssignmentTarget(
    tx: Queryable,
    targetType: 'PRODUCT' | 'CATEGORY',
    targetId: string,
  ): Promise<void> {
    // Serializes concurrent writers for one target (MySQL cannot express range exclusion).
    if (targetType === 'PRODUCT') {
      await tx.$queryRaw`SELECT id FROM product_tax_assignments WHERE product_id = ${targetId} FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT id FROM product_tax_assignments WHERE category_id = ${targetId} FOR UPDATE`;
    }
  }

  async function assertNoOverlap(
    tx: Queryable,
    targetType: 'PRODUCT' | 'CATEGORY',
    targetId: string,
    window: EffectiveWindow,
    excludeId?: string,
  ): Promise<void> {
    await lockAssignmentTarget(tx, targetType, targetId);
    const existing = await tx.productTaxAssignment.findMany({
      where: targetType === 'PRODUCT' ? { productId: targetId } : { categoryId: targetId },
      select: { id: true, effectiveFrom: true, effectiveTo: true },
    });
    const clash = existing.find((e) => e.id !== excludeId && windowsOverlap(e, window));
    if (clash !== undefined) {
      throw new AppError('CONFLICT', 'The effective dates overlap an existing assignment.', {
        details: [
          {
            field: 'effectiveFrom',
            code: 'OVERLAPPING_ASSIGNMENT',
            message: 'Another assignment for this target covers these dates.',
            meta: {
              assignmentId: clash.id,
              effectiveFrom: toIstDateString(clash.effectiveFrom),
              effectiveTo: clash.effectiveTo === null ? null : toIstDateString(clash.effectiveTo),
            },
          },
        ],
      });
    }
  }

  async function requireActiveRate(tx: Queryable, id: string, field: string): Promise<void> {
    const rate = await tx.taxRate.findUnique({ where: { id }, select: { isActive: true } });
    if (rate === null) throw invalid([{ field, message: 'Tax rate not found.' }]);
    if (!rate.isActive) throw invalid([{ field, message: 'Tax rate is inactive.' }]);
  }

  async function requireHsn(tx: Queryable, id: string): Promise<string> {
    const hsn = await tx.hsnCode.findUnique({ where: { id }, select: { hsnCode: true } });
    if (hsn === null) throw invalid([{ field: 'hsnCodeId', message: 'HSN code not found.' }]);
    return hsn.hsnCode;
  }

  async function loadAssignment(tx: Queryable, id: string): Promise<AssignmentRow> {
    const row = await tx.productTaxAssignment.findUnique({
      where: { id },
      select: ASSIGNMENT_SELECT,
    });
    if (row === null) throw notFound('Tax assignment');
    return row;
  }

  const service: TaxService = {
    // ── Rates ──
    async listRates(query) {
      const where = {
        ...(query.q === undefined ? {} : { nameNormalized: { contains: normalizeText(query.q) } }),
        ...(query.status === undefined ? {} : { isActive: query.status === 'ACTIVE' }),
      };
      const [rows, total] = await Promise.all([
        db.taxRate.findMany({
          where,
          select: RATE_SELECT,
          orderBy: [{ rate: 'asc' }, { name: 'asc' }],
          ...toSkipTake(query.page, query.limit),
        }),
        db.taxRate.count({ where }),
      ]);
      return { items: rows.map(toTaxRateDto), total };
    },

    async getRate(id) {
      const row = await db.taxRate.findUnique({
        where: { id },
        select: { ...RATE_SELECT, _count: { select: { assignments: true, hsnCodes: true } } },
      });
      if (row === null) throw notFound('Tax rate');
      return toTaxRateDto(row);
    },

    async createRate(actor, input) {
      const components = deriveComponentRates(input.ratePercent);
      if (components === undefined) {
        throw invalid([
          { field: 'ratePercent', message: 'Half of the rate must have at most 2 decimals.' },
        ]);
      }
      return withTransaction(db, async ({ tx }) => {
        const row = await tx.taxRate.create({
          data: {
            name: input.name,
            nameNormalized: normalizeText(input.name),
            rate: components.rate,
            cgstRate: components.cgstRate,
            sgstRate: components.sgstRate,
            utgstRate: components.utgstRate,
            igstRate: components.igstRate,
            isActive: input.status === 'ACTIVE',
          },
          select: RATE_SELECT,
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: AUDIT_MODULE,
          entityType: 'TaxRate',
          entityId: row.id,
          after: rateAuditView(row),
          metadata: { entityLabel: row.name },
        });
        return toTaxRateDto(row);
      }).catch(duplicate('name', 'A tax rate with this name already exists.'));
    },

    async updateRate(actor, id, input) {
      return withTransaction(db, async ({ tx }) => {
        const existing = await tx.taxRate.findUnique({ where: { id }, select: RATE_SELECT });
        if (existing === null) throw notFound('Tax rate');
        const data: Record<string, unknown> = {};
        if (input.name !== undefined) {
          data.name = input.name;
          data.nameNormalized = normalizeText(input.name);
        }
        if (input.ratePercent !== undefined && !dec(input.ratePercent).equals(existing.rate)) {
          const components = deriveComponentRates(input.ratePercent);
          if (components === undefined) {
            throw invalid([
              { field: 'ratePercent', message: 'Half of the rate must have at most 2 decimals.' },
            ]);
          }
          const [assignments, orderLines] = await Promise.all([
            tx.productTaxAssignment.count({ where: { taxRateId: id } }),
            tx.orderItem.count({ where: { taxRateIdSnapshot: id } }),
          ]);
          if (assignments + orderLines > 0) {
            throw inUse(
              'This rate is in use; create a new rate and a new effective-dated assignment instead.',
              { assignments, orderLines },
            );
          }
          Object.assign(data, {
            rate: components.rate,
            cgstRate: components.cgstRate,
            sgstRate: components.sgstRate,
            utgstRate: components.utgstRate,
            igstRate: components.igstRate,
          });
        }
        if (input.status !== undefined) {
          const isActive = input.status === 'ACTIVE';
          if (!isActive && existing.isActive) {
            const live = await tx.productTaxAssignment.count({
              where: {
                taxRateId: id,
                OR: [{ effectiveTo: null }, { effectiveTo: { gte: startOfIstDay(clock()) } }],
              },
            });
            if (live > 0) {
              throw inUse('This rate is used by current or future assignments.', {
                assignments: live,
              });
            }
          }
          data.isActive = isActive;
        }
        const row = await tx.taxRate.update({ where: { id }, data, select: RATE_SELECT });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: AUDIT_MODULE,
          entityType: 'TaxRate',
          entityId: id,
          before: rateAuditView(existing),
          after: rateAuditView(row),
          metadata: { entityLabel: row.name },
        });
        return toTaxRateDto(row);
      }).catch(duplicate('name', 'A tax rate with this name already exists.'));
    },

    async deleteRate(actor, id) {
      return withTransaction(db, async ({ tx }) => {
        const existing = await tx.taxRate.findUnique({ where: { id }, select: RATE_SELECT });
        if (existing === null) throw notFound('Tax rate');
        const [assignments, hsnDefaults, orderLines] = await Promise.all([
          tx.productTaxAssignment.count({ where: { taxRateId: id } }),
          tx.hsnCode.count({ where: { defaultTaxRateId: id } }),
          tx.orderItem.count({ where: { taxRateIdSnapshot: id } }),
        ]);
        if (assignments + hsnDefaults + orderLines > 0) {
          throw inUse('This rate is in use and cannot be deleted.', {
            assignments,
            hsnDefaults,
            orderLines,
          });
        }
        await tx.taxRate.delete({ where: { id } });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: AUDIT_MODULE,
          entityType: 'TaxRate',
          entityId: id,
          before: rateAuditView(existing),
          metadata: { entityLabel: existing.name },
        });
        return { id, deleted: true as const };
      });
    },

    // ── HSN codes ──
    async listHsnCodes(query) {
      const where =
        query.q === undefined
          ? {}
          : {
              OR: [{ hsnCode: { startsWith: query.q } }, { description: { contains: query.q } }],
            };
      const [rows, total] = await Promise.all([
        db.hsnCode.findMany({
          where,
          select: HSN_SELECT,
          orderBy: { hsnCode: 'asc' },
          ...toSkipTake(query.page, query.limit),
        }),
        db.hsnCode.count({ where }),
      ]);
      return { items: rows.map(toHsnDto), total };
    },

    async getHsnCode(id) {
      const row = await db.hsnCode.findUnique({ where: { id }, select: HSN_SELECT });
      if (row === null) throw notFound('HSN code');
      return toHsnDto(row);
    },

    async createHsnCode(actor, input) {
      return withTransaction(db, async ({ tx }) => {
        if (input.defaultTaxRateId !== undefined && input.defaultTaxRateId !== null) {
          await requireActiveRate(tx, input.defaultTaxRateId, 'defaultTaxRateId');
        }
        const row = await tx.hsnCode.create({
          data: {
            hsnCode: input.hsnCode,
            description: input.description ?? null,
            defaultTaxRateId: input.defaultTaxRateId ?? null,
          },
          select: HSN_SELECT,
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: AUDIT_MODULE,
          entityType: 'HsnCode',
          entityId: row.id,
          after: {
            hsnCode: row.hsnCode,
            description: row.description,
            defaultTaxRateId: row.defaultTaxRateId,
          },
          metadata: { entityLabel: row.hsnCode },
        });
        return toHsnDto(row);
      }).catch(duplicate('hsnCode', 'This HSN code already exists.'));
    },

    async updateHsnCode(actor, id, input) {
      return withTransaction(db, async ({ tx }) => {
        const existing = await tx.hsnCode.findUnique({ where: { id }, select: HSN_SELECT });
        if (existing === null) throw notFound('HSN code');
        if (input.hsnCode !== undefined && input.hsnCode !== existing.hsnCode) {
          const [products, assignments] = await Promise.all([
            tx.product.count({ where: { hsnCode: existing.hsnCode } }),
            tx.productTaxAssignment.count({ where: { hsnCode: existing.hsnCode } }),
          ]);
          if (products + assignments > 0) {
            throw inUse('This HSN code is in use; its code cannot be changed.', {
              products,
              assignments,
            });
          }
        }
        if (input.defaultTaxRateId !== undefined && input.defaultTaxRateId !== null) {
          await requireActiveRate(tx, input.defaultTaxRateId, 'defaultTaxRateId');
        }
        const row = await tx.hsnCode.update({
          where: { id },
          data: {
            ...(input.hsnCode === undefined ? {} : { hsnCode: input.hsnCode }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.defaultTaxRateId === undefined
              ? {}
              : { defaultTaxRateId: input.defaultTaxRateId }),
          },
          select: HSN_SELECT,
        });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: AUDIT_MODULE,
          entityType: 'HsnCode',
          entityId: id,
          before: {
            hsnCode: existing.hsnCode,
            description: existing.description,
            defaultTaxRateId: existing.defaultTaxRateId,
          },
          after: {
            hsnCode: row.hsnCode,
            description: row.description,
            defaultTaxRateId: row.defaultTaxRateId,
          },
          metadata: { entityLabel: row.hsnCode },
        });
        return toHsnDto(row);
      }).catch(duplicate('hsnCode', 'This HSN code already exists.'));
    },

    async deleteHsnCode(actor, id) {
      return withTransaction(db, async ({ tx }) => {
        const existing = await tx.hsnCode.findUnique({ where: { id }, select: HSN_SELECT });
        if (existing === null) throw notFound('HSN code');
        const [products, assignments] = await Promise.all([
          tx.product.count({ where: { hsnCode: existing.hsnCode } }),
          tx.productTaxAssignment.count({ where: { hsnCode: existing.hsnCode } }),
        ]);
        if (products + assignments > 0) {
          throw inUse('This HSN code is in use and cannot be deleted.', { products, assignments });
        }
        await tx.hsnCode.delete({ where: { id } });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: AUDIT_MODULE,
          entityType: 'HsnCode',
          entityId: id,
          before: { hsnCode: existing.hsnCode, description: existing.description },
          metadata: { entityLabel: existing.hsnCode },
        });
        return { id, deleted: true as const };
      });
    },

    // ── Assignments ──
    async listAssignments(query) {
      const conditions: Record<string, unknown>[] = [];
      if (query.targetType !== undefined) conditions.push({ targetType: query.targetType });
      if (query.targetId !== undefined) {
        conditions.push({ OR: [{ productId: query.targetId }, { categoryId: query.targetId }] });
      }
      if (query.taxRateId !== undefined) conditions.push({ taxRateId: query.taxRateId });
      if (query.activeOn !== undefined) {
        const start = istDate(query.activeOn);
        conditions.push(
          { effectiveFrom: { lte: start } },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
        );
      }
      const where = conditions.length === 0 ? {} : { AND: conditions };
      const [rows, total] = await Promise.all([
        db.productTaxAssignment.findMany({
          where,
          select: ASSIGNMENT_SELECT,
          orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
          ...toSkipTake(query.page, query.limit),
        }),
        db.productTaxAssignment.count({ where }),
      ]);
      const now = clock();
      return { items: rows.map((r) => toAssignmentDto(r, now)), total };
    },

    async getAssignment(id) {
      return toAssignmentDto(await loadAssignment(db, id), clock());
    },

    async createAssignment(actor, input) {
      return withTransaction(db, async ({ tx }) => {
        if (input.targetType === 'PRODUCT') {
          const product = await tx.product.findFirst({
            where: { id: input.targetId, deletedAt: null },
            select: { id: true },
          });
          if (product === null)
            throw invalid([{ field: 'targetId', message: 'Product not found.' }]);
        } else {
          const category = await tx.category.findFirst({
            where: { id: input.targetId, deletedAt: null },
            select: { id: true },
          });
          if (category === null) {
            throw invalid([{ field: 'targetId', message: 'Category not found.' }]);
          }
        }
        const hsnCode = await requireHsn(tx, input.hsnCodeId);
        await requireActiveRate(tx, input.taxRateId, 'taxRateId');
        const window = {
          effectiveFrom: istDate(input.effectiveFrom),
          effectiveTo:
            input.effectiveTo === undefined || input.effectiveTo === null
              ? null
              : istDate(input.effectiveTo),
        };
        await assertNoOverlap(tx, input.targetType, input.targetId, window);
        const created = await tx.productTaxAssignment.create({
          data: {
            targetType: input.targetType,
            productId: input.targetType === 'PRODUCT' ? input.targetId : null,
            categoryId: input.targetType === 'CATEGORY' ? input.targetId : null,
            taxRateId: input.taxRateId,
            hsnCode,
            ...window,
          },
          select: ASSIGNMENT_SELECT,
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: AUDIT_MODULE,
          entityType: 'ProductTaxAssignment',
          entityId: created.id,
          after: assignmentAuditView(created),
        });
        return toAssignmentDto(created, clock());
      });
    },

    async updateAssignment(actor, id, input) {
      return withTransaction(db, async ({ tx }) => {
        const existing = await loadAssignment(tx, id);
        const now = clock();
        const started = existing.effectiveFrom.getTime() <= now.getTime();
        if (
          started &&
          (input.effectiveFrom !== undefined ||
            input.taxRateId !== undefined ||
            input.hsnCodeId !== undefined)
        ) {
          throw new AppError(
            'CONFLICT',
            'This assignment has already taken effect; only its end date can change.',
            {
              details: [
                {
                  code: 'ASSIGNMENT_STARTED',
                  message: 'End-date it and create a new assignment instead.',
                },
              ],
            },
          );
        }
        const window = {
          effectiveFrom:
            input.effectiveFrom === undefined
              ? existing.effectiveFrom
              : istDate(input.effectiveFrom),
          effectiveTo:
            input.effectiveTo === undefined
              ? existing.effectiveTo
              : input.effectiveTo === null
                ? null
                : istDate(input.effectiveTo),
        };
        if (window.effectiveTo !== null && window.effectiveTo < window.effectiveFrom) {
          throw invalid([{ field: 'effectiveTo', message: 'Must be on or after effectiveFrom.' }]);
        }
        if (
          started &&
          window.effectiveTo !== null &&
          window.effectiveTo < addDays(startOfIstDay(now), -1)
        ) {
          // History before yesterday (IST) is not rewritten (TAX_AND_GST_WORKFLOWS §21).
          throw invalid([
            { field: 'effectiveTo', message: 'An end date cannot be earlier than yesterday.' },
          ]);
        }
        const hsnCode =
          input.hsnCodeId === undefined ? existing.hsnCode : await requireHsn(tx, input.hsnCodeId);
        if (input.taxRateId !== undefined)
          await requireActiveRate(tx, input.taxRateId, 'taxRateId');
        const targetId =
          (existing.targetType === 'PRODUCT' ? existing.productId : existing.categoryId) ?? '';
        await assertNoOverlap(tx, existing.targetType, targetId, window, id);
        const updated = await tx.productTaxAssignment.update({
          where: { id },
          data: {
            ...window,
            hsnCode,
            ...(input.taxRateId === undefined ? {} : { taxRateId: input.taxRateId }),
          },
          select: ASSIGNMENT_SELECT,
        });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: AUDIT_MODULE,
          entityType: 'ProductTaxAssignment',
          entityId: id,
          before: assignmentAuditView(existing),
          after: assignmentAuditView(updated),
        });
        return toAssignmentDto(updated, now);
      });
    },

    async deleteAssignment(actor, id) {
      return withTransaction(db, async ({ tx }) => {
        const existing = await loadAssignment(tx, id);
        if (existing.effectiveFrom.getTime() <= clock().getTime()) {
          throw inUse('This assignment has already taken effect; end-date it instead.');
        }
        await tx.productTaxAssignment.delete({ where: { id } });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: AUDIT_MODULE,
          entityType: 'ProductTaxAssignment',
          entityId: id,
          before: assignmentAuditView(existing),
        });
        return { id, deleted: true as const };
      });
    },

    // ── Settings ──
    async getSettings(queryable = db) {
      return loadTaxSettings(queryable);
    },

    async updateSettings(actor, input) {
      return withTransaction(db, async ({ tx }) => {
        const current = await loadTaxSettings(tx);
        const changes: Partial<TaxSettings> = {};
        for (const [key, value] of Object.entries(input)) {
          if (value !== undefined) (changes as Record<string, unknown>)[key] = value;
        }
        const merged: TaxSettings = { ...current, ...changes };
        const details: ErrorDetail[] = [];
        if (merged.sellerGstin !== null && !isValidGstin(merged.sellerGstin)) {
          details.push({ field: 'sellerGstin', message: 'Enter a valid 15-character GSTIN.' });
        } else if (
          merged.sellerGstin !== null &&
          merged.sellerStateCode !== null &&
          gstinStateCode(merged.sellerGstin) !== merged.sellerStateCode
        ) {
          details.push({
            field: 'sellerGstin',
            message: 'The GSTIN state prefix must equal sellerStateCode.',
          });
        }
        if (merged.sellerStateCode !== null && changes.sellerStateCode !== undefined) {
          const state = await tx.state.findUnique({
            where: { code: merged.sellerStateCode },
            select: { code: true },
          });
          if (state === null)
            details.push({ field: 'sellerStateCode', message: 'Unknown state code.' });
        }
        if (merged.shippingTaxTreatment === 'FIXED_RATE') {
          if (merged.shippingFixedTaxRateId === null) {
            details.push({
              field: 'shippingFixedTaxRateId',
              message: 'Required when shippingTaxTreatment is FIXED_RATE.',
            });
          } else {
            const rate = await tx.taxRate.findUnique({
              where: { id: merged.shippingFixedTaxRateId },
              select: { isActive: true },
            });
            if (rate?.isActive !== true) {
              details.push({
                field: 'shippingFixedTaxRateId',
                message: 'Tax rate not found or inactive.',
              });
            }
          }
        }
        if (details.length > 0) throw invalid(details);

        await saveTaxSettings(tx, changes, actor.userId ?? null);
        await audit.record(tx, actor, {
          action: 'SETTINGS_CHANGE',
          module: AUDIT_MODULE,
          entityType: 'Setting',
          before: current as unknown as Record<string, unknown>,
          after: merged as unknown as Record<string, unknown>,
          metadata: { entityLabel: 'tax', keys: Object.keys(changes) },
        });
        return merged;
      });
    },

    // ── Preview ──
    async preview(input) {
      const now = clock();
      const at = input.at === undefined ? now : istDate(input.at);
      const settings = await loadTaxSettings(db);
      if (settings.sellerStateCode === null) {
        throw invalid([
          {
            field: 'sellerStateCode',
            code: 'TAX_SETTINGS_INCOMPLETE',
            message: 'Configure the seller state code in tax settings first.',
          },
        ]);
      }
      const destination = await db.state.findUnique({
        where: { code: input.destinationStateCode },
        select: { code: true, name: true, isUnionTerritory: true, hasLegislature: true },
      });
      if (destination === null) {
        throw invalid([{ field: 'destinationStateCode', message: 'Unknown state code.' }]);
      }

      const variantIds = input.lines
        .map((l) => l.variantId)
        .filter((id): id is string => id !== undefined);
      const variants =
        variantIds.length === 0
          ? []
          : await db.productVariant.findMany({
              where: { id: { in: variantIds }, deletedAt: null },
              select: { id: true, sku: true, productId: true },
            });
      const variantById = new Map(variants.map((v) => [v.id, v]));
      const resolutions = await resolveRates(
        db,
        variants.map((v) => v.productId),
        at,
      );

      const details: ErrorDetail[] = [];
      const lines = input.lines.map((line, index) => {
        const lineId = `lines[${String(index)}]`;
        if (line.variantId === undefined) {
          return {
            lineId,
            hsnCode: line.hsnCode ?? null,
            ratePercent: line.ratePercent ?? '0',
            netLineValue: line.netLineValue,
            extra: { variantId: null, sku: null, source: 'MANUAL', taxRateId: null },
          };
        }
        const variant = variantById.get(line.variantId);
        const resolution = variant === undefined ? undefined : resolutions.get(variant.productId);
        if (variant === undefined || resolution === undefined) {
          details.push({ field: `${lineId}.variantId`, message: 'Variant not found.' });
          return undefined;
        }
        if (!resolution.ok) {
          details.push({
            field: `${lineId}.variantId`,
            code: resolution.reason === 'NO_ASSIGNMENT' ? 'TAX_NOT_CONFIGURED' : resolution.reason,
            message: 'No HSN/tax rate configured for this product or its category on this date.',
          });
          return undefined;
        }
        return {
          lineId,
          hsnCode: resolution.hsnCode,
          ratePercent: resolution.ratePercent,
          netLineValue: line.netLineValue,
          extra: {
            variantId: variant.id,
            sku: variant.sku,
            source: resolution.source,
            taxRateId: resolution.taxRateId,
          },
        };
      });

      let fixedRatePercent: Decimal | undefined;
      if (settings.shippingTaxTreatment === 'FIXED_RATE' && input.shippingCharge !== undefined) {
        const rate =
          settings.shippingFixedTaxRateId === null
            ? null
            : await db.taxRate.findUnique({
                where: { id: settings.shippingFixedTaxRateId },
                select: { rate: true, isActive: true },
              });
        if (rate?.isActive !== true) {
          details.push({
            field: 'shippingCharge',
            code: 'SHIPPING_FIXED_RATE_MISSING',
            message: 'The fixed shipping tax rate is not configured or inactive.',
          });
        } else {
          fixedRatePercent = dec(rate.rate);
        }
      }
      if (details.length > 0) throw invalid(details);
      const resolved = lines.filter((l): l is NonNullable<typeof l> => l !== undefined);

      try {
        const result = computeTax({
          lines: resolved.map(({ extra: _extra, ...l }) => l),
          shipping:
            input.shippingCharge === undefined
              ? undefined
              : {
                  netCharge: input.shippingCharge,
                  treatment: settings.shippingTaxTreatment,
                  fixedRatePercent,
                },
          pricesIncludeTax: settings.pricesIncludeTax,
          seller: { stateCode: settings.sellerStateCode },
          placeOfSupply: {
            stateCode: destination.code,
            isUnionTerritoryWithoutLegislature:
              destination.isUnionTerritory && !destination.hasLegislature,
          },
          rounding: {
            mode: settings.roundingMode,
            invoiceRoundOffToRupee: settings.invoiceRoundOff,
          },
          now,
        });
        const dto = toTaxResultDto(result);
        const lineDtos = dto.lines as Record<string, unknown>[];
        return {
          ...dto,
          resolvedAt: toIstDateString(at),
          placeOfSupply: { stateCode: destination.code, stateName: destination.name },
          seller: { stateCode: settings.sellerStateCode, gstin: settings.sellerGstin },
          lines: lineDtos.map((l, i) => ({ ...resolved[i]?.extra, ...l })),
        };
      } catch (error) {
        if (error instanceof TaxEngineError) {
          throw invalid([{ code: error.code, message: error.message }]);
        }
        throw error;
      }
    },

    resolveRates,
  };
  return service;
}
