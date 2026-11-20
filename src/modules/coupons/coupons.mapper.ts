/**
 * Coupon DTOs — API_DOCUMENTATION.md §4.9. Money as 2-dp strings, dates ISO UTC.
 */
import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../generated/prisma/client.js';
import { maskEmail } from '../../lib/redact.js';
import { toMoneyString, toMoneyStringOrNull } from '../../lib/money.js';
import type { AdminCouponRow, UsageRow } from './coupons.repository.js';
import { couponValidity, remainingUses } from './coupons.rules.js';
import type { ApplicabilityInput } from './coupons.schemas.js';

type TargetType = 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'COLLECTION';

const LIST_KEYS: readonly {
  key: keyof ApplicabilityInput;
  ruleType: 'INCLUDE' | 'EXCLUDE';
  targetType: TargetType;
}[] = [
  { key: 'includeProductIds', ruleType: 'INCLUDE', targetType: 'PRODUCT' },
  { key: 'includeCategoryIds', ruleType: 'INCLUDE', targetType: 'CATEGORY' },
  { key: 'includeBrandIds', ruleType: 'INCLUDE', targetType: 'BRAND' },
  { key: 'includeCollectionIds', ruleType: 'INCLUDE', targetType: 'COLLECTION' },
  { key: 'excludeProductIds', ruleType: 'EXCLUDE', targetType: 'PRODUCT' },
  { key: 'excludeCategoryIds', ruleType: 'EXCLUDE', targetType: 'CATEGORY' },
  { key: 'excludeBrandIds', ruleType: 'EXCLUDE', targetType: 'BRAND' },
  { key: 'excludeCollectionIds', ruleType: 'EXCLUDE', targetType: 'COLLECTION' },
];

export interface ApplicabilityEntry {
  readonly key: keyof ApplicabilityInput;
  readonly ruleType: 'INCLUDE' | 'EXCLUDE';
  readonly targetType: TargetType;
  readonly ids: readonly string[];
}

/** Non-empty, de-duplicated id lists of the request. */
export function applicabilityEntries(input: ApplicabilityInput): ApplicabilityEntry[] {
  return LIST_KEYS.flatMap(({ key, ruleType, targetType }) => {
    const ids = [...new Set(input[key] ?? [])];
    return ids.length === 0 ? [] : [{ key, ruleType, targetType, ids }];
  });
}

const FK: Readonly<Record<TargetType, 'productId' | 'categoryId' | 'brandId' | 'collectionId'>> = {
  PRODUCT: 'productId',
  CATEGORY: 'categoryId',
  BRAND: 'brandId',
  COLLECTION: 'collectionId',
};

export function applicabilityRows(
  couponId: string,
  entries: readonly ApplicabilityEntry[],
): Prisma.CouponApplicabilityCreateManyInput[] {
  return entries.flatMap((e) =>
    e.ids.map((id) => ({
      id: randomUUID(),
      couponId,
      ruleType: e.ruleType,
      targetType: e.targetType,
      [FK[e.targetType]]: id,
    })),
  );
}

export function toApplicabilityDto(rows: AdminCouponRow['applicabilities']) {
  const out: Record<keyof ApplicabilityInput, string[]> = {
    includeProductIds: [],
    includeCategoryIds: [],
    includeBrandIds: [],
    includeCollectionIds: [],
    excludeProductIds: [],
    excludeCategoryIds: [],
    excludeBrandIds: [],
    excludeCollectionIds: [],
  };
  for (const row of rows) {
    const target = row.productId ?? row.categoryId ?? row.brandId ?? row.collectionId;
    const spec = LIST_KEYS.find(
      (k) => k.ruleType === row.ruleType && k.targetType === row.targetType,
    );
    if (target !== null && spec !== undefined) out[spec.key].push(target);
  }
  return out;
}

export function toAdminCouponDto(row: AdminCouponRow, now: Date) {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    discountType: row.discountType,
    discountValue: toMoneyString(row.discountValue),
    maxDiscountAmount: toMoneyStringOrNull(row.maxDiscountAmount),
    minOrderValue: toMoneyStringOrNull(row.minOrderValue),
    startsAt: row.startsAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    usageLimitEnabled: row.usageLimitEnabled,
    usageLimit: row.usageLimit,
    perCustomerLimit: row.perCustomerLimit,
    usedCount: row.usedCount,
    remaining: remainingUses(row),
    firstOrderOnly: row.isFirstOrderOnly,
    isCombinableWithPromotions: row.isCombinableWithPromotions,
    isPublic: row.isPublic,
    status: row.status,
    validity: couponValidity(row, now),
    applicability: toApplicabilityDto(row.applicabilities),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type AdminCouponDto = ReturnType<typeof toAdminCouponDto>;

/** Audit snapshot (flat; Decimal/Date serialised by the redactor). */
export function couponAuditSnapshot(row: AdminCouponRow): Record<string, unknown> {
  const { applicabilities, ...rest } = row;
  return { ...rest, applicability: toApplicabilityDto(applicabilities) };
}

export function toUsageDto(row: UsageRow, canSeePii: boolean) {
  const name = [row.user.firstName, row.user.lastName].filter((p) => p !== null).join(' ');
  return {
    id: row.id,
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    customer: {
      id: row.user.id,
      name,
      email: canSeePii ? row.user.email : maskEmail(row.user.email),
    },
    status: row.status,
    discountAmount: toMoneyString(row.discountAmount),
    reservedAt: row.reservedAt?.toISOString() ?? null,
    redeemedAt: row.redeemedAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
  };
}
