/**
 * Coupon use-cases — API_DOCUMENTATION.md §4.9 (admin CRUD + usage), DATABASE_DESIGN §11.1–§11.3
 * and §17 (usage concurrency), ROLE_PERMISSION_AND_AUDIT_LOGS §9 (CREATE/UPDATE/DELETE/
 * STATUS_CHANGE).
 *
 * Admin rules: code globally unique (normalized, soft-deleted codes stay reserved); `code`
 * immutable once used; `usageLimit` never below `usedCount`; DELETE only when never used (soft
 * delete), otherwise 409 `IN_USE` — deactivate instead.
 *
 * Checkout API (`reserveUsage` / `redeem` / `release`) runs inside the caller's transaction and
 * locks the coupon row `FOR UPDATE` before touching `used_count` (§17.1).
 * Schema note: `coupon_usage.release_reason` is not in the approved schema — the reason is
 * returned to the caller (for order history) but not persisted.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ZERO, dec, toMoneyString, type Decimal } from '../../lib/money.js';
import { couponPreconditionFailure } from '../../lib/pricing/index.js';
import type { AuditActor } from '../audit/audit.service.js';
import { couponSnapshotSelect, toCouponSnapshot } from '../promotions/pricing.loader.js';
import {
  applicabilityEntries,
  applicabilityRows,
  couponAuditSnapshot,
  toAdminCouponDto,
  toUsageDto,
  type AdminCouponDto,
  type ApplicabilityEntry,
} from './coupons.mapper.js';
import {
  createCouponsRepository,
  type AdminCouponRow,
  type CouponsRepository,
} from './coupons.repository.js';
import { couponInvalidError } from './coupons.errors.js';
import { couponRuleIssues, releaseDecision, type UsageReleaseReason } from './coupons.rules.js';
import type {
  CouponListQueryInput,
  CouponUsageQueryInput,
  CreateCouponInput,
  UpdateCouponInput,
} from './coupons.schemas.js';

const MODULE = 'coupons';
const ENTITY = 'Coupon';
const NOT_AN_ORDER = ['CANCELLED', 'PAYMENT_FAILED'] as const;

export type UsageStatus = 'RESERVED' | 'REDEEMED' | 'RELEASED';

export interface UsageTransition {
  readonly status: UsageStatus | 'NO_COUPON';
  readonly changed: boolean;
  readonly usageId: string | null;
  readonly couponId: string | null;
}

export interface CouponUsageSummary {
  readonly redeemed: number;
  readonly reserved: number;
  readonly released: number;
  readonly totalDiscount: string;
}

export interface CouponsService {
  list(query: CouponListQueryInput): Promise<{ items: AdminCouponDto[]; meta: PageMeta }>;
  get(id: string): Promise<AdminCouponDto>;
  create(actor: AuditActor, input: CreateCouponInput): Promise<AdminCouponDto>;
  update(actor: AuditActor, id: string, input: UpdateCouponInput): Promise<AdminCouponDto>;
  remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }>;
  usage(
    id: string,
    query: CouponUsageQueryInput,
    canSeePii: boolean,
  ): Promise<{
    items: ReturnType<typeof toUsageDto>[];
    meta: PageMeta & { summary: CouponUsageSummary };
  }>;
  /**
   * Order placement (inside the order transaction, after the order row exists): locks the coupon,
   * re-checks status/window/global + per-customer limits/first order, increments `used_count` and
   * records a RESERVED usage. Idempotent per order; a RELEASED row of the same order is re-reserved
   * (retry-payment). Throws 422 `COUPON_INVALID` with the failing reason.
   */
  reserveUsage(
    tx: Queryable,
    couponId: string,
    userId: string,
    orderId: string,
    discountAmount: Decimal,
  ): Promise<UsageTransition>;
  /** Payment captured / COD confirmed: RESERVED → REDEEMED (no-op when already REDEEMED). */
  redeem(tx: Queryable, orderId: string): Promise<UsageTransition>;
  /**
   * RESERVED → RELEASED (`used_count − 1`) for any reason; REDEEMED → RELEASED only for
   * `ORDER_CANCELLED_BEFORE_SHIPMENT` while the coupon is still valid (PROVISIONAL OQ-15).
   */
  release(tx: Queryable, orderId: string, reason: UsageReleaseReason): Promise<UsageTransition>;
}

function invalid(details: ErrorDetail[]): AppError {
  return new AppError('VALIDATION_ERROR', details[0]?.message, { details });
}

const notFound = (): AppError => new AppError('NOT_FOUND', 'Coupon not found.');

