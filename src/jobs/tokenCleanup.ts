/**
 * `token-cleanup` — BACKEND_STRUCTURE.md §14 (daily), AUTHENTICATION_AUTHORIZATION.md §6.1 / §9.1,
 * BACKEND_STRUCTURE §11 (idempotency TTL 24 h), DATABASE_DESIGN.md §20 (retention table).
 *
 * ALL retention periods below are **PROPOSED, NOT APPROVED**: DATABASE_DESIGN §20 marks its whole
 * table "[PROPOSED] pending [OPEN — OQ-38]" (DPDP Act / legal review). Decision: RD-11 in
 * docs/PHASE4-REMAINING-DECISIONS.md. Nothing here may be read as an approved retention policy.
 *
 * | Table               | Deleted when (this code)                               | DATABASE_DESIGN §20 (PROPOSED)             |
 * | refresh_tokens      | expired OR revoked more than 30 days ago               | 30 days after expiry/revocation            |
 * | verification_tokens | expired, consumed OR invalidated more than 7 days ago  | 7 days after expiry/consumption            |
 * | idempotency_keys    | past `expires_at`, daily                               | 24 h + 1 day grace, HOURLY purge           |
 *
 * Known deviations, unchanged until RD-11 is decided: idempotency keys get no 1-day grace and are
 * purged daily, not hourly; "invalidated" verification tokens are included (not named by §20); a
 * revoked refresh token is deleted 30 days after REVOCATION even if not yet expired, which matters
 * only if the refresh TTL exceeds 30 days (reuse detection; audit D6).
 *
 * Batched (1 000 ids per delete) so a large backlog never holds long locks. Audit rows are never
 * touched (immutable; separate retention, OQ-38).
 */
import type { DbClient } from '../core/db/transaction.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TOKEN_CLEANUP_BATCH = 1000;

export interface TokenCleanupSummary {
  readonly refreshTokens: number;
  readonly verificationTokens: number;
  readonly idempotencyKeys: number;
}

async function deleteInBatches(
  findIds: () => Promise<readonly { id: string }[]>,
  deleteIds: (ids: string[]) => Promise<{ count: number }>,
  maxBatches: number,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await findIds();
    if (rows.length === 0) break;
    total += (await deleteIds(rows.map((r) => r.id))).count;
    if (rows.length < TOKEN_CLEANUP_BATCH) break;
  }
  return total;
}

export async function runTokenCleanup(
  deps: { readonly db: DbClient; readonly clock: () => Date },
  options: { readonly maxBatches?: number } = {},
): Promise<TokenCleanupSummary> {
  const { db } = deps;
  const now = deps.clock();
  const maxBatches = options.maxBatches ?? 50;
  const refreshCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const verificationCutoff = new Date(now.getTime() - 7 * DAY_MS);

  const refreshTokens = await deleteInBatches(
    () =>
      db.refreshToken.findMany({
        where: { OR: [{ expiresAt: { lt: refreshCutoff } }, { revokedAt: { lt: refreshCutoff } }] },
        select: { id: true },
        take: TOKEN_CLEANUP_BATCH,
      }),
    (ids) => db.refreshToken.deleteMany({ where: { id: { in: ids } } }),
    maxBatches,
  );

  const verificationTokens = await deleteInBatches(
    () =>
      db.verificationToken.findMany({
        where: {
          OR: [
            { expiresAt: { lt: verificationCutoff } },
            { consumedAt: { lt: verificationCutoff } },
            { invalidatedAt: { lt: verificationCutoff } },
          ],
        },
        select: { id: true },
        take: TOKEN_CLEANUP_BATCH,
      }),
    (ids) => db.verificationToken.deleteMany({ where: { id: { in: ids } } }),
    maxBatches,
  );

  const idempotencyKeys = await deleteInBatches(
    () =>
      db.idempotencyKey.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        take: TOKEN_CLEANUP_BATCH,
      }),
    (ids) => db.idempotencyKey.deleteMany({ where: { id: { in: ids } } }),
    maxBatches,
  );

  return { refreshTokens, verificationTokens, idempotencyKeys };
}
