/**
 * Promotion use-cases — API_DOCUMENTATION.md §4.9 (Promotions), DATABASE_DESIGN §11.4–§11.8,
 * ROLE_PERMISSION_AND_AUDIT_LOGS §9 (CREATE / UPDATE / DELETE / STATUS_CHANGE).
 *
 * - Name globally unique (normalized; soft-deleted names stay reserved) → 409.
 * - Targets must exist (not soft-deleted); stored per scope; COLLECTION scope supported (R-11).
 * - `status` on create/PATCH is DRAFT or SCHEDULED; a published promotion's status is derived from
 *   its dates (SCHEDULED / ACTIVE / EXPIRED).
 * - pause: ACTIVE|SCHEDULED → PAUSED; resume: PAUSED → SCHEDULED/ACTIVE/EXPIRED per dates;
 *   otherwise 409 INVALID_STATE_TRANSITION.
 * - DELETE (soft) only for DRAFT/SCHEDULED/EXPIRED never applied to an order, else 409 IN_USE.
 * - Placed orders keep their own snapshots; nothing here alters them. Pricing reads promotions
 *   live from the DB (no cache to invalidate yet).
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { dec } from '../../lib/money.js';
import { normalizeText } from '../../lib/normalize.js';
import { istDayRange } from '../../lib/time.js';
import type { AuditActor } from '../audit/audit.service.js';
import {
  promotionAuditSnapshot,
  targetIds as rowTargetIds,
  toPromotionDto,
  type PromotionDto,
} from './promotions.mapper.js';
import {
  createPromotionsRepository,
  type PromotionRow,
  type PromotionsRepository,
  type Scope,
} from './promotions.repository.js';
import {
  canDelete,
  canPause,
  effectiveStatus,
  promotionRuleIssues,
  scheduleStatus,
} from './promotions.rules.js';
import type {
  CreatePromotionInput,
  PromotionListQueryInput,
  UpdatePromotionInput,
} from './promotions.schemas.js';

const MODULE = 'promotions';
const ENTITY = 'Promotion';
/** Tie-break default when `priority` is omitted (lower number wins, BACKEND_STRUCTURE §8.2). */
const DEFAULT_PRIORITY = 50;

export interface PromotionsService {
  list(query: PromotionListQueryInput): Promise<{ items: PromotionDto[]; meta: PageMeta }>;
  get(id: string): Promise<PromotionDto>;
  create(actor: AuditActor, input: CreatePromotionInput): Promise<PromotionDto>;
  update(actor: AuditActor, id: string, input: UpdatePromotionInput): Promise<PromotionDto>;
  remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }>;
  pause(actor: AuditActor, id: string): Promise<PromotionDto>;
  resume(actor: AuditActor, id: string): Promise<PromotionDto>;
}

const notFound = (): AppError => new AppError('NOT_FOUND', 'Promotion not found.');
const invalid = (details: ErrorDetail[]): AppError =>
  new AppError('VALIDATION_ERROR', details[0]?.message, { details });
const transition = (message: string): AppError => new AppError('INVALID_STATE_TRANSITION', message);