export function createCouponsService(
  container: AppContainer,
  repo: CouponsRepository = createCouponsRepository(),
): CouponsService {
  const { db, audit, clock } = container;

  async function assertTargetsExist(tx: Queryable, entries: readonly ApplicabilityEntry[]) {
    const details: ErrorDetail[] = [];
    for (const e of entries) {
      const found = await repo.existingTargets(tx, e.targetType, e.ids);
      const missing = e.ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        details.push({
          field: `applicability.${e.key}`,
          message: 'One or more ids do not exist.',
          code: 'UNKNOWN_TARGET',
          meta: { missing },
        });
      }
    }
    if (details.length > 0) throw invalid(details);
  }

  async function assertCodeFree(tx: Queryable, code: string, selfId?: string) {
    const existing = await repo.findByCode(tx, code);
    if (existing !== null && existing.id !== selfId) {
      const message = `Coupon code ${code} already exists.`;
      throw new AppError('DUPLICATE_RESOURCE', message, {
        details: [{ field: 'code', message, code: 'DUPLICATE' }],
      });
    }
  }

  async function loadLocked(tx: Queryable, id: string): Promise<AdminCouponRow> {
    await repo.lock(tx, id);
    const row = await repo.findLive(tx, id);
    if (row === null) throw notFound();
    return row;
  }

  function usageResult(
    usage: { id: string; couponId: string },
    status: UsageStatus,
    changed: boolean,
  ): UsageTransition {
    return { status, changed, usageId: usage.id, couponId: usage.couponId };
  }

  const NO_COUPON: UsageTransition = {
    status: 'NO_COUPON',
    changed: false,
    usageId: null,
    couponId: null,
  };

  return {
    async list(query) {
      const now = clock();
      const and: Prisma.CouponWhereInput[] = [{ deletedAt: null }];
      if (query.q !== undefined) {
        and.push({
          OR: [
            { codeNormalized: { contains: query.q.toUpperCase() } },
            { description: { contains: query.q } },
          ],
        });
      }
      if (query.status !== undefined) and.push({ status: query.status });
      if (query.discountType !== undefined) and.push({ discountType: query.discountType });
      switch (query.validity) {
        case 'active':
          and.push(
            { status: 'ACTIVE' },
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          );
          break;
        case 'scheduled':
          and.push({ startsAt: { gt: now } });
          break;
        case 'expired':
          and.push({ expiresAt: { lte: now } });
          break;
        case undefined:
          break;
      }
      const { skip, take } = toSkipTake(query.page, query.limit);
      const { rows, total } = await repo.list(db, { AND: and }, skip, take);
      return {
        items: rows.map((r) => toAdminCouponDto(r, now)),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(id) {
      const row = await repo.findLive(db, id);
      if (row === null) throw notFound();
      return toAdminCouponDto(row, clock());
    },

    async create(actor, input) {
      const now = clock();
      if (input.expiresAt.getTime() <= now.getTime()) {
        throw invalid([{ field: 'expiresAt', message: 'Expiry must be in the future.' }]);
      }
      const entries = applicabilityEntries(input.applicability ?? {});
      return withTransaction(db, async ({ tx }) => {
        await assertCodeFree(tx, input.code);
        await assertTargetsExist(tx, entries);
        const id = randomUUID();
        const created = await repo.create(tx, {
          id,
          code: input.code,
          codeNormalized: input.code,
          description: input.description ?? null,
          discountType: input.discountType,
          discountValue: dec(input.discountValue),
          maxDiscountAmount:
            input.maxDiscountAmount === undefined || input.maxDiscountAmount === null
              ? null
              : dec(input.maxDiscountAmount),
          minOrderValue:
            input.minOrderValue === undefined || input.minOrderValue === null
              ? null
              : dec(input.minOrderValue),
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          usageLimitEnabled: input.usageLimitEnabled,
          usageLimit: input.usageLimitEnabled ? (input.usageLimit ?? null) : null,
          perCustomerLimit: input.perCustomerLimit ?? null,
          isFirstOrderOnly: input.firstOrderOnly ?? false,
          isCombinableWithPromotions: input.isCombinableWithPromotions ?? false,
          isPublic: input.isPublic ?? false,
          status: input.status ?? 'ACTIVE',
        });
        const rows = applicabilityRows(id, entries);
        let row = created;
        if (rows.length > 0) {
          await repo.replaceApplicability(tx, id, rows);
          row = (await repo.findLive(tx, id)) ?? created;
        }
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          after: couponAuditSnapshot(row),
          metadata: { entityLabel: row.code },
        });
        return toAdminCouponDto(row, now);
      });
    },

    async update(actor, id, input) {
      const now = clock();
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLocked(tx, id);
        const details: ErrorDetail[] = [];
        const codeChanged = input.code !== undefined && input.code !== before.codeNormalized;
        if (codeChanged && before.usedCount > 0) {
          details.push({
            field: 'code',
            message: 'The code cannot be changed after the coupon has been used.',
          });
        }
        const merged = {
          discountType: input.discountType ?? before.discountType,
          discountValue: input.discountValue ?? before.discountValue,
          maxDiscountAmount:
            input.maxDiscountAmount === undefined
              ? before.maxDiscountAmount
              : input.maxDiscountAmount,
          startsAt: input.startsAt ?? before.startsAt,
          expiresAt: input.expiresAt ?? before.expiresAt,
          usageLimitEnabled: input.usageLimitEnabled ?? before.usageLimitEnabled,
          usageLimit:
            input.usageLimit === undefined
              ? input.usageLimitEnabled === false
                ? null
                : before.usageLimit
              : input.usageLimit,
        };
        details.push(...couponRuleIssues(merged));
        if (
          merged.usageLimitEnabled &&
          typeof merged.usageLimit === 'number' &&
          merged.usageLimit >= 1 &&
          merged.usageLimit < before.usedCount
        ) {
          details.push({
            field: 'usageLimit',
            message: `Cannot be lower than redemptions already used (${before.usedCount}).`,
          });
        }
        if (details.length > 0) throw invalid(details);
        if (codeChanged && input.code !== undefined) await assertCodeFree(tx, input.code, id);
        const entries =
          input.applicability === undefined ? undefined : applicabilityEntries(input.applicability);
        if (entries !== undefined) await assertTargetsExist(tx, entries);

        const data: Prisma.CouponUncheckedUpdateInput = {};
        if (codeChanged && input.code !== undefined) {
          data.code = input.code;
          data.codeNormalized = input.code;
        }
        if (input.description !== undefined) data.description = input.description;
        if (input.discountType !== undefined) data.discountType = input.discountType;
        if (input.discountValue !== undefined) data.discountValue = dec(input.discountValue);
        if (input.maxDiscountAmount !== undefined) {
          data.maxDiscountAmount =
            input.maxDiscountAmount === null ? null : dec(input.maxDiscountAmount);
        }
        if (input.minOrderValue !== undefined) {
          data.minOrderValue = input.minOrderValue === null ? null : dec(input.minOrderValue);
        }
        if (input.startsAt !== undefined) data.startsAt = input.startsAt;
        if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
        if (input.usageLimitEnabled !== undefined) data.usageLimitEnabled = input.usageLimitEnabled;
        if (merged.usageLimit !== before.usageLimit) data.usageLimit = merged.usageLimit;
        if (input.perCustomerLimit !== undefined) data.perCustomerLimit = input.perCustomerLimit;
        if (input.firstOrderOnly !== undefined) data.isFirstOrderOnly = input.firstOrderOnly;
        if (input.isCombinableWithPromotions !== undefined) {
          data.isCombinableWithPromotions = input.isCombinableWithPromotions;
        }
        if (input.isPublic !== undefined) data.isPublic = input.isPublic;
        if (input.status !== undefined) data.status = input.status;

        let after = await repo.update(tx, id, data);
        if (entries !== undefined) {
          await repo.replaceApplicability(tx, id, applicabilityRows(id, entries));
          after = (await repo.findLive(tx, id)) ?? after;
        }
        const keys = Object.keys(data).concat(entries === undefined ? [] : ['applicability']);
        await audit.record(tx, actor, {
          action: keys.length === 1 && keys[0] === 'status' ? 'STATUS_CHANGE' : 'UPDATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before: couponAuditSnapshot(before),
          after: couponAuditSnapshot(after),
          metadata: { entityLabel: after.code },
        });
        return toAdminCouponDto(after, now);
      });
    },

    async remove(actor, id) {
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLocked(tx, id);
        if (before.usedCount > 0 || (await repo.isUsed(tx, id))) {
          const message = 'This coupon has been used and can only be deactivated.';
          throw new AppError('CONFLICT', message, {
            details: [{ code: 'IN_USE', message, meta: { usedCount: before.usedCount } }],
          });
        }
        const after = await repo.update(tx, id, { deletedAt: clock(), status: 'INACTIVE' });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before: couponAuditSnapshot(before),
          after: couponAuditSnapshot(after),
          metadata: { entityLabel: before.code },
        });
        return { id, deleted: true as const };
      });
    },

    async usage(id, query, canSeePii) {
      const coupon = await repo.findLive(db, id);
      if (coupon === null) throw notFound();
      const where: Prisma.CouponUsageWhereInput = {
        couponId: id,
        ...(query.status === undefined ? {} : { status: query.status }),
      };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [{ rows, total }, groups] = await Promise.all([
        repo.listUsage(db, where, skip, take),
        repo.usageSummary(db, id),
      ]);
      const count = (s: UsageStatus) => groups.find((g) => g.status === s)?._count._all ?? 0;
      const redeemedSum = groups.find((g) => g.status === 'REDEEMED')?._sum.discountAmount;
      return {
        items: rows.map((r) => toUsageDto(r, canSeePii)),
        meta: {
          ...buildPageMeta(query.page, query.limit, total),
          summary: {
            redeemed: count('REDEEMED'),
            reserved: count('RESERVED'),
            released: count('RELEASED'),
            totalDiscount: toMoneyString(redeemedSum ?? ZERO),
          },
        },
      };
    },

    async reserveUsage(tx, couponId, userId, orderId, discountAmount) {
      const now = clock();
      await repo.lock(tx, couponId);
      const row = await tx.coupon.findUnique({
        where: { id: couponId },
        select: couponSnapshotSelect,
      });
      if (row === null) throw couponInvalidError({ reason: 'COUPON_NOT_FOUND' });
      const existing = await tx.couponUsage.findUnique({
        where: { orderId },
        select: { id: true, couponId: true, status: true },
      });
      if (existing !== null && existing.couponId !== couponId) {
        throw new AppError('CONFLICT', 'A different coupon is already recorded for this order.');
      }
      if (existing !== null && existing.status !== 'RELEASED') {
        return usageResult(existing, existing.status, false);
      }
      const [uses, previousOrders] = await Promise.all([
        tx.couponUsage.count({
          where: { couponId, userId, status: { in: ['RESERVED', 'REDEEMED'] } },
        }),
        tx.order.count({
          where: { userId, id: { not: orderId }, status: { notIn: [...NOT_AN_ORDER] } },
        }),
      ]);
      const failure = couponPreconditionFailure(
        toCouponSnapshot(row),
        { couponUsesByCustomer: uses, isFirstOrder: previousOrders === 0 },
        now,
      );
      if (failure !== null) throw couponInvalidError(failure);
      await tx.coupon.update({
        where: { id: couponId },
        data: { usedCount: { increment: 1 } },
        select: { id: true },
      });
      if (existing !== null) {
        await tx.couponUsage.update({
          where: { id: existing.id },
          data: {
            status: 'RESERVED',
            reservedAt: now,
            releasedAt: null,
            redeemedAt: null,
            discountAmount,
          },
          select: { id: true },
        });
        return usageResult(existing, 'RESERVED', true);
      }
      const id = randomUUID();
      await tx.couponUsage.create({
        data: {
          id,
          couponId,
          userId,
          orderId,
          status: 'RESERVED',
          discountAmount,
          reservedAt: now,
        },
        select: { id: true },
      });
      return usageResult({ id, couponId }, 'RESERVED', true);
    },

    async redeem(tx, orderId) {
      const usage = await tx.couponUsage.findUnique({
        where: { orderId },
        select: { id: true, couponId: true, status: true },
      });
      if (usage === null) return NO_COUPON;
      if (usage.status === 'REDEEMED') return usageResult(usage, 'REDEEMED', false);
      if (usage.status === 'RELEASED') {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          'The coupon reservation of this order was already released.',
        );
      }
      await tx.couponUsage.update({
        where: { id: usage.id },
        data: { status: 'REDEEMED', redeemedAt: clock() },
        select: { id: true },
      });
      return usageResult(usage, 'REDEEMED', true);
    },

    async release(tx, orderId, reason) {
      const now = clock();
      const usage = await tx.couponUsage.findUnique({
        where: { orderId },
        select: { id: true, couponId: true, status: true },
      });
      if (usage === null) return NO_COUPON;
      if (usage.status === 'RELEASED') return usageResult(usage, 'RELEASED', false);
      await repo.lock(tx, usage.couponId);
      const coupon = await tx.coupon.findUnique({
        where: { id: usage.couponId },
        select: { status: true, deletedAt: true, expiresAt: true },
      });
      const stillValid =
        coupon !== null &&
        coupon.status === 'ACTIVE' &&
        coupon.deletedAt === null &&
        (coupon.expiresAt === null || coupon.expiresAt.getTime() > now.getTime());
      const decision = releaseDecision(usage.status, reason, stillValid);
      if (decision !== 'RELEASE') return usageResult(usage, usage.status, false);
      await tx.couponUsage.update({
        where: { id: usage.id },
        data: { status: 'RELEASED', releasedAt: now },
        select: { id: true },
      });
      await tx.coupon.updateMany({
        where: { id: usage.couponId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
      return usageResult(usage, 'RELEASED', true);
    },
  };
}
