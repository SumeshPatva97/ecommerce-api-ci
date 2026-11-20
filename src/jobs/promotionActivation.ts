/**
 * Promotion activation job — BACKEND_STRUCTURE.md §14 (`promotion-activation`, every 1 min).
 *
 * Aligns the STORED status with the dates: `SCHEDULED → ACTIVE` once `starts_at ≤ now`, and
 * `SCHEDULED/ACTIVE → EXPIRED` once `ends_at ≤ now`. DRAFT and PAUSED are manual and never touched.
 * Pricing and admin reads already evaluate the dates themselves (`promotions.rules.ts`
 * `effectiveStatus`), so this job is housekeeping plus an audit trail, not a correctness
 * dependency.
 *
 * Each change is a compare-and-set (`updateMany where status, starts_at and ends_at = the values
 * read`) plus a SYSTEM `STATUS_CHANGE` audit row in the same transaction: a concurrent run, a
 * status change or a date edit in between makes the update a no-op (retried next minute with
 * fresh values), and re-running finds nothing to do. §14's "cache invalidation" step is
 * not needed: there is no product/price cache.
 */
import type { AppContainer } from '../container.js';
import { withTransaction } from '../core/db/transaction.js';
import { SYSTEM_ACTOR } from '../modules/audit/audit.service.js';
import { scheduleStatus } from '../modules/promotions/promotions.rules.js';

export const PROMOTION_ACTIVATION_BATCH = 200;

export interface PromotionActivationSummary {
  readonly scanned: number;
  readonly activated: number;
  readonly expired: number;
  /** Changed by someone else between read and update (compare-and-set missed). */
  readonly skipped: number;
  readonly errors: number;
}

export async function runPromotionActivation(
  container: AppContainer,
  options: { readonly limit?: number } = {},
): Promise<PromotionActivationSummary> {
  const { db, clock, audit, logger } = container;
  const now = clock();
  const counts = { scanned: 0, activated: 0, expired: 0, skipped: 0, errors: 0 };
  const due = await db.promotion.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: 'SCHEDULED', OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { status: { in: ['SCHEDULED', 'ACTIVE'] }, endsAt: { lte: now } },
      ],
    },
    select: { id: true, name: true, status: true, startsAt: true, endsAt: true },
    orderBy: { id: 'asc' },
    take: options.limit ?? PROMOTION_ACTIVATION_BATCH,
  });

  for (const promotion of due) {
    counts.scanned += 1;
    const target = scheduleStatus(promotion.startsAt, promotion.endsAt, now);
    if (target === promotion.status) continue;
    try {
      const changed = await withTransaction(db, async ({ tx }) => {
        const { count } = await tx.promotion.updateMany({
          // D1: the dates are part of the compare-and-set, so an admin edit of starts_at/ends_at
          // between the read and this write makes the update a no-op instead of applying a status
          // computed from stale dates.
          where: {
            id: promotion.id,
            status: promotion.status,
            startsAt: promotion.startsAt,
            endsAt: promotion.endsAt,
            deletedAt: null,
          },
          data: { status: target },
        });
        if (count !== 1) return false;
        await audit.record(tx, SYSTEM_ACTOR, {
          action: 'STATUS_CHANGE',
          module: 'promotions',
          entityType: 'Promotion',
          entityId: promotion.id,
          before: { status: promotion.status },
          after: { status: target },
          eventKey: target === 'EXPIRED' ? 'promotion.expired' : 'promotion.activated',
          metadata: { entityLabel: promotion.name, source: 'promotion-activation' },
        });
        return true;
      });
      if (!changed) counts.skipped += 1;
      else if (target === 'EXPIRED') counts.expired += 1;
      else counts.activated += 1;
    } catch (error) {
      counts.errors += 1;
      logger.error({ err: error, promotionId: promotion.id }, 'promotion status update failed');
    }
  }
  return counts;
}
