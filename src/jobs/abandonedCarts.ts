/**
 * Abandoned-cart lifecycle job — RD-08 option B (approved 2026-11-20), BACKEND_STRUCTURE.md §14
 * (`abandoned-carts`, hourly), USER_WORKFLOWS §9.3, DATABASE_DESIGN §20.
 *
 * 1. ABANDON: ACTIVE carts whose `last_activity_at` is older than `cart.abandon_after_days`
 *    (default 30) → ABANDONED with `abandoned_at = now`. Items are kept: the customer's next cart
 *    request reactivates the newest ABANDONED cart (cart service).
 * 2. PURGE: ABANDONED carts whose `abandoned_at` is more than 90 days old are deleted;
 *    `cart_items` go with them through the database's ON DELETE CASCADE. No other table references
 *    `carts` (orders reference nothing here; `carts.converted_order_id` points the other way), and
 *    CONVERTED carts are never touched.
 *
 * Safety:
 * - Both steps are compare-and-set: the UPDATE / DELETE repeat the full condition (status AND
 *   cut-off), so a cart that a customer used or reactivated between the read and the write is
 *   skipped. ACTIVE carts can never be deleted — the DELETE requires status ABANDONED.
 * - Re-running is a no-op (rows no longer match). Work is batched (500 ids, at most 20 batches per
 *   step per run) to keep locks short; anything left is picked up next hour.
 * - Not in this job (decisions): no abandoned-cart reminders (OQ-62, out of v1); empty ACTIVE carts
 *   are NOT deleted early (§14's "if no items: delete" was superseded by RD-08 option B).
 *
 * Runs in the in-process scheduler (`JOBS_ENABLED`, off by default, single process — D-38). Until
 * the dedicated worker (RD-12, Batch 9) exists, that scheduler runs inside the API process.
 */
import type { AppContainer } from '../container.js';
import { ABANDONED_CART_PURGE_DAYS, loadAbandonAfterDays } from '../modules/cart/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ABANDONED_CARTS_BATCH = 500;
export const ABANDONED_CARTS_MAX_BATCHES = 20;

export interface AbandonedCartsSummary {
  readonly abandonAfterDays: number;
  readonly abandoned: number;
  readonly purged: number;
}

export async function runAbandonedCarts(
  container: AppContainer,
  options: { readonly batchSize?: number; readonly maxBatches?: number } = {},
): Promise<AbandonedCartsSummary> {
  const { db, clock, logger } = container;
  const batchSize = options.batchSize ?? ABANDONED_CARTS_BATCH;
  const maxBatches = options.maxBatches ?? ABANDONED_CARTS_MAX_BATCHES;
  const now = clock();
  const abandonAfterDays = await loadAbandonAfterDays(db);
  const abandonCutoff = new Date(now.getTime() - abandonAfterDays * DAY_MS);
  const purgeCutoff = new Date(now.getTime() - ABANDONED_CART_PURGE_DAYS * DAY_MS);

  let abandoned = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const due = await db.cart.findMany({
      where: { status: 'ACTIVE', lastActivityAt: { lt: abandonCutoff } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (due.length === 0) break;
    const { count } = await db.cart.updateMany({
      where: {
        id: { in: due.map((c) => c.id) },
        status: 'ACTIVE',
        lastActivityAt: { lt: abandonCutoff },
      },
      data: { status: 'ABANDONED', abandonedAt: now },
    });
    abandoned += count;
    if (due.length < batchSize) break;
  }

  let purged = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const due = await db.cart.findMany({
      where: { status: 'ABANDONED', abandonedAt: { lt: purgeCutoff } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (due.length === 0) break;
    const { count } = await db.cart.deleteMany({
      where: {
        id: { in: due.map((c) => c.id) },
        status: 'ABANDONED',
        abandonedAt: { lt: purgeCutoff },
      },
    });
    purged += count;
    if (due.length < batchSize) break;
  }

  if (abandoned > 0 || purged > 0) {
    logger.info({ abandonAfterDays, abandoned, purged }, 'abandoned-cart lifecycle applied');
  }
  return { abandonAfterDays, abandoned, purged };
}