export function createPromotionsService(
  container: AppContainer,
  repo: PromotionsRepository = createPromotionsRepository(),
): PromotionsService {
  const { db, audit, clock } = container;

  async function assertNameFree(tx: Queryable, name: string, selfId?: string): Promise<string> {
    const normalized = normalizeText(name);
    const existing = await repo.findByName(tx, normalized);
    if (existing !== null && existing.id !== selfId) {
      const message = `Promotion "${name}" already exists.`;
      throw new AppError('DUPLICATE_RESOURCE', message, {
        details: [{ field: 'name', message, code: 'DUPLICATE' }],
      });
    }
    return normalized;
  }

  async function assertTargets(tx: Queryable, scope: Scope, ids: readonly string[]) {
    const unique = [...new Set(ids)];
    const found = await repo.existingTargets(tx, scope, unique);
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw invalid([
        {
          field: 'targetIds',
          message: 'One or more targets do not exist.',
          code: 'UNKNOWN_TARGET',
          meta: { missing },
        },
      ]);
    }
    return unique;
  }

  async function loadLocked(tx: Queryable, id: string): Promise<PromotionRow> {
    await repo.lock(tx, id);
    const row = await repo.findLive(tx, id);
    if (row === null) throw notFound();
    return row;
  }

  async function record(
    tx: Queryable,
    actor: AuditActor,
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE',
    before: PromotionRow | null,
    after: PromotionRow,
    eventKey?: string,
  ) {
    await audit.record(tx, actor, {
      action,
      module: MODULE,
      entityType: ENTITY,
      entityId: after.id,
      before: before === null ? null : promotionAuditSnapshot(before),
      after: promotionAuditSnapshot(after),
      metadata: { entityLabel: after.name },
      ...(eventKey === undefined ? {} : { eventKey }),
    });
  }

  function listWhere(query: PromotionListQueryInput, now: Date): Prisma.PromotionWhereInput {
    const and: Prisma.PromotionWhereInput[] = [{ deletedAt: null }];
    if (query.q !== undefined) and.push({ name: { contains: query.q } });
    if (query.scope !== undefined) and.push({ scope: query.scope });
    const published: Prisma.PromotionWhereInput = { status: { in: ['SCHEDULED', 'ACTIVE'] } };
    switch (query.status) {
      case 'DRAFT':
      case 'PAUSED':
        and.push({ status: query.status });
        break;
      case 'ACTIVE':
        and.push(
          published,
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        );
        break;
      case 'SCHEDULED':
        and.push(published, { startsAt: { gt: now } });
        break;
      case 'EXPIRED':
        and.push({ OR: [{ status: 'EXPIRED' }, { ...published, endsAt: { lte: now } }] });
        break;
      case undefined:
        break;
    }
    if (query.from !== undefined) {
      const { start } = istDayRange(query.from);
      and.push({ OR: [{ endsAt: null }, { endsAt: { gte: start } }] });
    }
    if (query.to !== undefined) {
      const { end } = istDayRange(query.to);
      and.push({ OR: [{ startsAt: null }, { startsAt: { lt: end } }] });
    }
    return { AND: and };
  }

  return {
    async list(query) {
      const now = clock();
      const { skip, take } = toSkipTake(query.page, query.limit);
      const { rows, total } = await repo.list(db, listWhere(query, now), skip, take);
      return {
        items: rows.map((r) => toPromotionDto(r, now)),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(id) {
      const row = await repo.findLive(db, id);
      if (row === null) throw notFound();
      return toPromotionDto(row, clock());
    },

    async create(actor, input) {
      const now = clock();
      if (input.endsAt.getTime() <= now.getTime()) {
        throw invalid([{ field: 'endsAt', message: 'End must be in the future.' }]);
      }
      return withTransaction(db, async ({ tx }) => {
        const nameNormalized = await assertNameFree(tx, input.name);
        const ids = await assertTargets(tx, input.scope, input.targetIds);
        const id = randomUUID();
        const status =
          (input.status ?? 'DRAFT') === 'DRAFT'
            ? 'DRAFT'
            : scheduleStatus(input.startsAt, input.endsAt, now);
        await repo.create(tx, {
          id,
          name: input.name,
          nameNormalized,
          scope: input.scope,
          discountType: input.discountType,
          discountValue: dec(input.discountValue),
          maxDiscountAmount:
            input.maxDiscountAmount === undefined || input.maxDiscountAmount === null
              ? null
              : dec(input.maxDiscountAmount),
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status,
          priority: input.priority ?? DEFAULT_PRIORITY,
        });
        await repo.replaceTargets(tx, id, input.scope, ids, input.includeDescendants ?? true);
        const row = await repo.findLive(tx, id);
        if (row === null) throw notFound();
        await record(tx, actor, 'CREATE', null, row);
        return toPromotionDto(row, now);
      });
    },

    async update(actor, id, input) {
      const now = clock();
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLocked(tx, id);
        const scope = input.scope ?? before.scope;
        const details: ErrorDetail[] = [];
        if (
          input.scope !== undefined &&
          input.scope !== before.scope &&
          input.targetIds === undefined
        ) {
          details.push({
            field: 'targetIds',
            message: 'Provide targetIds when changing the scope.',
          });
        }
        const startsAt = input.startsAt ?? before.startsAt;
        const endsAt = input.endsAt ?? before.endsAt;
        details.push(
          ...promotionRuleIssues({
            scope,
            discountType: input.discountType ?? before.discountType,
            discountValue: input.discountValue ?? before.discountValue,
            maxDiscountAmount:
              input.maxDiscountAmount === undefined
                ? before.maxDiscountAmount
                : input.maxDiscountAmount,
            startsAt,
            endsAt,
            includeDescendants: input.includeDescendants,
          }),
        );
        if (details.length > 0) throw invalid(details);

        const current = effectiveStatus(before, now);
        let status = before.status;
        if (input.status !== undefined) {
          if (current !== 'DRAFT' && current !== 'SCHEDULED') {
            throw transition(
              `A ${current.toLowerCase()} promotion cannot be set to ${input.status}.`,
            );
          }
          status = input.status;
        }
        if (status === 'SCHEDULED' || status === 'ACTIVE') {
          status = scheduleStatus(startsAt, endsAt, now);
        }

        const data: Prisma.PromotionUncheckedUpdateInput = {};
        if (input.name !== undefined && input.name !== before.name) {
          data.name = input.name;
          data.nameNormalized = await assertNameFree(tx, input.name, id);
        }
        if (input.scope !== undefined) data.scope = input.scope;
        if (input.discountType !== undefined) data.discountType = input.discountType;
        if (input.discountValue !== undefined) data.discountValue = dec(input.discountValue);
        if (input.maxDiscountAmount !== undefined) {
          data.maxDiscountAmount =
            input.maxDiscountAmount === null ? null : dec(input.maxDiscountAmount);
        }
        if (input.startsAt !== undefined) data.startsAt = input.startsAt;
        if (input.endsAt !== undefined) data.endsAt = input.endsAt;
        if (input.priority !== undefined) data.priority = input.priority;
        if (status !== before.status) data.status = status;

        if (input.targetIds !== undefined || input.includeDescendants !== undefined) {
          const ids =
            input.targetIds === undefined
              ? rowTargetIds(before)
              : await assertTargets(tx, scope, input.targetIds);
          const include =
            input.includeDescendants ?? before.categories.every((c) => c.includeDescendants);
          await repo.replaceTargets(tx, id, scope, ids, include);
        }
        await repo.update(tx, id, data);
        const after = (await repo.findLive(tx, id)) ?? before;
        const statusOnly = Object.keys(data).length === 1 && data.status !== undefined;
        await record(tx, actor, statusOnly ? 'STATUS_CHANGE' : 'UPDATE', before, after);
        return toPromotionDto(after, now);
      });
    },

    async remove(actor, id) {
      const now = clock();
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLocked(tx, id);
        const status = effectiveStatus(before, now);
        const applied = await repo.countOrderItems(tx, id);
        if (!canDelete(status, applied)) {
          const message =
            applied > 0
              ? 'This promotion was applied to orders and cannot be deleted.'
              : `A ${status.toLowerCase()} promotion cannot be deleted; pause it instead.`;
          throw new AppError('CONFLICT', message, {
            details: [{ code: 'IN_USE', message, meta: { status, appliedToOrders: applied } }],
          });
        }
        const after = await repo.update(tx, id, { deletedAt: now });
        await record(tx, actor, 'DELETE', before, after);
        return { id, deleted: true as const };
      });
    },

    async pause(actor, id) {
      const now = clock();
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLocked(tx, id);
        const status = effectiveStatus(before, now);
        if (!canPause(status)) {
          throw transition(`A ${status.toLowerCase()} promotion cannot be paused.`);
        }
        const after = await repo.update(tx, id, { status: 'PAUSED' });
        await record(tx, actor, 'STATUS_CHANGE', before, after, 'promotion.paused');
        return toPromotionDto(after, now);
      });
    },

    async resume(actor, id) {
      const now = clock();
      return withTransaction(db, async ({ tx }) => {
        const before = await loadLocked(tx, id);
        if (before.status !== 'PAUSED') {
          throw transition(
            `A ${effectiveStatus(before, now).toLowerCase()} promotion cannot be resumed.`,
          );
        }
        const after = await repo.update(tx, id, {
          status: scheduleStatus(before.startsAt, before.endsAt, now),
        });
        await record(tx, actor, 'STATUS_CHANGE', before, after, 'promotion.resumed');
        return toPromotionDto(after, now);
      });
    },
  };
}
