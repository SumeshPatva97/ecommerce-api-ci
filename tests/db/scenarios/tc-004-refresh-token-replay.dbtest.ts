/**
 * TC-004 — Refresh-token rotation: concurrent replay inside the grace window, reuse after it
 * (TESTING_STRATEGY §8 CC-07, P1; PROJECT_CONTEXT §15 R-10; decision OQ-76: 10 s, same UA).
 *
 * NOT EXECUTED — requires explicit owner authorization (DEC-12). Runs ONLY through
 * `tests/db/vitest.db.config.ts` against `ecommerce_test` (see tests/db/README.md).
 *
 * Driven through the REAL session service (`createSessionService(container).refresh`) — the code
 * behind `POST /api/v1/auth/refresh` — on the real `refresh_tokens` table. Application time is
 * real time plus an offset (`world.advanceClock`), so "after the grace window" needs no sleeping.
 *
 * (a) Same token presented 5× in parallel, same user agent:
 *       - exactly ONE rotation commits (one successor row; the presented row is ROTATED and
 *         points at it);
 *       - every successful answer — the rotation and any grace replay — carries the SAME
 *         successor pair (refresh token + access token);
 *       - a request that lost the rotation race is refused with 401 UNAUTHENTICATED and nothing
 *         else happens (documented in session.service.ts: "the client retries (grace)");
 *       - the family is NOT revoked, no TOKEN_REUSE_DETECTED audit row, the session stays live;
 *       - each refused request, retried inside the window, receives the SAME successor pair.
 * (b) The rotated token presented again (3× in parallel) more than 10 s later: every request is
 *     refused, the WHOLE family is revoked (`REUSE_DETECTED`), `TOKEN_REUSE_DETECTED` is audited,
 *     the successor no longer refreshes and the session no longer authenticates.
 * (c) The rotated token presented inside the window from a DIFFERENT user agent: same as (b).
 *
 * NOTE for the owner (to compare with CC-07(a) "the second request receives the same successor
 * pair"): with truly simultaneous requests the implementation may answer the loser 401 first and
 * the pair only on its retry. The evidence line reports how many requests took each path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSessionService } from '../../../src/modules/auth/index.js';
import { seedAccounts } from '../harness/fixtures.js';
import { requestMeta } from '../harness/http.js';
import { errorLabel, evidence, fulfilled, race, rejected, tally } from '../harness/race.js';
import { at } from '../harness/scenario.js';
import { assertDbTestGuard, openWorld, scenarioTimeout, type DbWorld } from '../harness/world.js';

const TC = 'TC-004';
const PARALLEL_PRESENTATIONS = 5;
const PARALLEL_REUSE = 3;
const GRACE_SECONDS = 10;
const OTHER_USER_AGENT = 'dec12-db-harness/other-device';

describe('TC-004 refresh-token replay / reuse (CC-07) — real MySQL', () => {
  let world: DbWorld | undefined;

  beforeAll(async () => {
    assertDbTestGuard();
    world = await openWorld();
  });

  afterAll(async () => {
    await world?.close();
  });

  function familyRows(w: DbWorld, familyId: string) {
    return w.db.refreshToken.findMany({
      where: { familyId },
      orderBy: { issuedAt: 'asc' },
      select: {
        id: true,
        tokenHash: true,
        revokedAt: true,
        revokedReason: true,
        replacedById: true,
      },
    });
  }

  function reuseAudits(w: DbWorld, familyId: string): Promise<number> {
    return w.db.auditLog.count({ where: { action: 'TOKEN_REUSE_DETECTED', entityId: familyId } });
  }

  async function concurrentReplay(w: DbWorld, n: number): Promise<void> {
    await w.reset();
    const sessions = createSessionService(w.container);
    const account = at(await seedAccounts(w.db, 1), 0);
    const issued = await sessions.issue(w.db, account.userId, 'storefront', requestMeta());

    const settled = await race(PARALLEL_PRESENTATIONS, () =>
      sessions.refresh(issued.refreshToken, 'storefront', requestMeta()),
    );
    const answered = fulfilled(settled);
    const refused = rejected(settled);
    const rotations = answered.filter((r) => !r.graceReplay);
    const pair = rotations[0]?.session;

    const rowsAfterRace = await familyRows(w, issued.familyId);
    const auditsAfterRace = await reuseAudits(w, issued.familyId);

    // Every refused request retries inside the grace window (sequential, same user agent).
    const retries: Awaited<ReturnType<typeof sessions.refresh>>[] = [];
    for (let i = 0; i < Math.max(1, refused.length); i += 1) {
      retries.push(await sessions.refresh(issued.refreshToken, 'storefront', requestMeta()));
    }
    const rowsAfterRetries = await familyRows(w, issued.familyId);
    const live = await w.container.permissions.loadContext(
      account.userId,
      issued.familyId,
      'storefront',
    );

    evidence(TC, {
      case: 'a-concurrent-replay',
      iteration: n,
      parallel: PARALLEL_PRESENTATIONS,
      outcomes: tally(settled),
      rotations: rotations.length,
      graceReplaysInRace: answered.length - rotations.length,
      refusedInRace: refused.map(errorLabel),
      retriesWithSamePair: retries.filter(
        (r) => r.graceReplay && r.session.refreshToken === pair?.refreshToken,
      ).length,
      familyRows: rowsAfterRetries.length,
      revokedReasons: rowsAfterRetries.map((r) => r.revokedReason),
      reuseAudits: auditsAfterRace,
      sessionLive: live !== null,
    });

    const label = `${TC}(a) iteration ${String(n)}`;
    expect(rotations, `${label}: exactly one rotation`).toHaveLength(1);
    if (pair === undefined) throw new Error(`${label}: no rotation result`);
    // Tokens are compared to booleans first so a failing assertion can never print one.
    for (const r of answered) {
      expect(r.session.refreshToken === pair.refreshToken, `${label}: same successor token`).toBe(
        true,
      );
      expect(r.session.accessToken === pair.accessToken, `${label}: same access token`).toBe(true);
      expect(r.session.familyId, label).toBe(issued.familyId);
    }
    expect(refused.map(errorLabel), `${label}: losers are refused with 401 only`).toEqual(
      refused.map(() => 'UNAUTHENTICATED'),
    );

    for (const rows of [rowsAfterRace, rowsAfterRetries]) {
      expect(rows, `${label}: presented row + ONE successor`).toHaveLength(2);
      const active = rows.filter((r) => r.revokedAt === null);
      const rotated = rows.filter((r) => r.revokedAt !== null);
      expect(active, `${label}: one live token in the family`).toHaveLength(1);
      expect(active[0]?.tokenHash === sessions.hash(pair.refreshToken), label).toBe(true);
      expect(
        rotated.map((r) => ({ reason: r.revokedReason, successor: r.replacedById })),
        `${label}: the presented token is ROTATED to the successor`,
      ).toEqual([{ reason: 'ROTATED', successor: active[0]?.id }]);
    }
    expect(auditsAfterRace, `${label}: no reuse audit`).toBe(0);
    expect(await reuseAudits(w, issued.familyId), `${label}: no reuse audit after retries`).toBe(0);
    expect(live, `${label}: the session is still live`).not.toBeNull();

    for (const r of retries) {
      expect(r.graceReplay, `${label}: retry is a grace replay`).toBe(true);
      expect(
        r.session.refreshToken === pair.refreshToken && r.session.accessToken === pair.accessToken,
        `${label}: retry receives the same successor pair`,
      ).toBe(true);
    }
  }

  async function reuse(
    w: DbWorld,
    n: number,
    variant: 'b-after-grace' | 'c-other-user-agent',
  ): Promise<void> {
    await w.reset();
    const sessions = createSessionService(w.container);
    const account = at(await seedAccounts(w.db, 1), 0);
    const issued = await sessions.issue(w.db, account.userId, 'storefront', requestMeta());
    const rotation = await sessions.refresh(issued.refreshToken, 'storefront', requestMeta());

    let userAgent: string | undefined;
    if (variant === 'b-after-grace') w.advanceClock((GRACE_SECONDS + 1) * 1000);
    else userAgent = OTHER_USER_AGENT;

    const settled = await race(PARALLEL_REUSE, () =>
      sessions.refresh(issued.refreshToken, 'storefront', requestMeta(userAgent)),
    );
    const rows = await familyRows(w, issued.familyId);
    const audits = await reuseAudits(w, issued.familyId);
    const successorAfter = await race(1, () =>
      sessions.refresh(rotation.session.refreshToken, 'storefront', requestMeta()),
    );
    const live = await w.container.permissions.loadContext(
      account.userId,
      issued.familyId,
      'storefront',
    );

    evidence(TC, {
      case: variant,
      iteration: n,
      parallel: PARALLEL_REUSE,
      outcomes: tally(settled),
      familyRows: rows.length,
      revokedReasons: rows.map((r) => r.revokedReason),
      reuseAudits: audits,
      successorAfter: tally(successorAfter),
      sessionLive: live !== null,
    });

    const label = `${TC}(${variant}) iteration ${String(n)}`;
    expect(rotation.graceReplay, `${label}: the first refresh is a rotation`).toBe(false);
    expect(fulfilled(settled), `${label}: reuse is never answered with tokens`).toHaveLength(0);
    expect(rejected(settled).map(errorLabel), label).toEqual(
      Array.from({ length: PARALLEL_REUSE }, () => 'UNAUTHENTICATED'),
    );
    expect(rows, `${label}: no extra successor was issued`).toHaveLength(2);
    expect(
      rows.every((r) => r.revokedAt !== null),
      `${label}: the whole family is revoked`,
    ).toBe(true);
    expect(rows.map((r) => r.revokedReason).sort(), label).toEqual(['REUSE_DETECTED', 'ROTATED']);
    expect(audits, `${label}: TOKEN_REUSE_DETECTED audited`).toBeGreaterThanOrEqual(1);
    expect(tally(successorAfter), `${label}: the successor no longer refreshes`).toEqual({
      UNAUTHENTICATED: 1,
    });
    expect(live, `${label}: the session no longer authenticates`).toBeNull();
  }

  it(
    '(a) parallel presentations inside the grace window: one successor pair, family kept',
    { timeout: scenarioTimeout(60_000) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      for (let n = 1; n <= world.iterations; n += 1) await concurrentReplay(world, n);
    },
  );

  it(
    '(b) reuse after the grace window revokes the family and is audited',
    { timeout: scenarioTimeout(60_000) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      for (let n = 1; n <= world.iterations; n += 1) await reuse(world, n, 'b-after-grace');
    },
  );

  it(
    '(c) reuse from another user agent inside the window revokes the family',
    { timeout: scenarioTimeout(60_000, 1) },
    async () => {
      if (world === undefined) throw new Error('world not initialised');
      await reuse(world, 1, 'c-other-user-agent');
    },
  );
});
