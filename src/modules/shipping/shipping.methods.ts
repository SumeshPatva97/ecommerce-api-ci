/**
 * Shipping methods (admin CRUD) and public serviceability / method listing — API_DOCUMENTATION.md
 * §3.8, §4.12. PROVISIONAL (OQ-07).
 *
 * - `code` and normalized `name` are unique (friendly pre-check; DB unique indexes are final).
 * - DELETE is a soft delete, refused while orders reference the method (409 `IN_USE` — deactivate
 *   instead), so historical orders keep a valid method snapshot.
 * - Serviceability goes through the provider adapter (8 s timeout); an outage answers
 *   `serviceable: null, reason: CHECK_UNAVAILABLE` (browsing is never blocked; checkout re-checks).
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma, ShippingMethod } from '../../generated/prisma/client.js';
import type { ShippingProviderAdapter } from '../../integrations/shipping/shippingProvider.js';
import { dec, toMoneyString, toMoneyStringOrNull } from '../../lib/money.js';
import { normalizeText } from '../../lib/normalize.js';
import type { AuditActor } from '../audit/audit.service.js';
import {
  computeShippingCharge,
  loadBooleanSetting,
  loadFreeShippingThreshold,
  toQuoteDto,
  type ShippingQuoteDto,
} from './shipping.rates.js';
import type {
  CreateMethodInput,
  MethodListQueryInput,
  PublicMethodsQueryInput,
  UpdateMethodInput,
} from './shipping.schemas.js';

const MODULE = 'shipping';
const ENTITY = 'ShippingMethod';
const SERVICEABILITY_TIMEOUT_MS = 8_000;

export interface AdminMethodDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly rateType: ShippingMethod['rateType'];
  readonly charge: string;
  readonly freeAbove: string | null;
  readonly estimatedDaysMin: number | null;
  readonly estimatedDaysMax: number | null;
  readonly codAllowed: boolean;
  readonly codCharge: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly sortOrder: number;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAdminMethod(row: ShippingMethod): AdminMethodDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    rateType: row.rateType,
    charge: toMoneyString(row.baseCharge),
    freeAbove: toMoneyStringOrNull(row.freeAboveAmount),
    estimatedDaysMin: row.etaMinDays,
    estimatedDaysMax: row.etaMaxDays,
    codAllowed: row.codSupported,
    codCharge: toMoneyString(row.codCharge),
    status: row.isActive ? 'ACTIVE' : 'INACTIVE',
    sortOrder: row.sortOrder,
    deleted: row.deletedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ServiceabilityDto {
  readonly pincode: string;
  readonly serviceable: boolean | null;
  readonly reason?: 'CHECK_UNAVAILABLE';
  readonly city: string | null;
  readonly stateCode: string | null;
  readonly estimatedDelivery: { readonly minDays: number; readonly maxDays: number } | null;
  readonly codAvailable: boolean;
}

export interface PublicMethodDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly charge: string;
  readonly freeAbove: string | null;
  readonly estimatedDays: { readonly min: number | null; readonly max: number | null };
  readonly codAvailable: boolean;
  readonly quote?: ShippingQuoteDto;
}

function duplicate(field: string, message: string): AppError {
  return new AppError('DUPLICATE_RESOURCE', message, {
    details: [{ field, message, code: 'DUPLICATE' }],
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Provider timeout.'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createShippingMethodsService(
  container: AppContainer,
  provider: ShippingProviderAdapter,
) {
  const { db, audit, clock, logger } = container;

  async function assertUnique(
    tx: Queryable,
    input: { code?: string | undefined; name?: string | undefined },
    selfId?: string,
  ): Promise<string | undefined> {
    if (input.code !== undefined) {
      const byCode = await tx.shippingMethod.findUnique({ where: { code: input.code } });
      if (byCode !== null && byCode.id !== selfId) {
        throw duplicate('code', `Shipping method code "${input.code}" already exists.`);
      }
    }
    if (input.name === undefined) return undefined;
    const nameNormalized = normalizeText(input.name);
    const byName = await tx.shippingMethod.findUnique({ where: { nameNormalized } });
    if (byName !== null && byName.id !== selfId) {
      throw duplicate('name', `Shipping method "${input.name}" already exists.`);
    }
    return nameNormalized;
  }

  async function serviceability(pincode: string): Promise<ServiceabilityDto> {
    let result;
    try {
      result = await withTimeout(provider.checkServiceability(pincode), SERVICEABILITY_TIMEOUT_MS);
    } catch (error) {
      logger.warn({ err: error, provider: provider.name }, 'serviceability check unavailable');
      return {
        pincode,
        serviceable: null,
        reason: 'CHECK_UNAVAILABLE',
        city: null,
        stateCode: null,
        estimatedDelivery: null,
        codAvailable: false,
      };
    }
    const codEnabled = await loadBooleanSetting(db, 'checkout.cod_enabled', false);
    return {
      pincode,
      serviceable: result.serviceable,
      city: result.city,
      stateCode: result.stateCode,
      estimatedDelivery:
        result.estimatedDays === null
          ? null
          : { minDays: result.estimatedDays.min, maxDays: result.estimatedDays.max },
      codAvailable: result.serviceable && result.codAvailable && codEnabled,
    };
  }

  return {
    serviceability,

    async publicMethods(
      query: PublicMethodsQueryInput,
    ): Promise<{ items: PublicMethodDto[]; meta: Record<string, unknown> }> {
      const svc = query.pincode === undefined ? undefined : await serviceability(query.pincode);
      if (svc?.serviceable === false) {
        return { items: [], meta: { totalItems: 0, pincode: svc.pincode, serviceable: false } };
      }
      const [rows, threshold, codEnabled] = await Promise.all([
        db.shippingMethod.findMany({
          where: { isActive: true, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        loadFreeShippingThreshold(db),
        loadBooleanSetting(db, 'checkout.cod_enabled', false),
      ]);
      const items = rows.map((row): PublicMethodDto => {
        const quote =
          query.cartValue === undefined
            ? undefined
            : computeShippingCharge(row, {
                cartValue: dec(query.cartValue),
                globalFreeShippingThreshold: threshold,
              });
        const freeAbove = row.freeAboveAmount ?? (row.rateType === 'FREE_ABOVE' ? threshold : null);
        return {
          id: row.id,
          code: row.code,
          name: row.name,
          description: row.description,
          charge: toMoneyString(row.baseCharge),
          freeAbove: toMoneyStringOrNull(freeAbove),
          estimatedDays: { min: row.etaMinDays, max: row.etaMaxDays },
          codAvailable: row.codSupported && codEnabled && (svc?.codAvailable ?? true),
          ...(quote === undefined ? {} : { quote: toQuoteDto(quote) }),
        };
      });
      return {
        items,
        meta: {
          totalItems: items.length,
          ...(svc === undefined ? {} : { pincode: svc.pincode, serviceable: svc.serviceable }),
        },
      };
    },

    async list(query: MethodListQueryInput): Promise<{ items: AdminMethodDto[]; meta: PageMeta }> {
      const where: Prisma.ShippingMethodWhereInput = {
        ...(query.status === 'DELETED'
          ? { deletedAt: { not: null } }
          : {
              deletedAt: null,
              ...(query.status === undefined ? {} : { isActive: query.status === 'ACTIVE' }),
            }),
        ...(query.q === undefined
          ? {}
          : { OR: [{ name: { contains: query.q } }, { code: { contains: query.q } }] }),
      };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.shippingMethod.findMany({
          where,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          skip,
          take,
        }),
        db.shippingMethod.count({ where }),
      ]);
      return {
        items: rows.map(toAdminMethod),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(id: string): Promise<AdminMethodDto> {
      const row = await db.shippingMethod.findUnique({ where: { id } });
      if (row === null) throw new AppError('NOT_FOUND', 'Shipping method not found.');
      return toAdminMethod(row);
    },

    async create(actor: AuditActor, input: CreateMethodInput): Promise<AdminMethodDto> {
      return withTransaction(db, async ({ tx }) => {
        const nameNormalized = (await assertUnique(tx, input)) ?? normalizeText(input.name);
        const row = await tx.shippingMethod.create({
          data: {
            id: randomUUID(),
            code: input.code,
            name: input.name,
            nameNormalized,
            description: input.description ?? null,
            rateType: input.rateType,
            baseCharge: input.charge,
            freeAboveAmount: input.freeAbove ?? null,
            etaMinDays: input.estimatedDaysMin ?? null,
            etaMaxDays: input.estimatedDaysMax ?? null,
            codSupported: input.codAllowed,
            codCharge: input.codCharge,
            isActive: input.status === 'ACTIVE',
            sortOrder: input.sortOrder,
          },
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: row.id,
          after: { ...row },
        });
        return toAdminMethod(row);
      });
    },

    async update(actor: AuditActor, id: string, input: UpdateMethodInput): Promise<AdminMethodDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.shippingMethod.findUnique({ where: { id } });
        if (before?.deletedAt !== null)
          throw new AppError('NOT_FOUND', 'Shipping method not found.');
        const nameNormalized = await assertUnique(tx, input, id);
        const etaMin =
          input.estimatedDaysMin === undefined ? before.etaMinDays : input.estimatedDaysMin;
        const etaMax =
          input.estimatedDaysMax === undefined ? before.etaMaxDays : input.estimatedDaysMax;
        if (etaMin !== null && etaMax !== null && etaMin > etaMax) {
          const message = 'Minimum days must not exceed maximum days.';
          throw new AppError('VALIDATION_ERROR', message, {
            details: [{ field: 'estimatedDaysMax', message }],
          });
        }
        const data: Prisma.ShippingMethodUpdateInput = {
          ...(input.code === undefined ? {} : { code: input.code }),
          ...(input.name === undefined || nameNormalized === undefined
            ? {}
            : { name: input.name, nameNormalized }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.rateType === undefined ? {} : { rateType: input.rateType }),
          ...(input.charge === undefined ? {} : { baseCharge: input.charge }),
          ...(input.freeAbove === undefined ? {} : { freeAboveAmount: input.freeAbove }),
          ...(input.estimatedDaysMin === undefined ? {} : { etaMinDays: input.estimatedDaysMin }),
          ...(input.estimatedDaysMax === undefined ? {} : { etaMaxDays: input.estimatedDaysMax }),
          ...(input.codAllowed === undefined ? {} : { codSupported: input.codAllowed }),
          ...(input.codCharge === undefined ? {} : { codCharge: input.codCharge }),
          ...(input.status === undefined ? {} : { isActive: input.status === 'ACTIVE' }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        };
        const after = await tx.shippingMethod.update({ where: { id }, data });
        await audit.record(tx, actor, {
          action:
            Object.keys(data).length === 1 && input.status !== undefined
              ? 'STATUS_CHANGE'
              : 'UPDATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before: { ...before },
          after: { ...after },
        });
        return toAdminMethod(after);
      });
    },

    async remove(actor: AuditActor, id: string): Promise<{ id: string; deleted: true }> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.shippingMethod.findUnique({ where: { id } });
        if (before?.deletedAt !== null)
          throw new AppError('NOT_FOUND', 'Shipping method not found.');
        const orders = await tx.order.count({ where: { shippingMethodId: id } });
        if (orders > 0) {
          const message = 'This shipping method is used by orders; deactivate it instead.';
          throw new AppError('CONFLICT', message, {
            details: [{ message, code: 'IN_USE', meta: { orders } }],
          });
        }
        const after = await tx.shippingMethod.update({
          where: { id },
          data: { deletedAt: clock(), isActive: false },
        });
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: ENTITY,
          entityId: id,
          before: { ...before },
          after: { ...after },
        });
        return { id, deleted: true as const };
      });
    },
  };
}

export type ShippingMethodsService = ReturnType<typeof createShippingMethodsService>;
