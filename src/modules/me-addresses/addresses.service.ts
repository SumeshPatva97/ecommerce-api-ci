/**
 * Customer address book — API_DOCUMENTATION.md §3.2 / §2.10, PROJECT_CONTEXT §15 R-02,
 * ROLE_PERMISSION_AND_AUDIT_LOGS.md §9 (customer self-service: CREATE / UPDATE / DELETE).
 *
 * - Max addresses per customer: setting `customer.max_addresses_per_customer`, default 20 (R-02).
 * - Exactly one default: the first address becomes default; DELETE of the default promotes the
 *   most recent other address. Writes lock the user row so the limit and the single-default
 *   invariant hold under concurrency.
 * - `stateCode` must exist in `states` (FK); a GSTIN's state prefix must equal it (OQ-24).
 * - Audit rows never carry street lines / phone / name values: snapshots keep city, state, PIN,
 *   type and default flag (street lines + phone masked by the redactor); changed field names go
 *   to `metadata.changedFields` (ROLE_PERMISSION_AND_AUDIT_LOGS §11 "Addresses in diffs").
 * - Orders keep their own JSON address snapshots, so edits/deletes never affect orders.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditActor } from '../audit/audit.service.js';
import { toAddressDto, type AddressDto } from './addresses.mapper.js';
import {
  createMeAddressesRepository,
  type AddressRow,
  type MeAddressesRepository,
} from './me-addresses.repository.js';
import {
  GSTIN_STATE_MESSAGE,
  type CreateAddressInput,
  type UpdateAddressInput,
} from './me-addresses.schemas.js';

const MODULE = 'customers';
const ENTITY = 'UserAddress';
export const MAX_ADDRESSES_SETTING_KEY = 'customer.max_addresses_per_customer';
export const DEFAULT_MAX_ADDRESSES = 20;

export interface AddressesService {
  list(userId: string): Promise<AddressDto[]>;
  create(actor: AuditActor, userId: string, input: CreateAddressInput): Promise<AddressDto>;
  update(
    actor: AuditActor,
    userId: string,
    addressId: string,
    input: UpdateAddressInput,
  ): Promise<AddressDto>;
  remove(
    actor: AuditActor,
    userId: string,
    addressId: string,
  ): Promise<{ id: string; deleted: true }>;
  setDefault(
    actor: AuditActor,
    userId: string,
    addressId: string,
  ): Promise<{ id: string; isDefault: true }>;
}

/** R-02: `customer.max_addresses_per_customer`, default 20 (bounded 1–100). */
export async function loadMaxAddresses(db: Queryable): Promise<number> {
  const row = await db.setting.findUnique({
    where: { settingKey: MAX_ADDRESSES_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : DEFAULT_MAX_ADDRESSES;
}

/** Audit-safe view of an address (no name/company/GSTIN values; street + phone masked). */
export function addressAuditView(row: AddressRow): Record<string, unknown> {
  return {
    id: row.id,
    addressType: row.label,
    line1: row.line1,
    line2: row.line2,
    landmark: row.landmark,
    phone: row.phone,
    city: row.city,
    stateCode: row.stateCode,
    pincode: row.postalCode,
    isDefault: row.isDefault,
  };
}

const notFound = (): AppError => new AppError('NOT_FOUND', 'Address not found.');
const fieldError = (field: string, message: string, code?: string): AppError =>
  new AppError('VALIDATION_ERROR', message, {
    details: [{ field, message, ...(code === undefined ? {} : { code }) }],
  });

/** Request field → column (for the update patch and `changedFields`). */
function toColumns(input: UpdateAddressInput): Prisma.UserAddressUncheckedUpdateInput {
  const data: Prisma.UserAddressUncheckedUpdateInput = {};
  if (input.fullName !== undefined) data.fullName = input.fullName;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.line1 !== undefined) data.line1 = input.line1;
  if (input.line2 !== undefined) data.line2 = input.line2;
  if (input.landmark !== undefined) data.landmark = input.landmark;
  if (input.city !== undefined) data.city = input.city;
  if (input.district !== undefined) data.district = input.district;
  if (input.stateCode !== undefined) data.stateCode = input.stateCode;
  if (input.pincode !== undefined) data.postalCode = input.pincode;
  if (input.addressType !== undefined) data.label = input.addressType;
  if (input.companyName !== undefined) data.companyName = input.companyName;
  if (input.gstin !== undefined) data.gstin = input.gstin;
  return data;
}

export function createAddressesService(
  container: AppContainer,
  repo: MeAddressesRepository = createMeAddressesRepository(),
): AddressesService {
  const { db, audit } = container;

  async function assertState(tx: Queryable, code: string): Promise<void> {
    if (!(await repo.stateExists(tx, code))) {
      throw fieldError('stateCode', 'Unknown state code.', 'UNKNOWN_STATE');
    }
  }

  async function loadOwned(tx: Queryable, userId: string, id: string): Promise<AddressRow> {
    const row = await repo.findAddress(tx, userId, id);
    if (row === null) throw notFound();
    return row;
  }

  return {
    async list(userId) {
      return (await repo.listAddresses(db, userId)).map(toAddressDto);
    },

    async create(actor, userId, input) {
      const max = await loadMaxAddresses(db);
      return withTransaction(db, async ({ tx }) => {
        await repo.lockUser(tx, userId);
        await assertState(tx, input.stateCode);
        const count = await repo.countAddresses(tx, userId);
        if (count >= max) {
          throw fieldError(
            'addresses',
            `You can save at most ${max} addresses.`,
            'ADDRESS_LIMIT_REACHED',
          );
        }
        const isDefault = count === 0 || input.isDefault === true;
        if (isDefault) await repo.clearDefault(tx, userId);
        const row = await repo.createAddress(tx, {
          id: randomUUID(),
          userId,
          label: input.addressType ?? 'HOME',
          fullName: input.fullName,
          phone: input.phone,
          line1: input.line1,
          line2: input.line2 ?? null,
          landmark: input.landmark ?? null,
          city: input.city,
          district: input.district ?? null,
          stateCode: input.stateCode,
          postalCode: input.pincode,
          countryCode: 'IN',
          companyName: input.companyName ?? null,
          gstin: input.gstin ?? null,
          isDefault,
        });
        await audit.record(tx, actor, {
          action: 'CREATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: row.id,
          eventKey: 'address.created',
          after: addressAuditView(row),
        });
        return toAddressDto(row);
      });
    },

    async update(actor, userId, addressId, input) {
      return withTransaction(db, async ({ tx }) => {
        await repo.lockUser(tx, userId);
        const before = await loadOwned(tx, userId, addressId);
        const stateCode = input.stateCode ?? before.stateCode;
        const gstin = input.gstin === undefined ? before.gstin : input.gstin;
        if (input.stateCode !== undefined && input.stateCode !== before.stateCode) {
          await assertState(tx, input.stateCode);
        }
        if (gstin !== null && gstin.slice(0, 2) !== stateCode) {
          throw fieldError('gstin', GSTIN_STATE_MESSAGE);
        }
        const data = toColumns(input);
        const changedFields = Object.keys(data).filter(
          (k) => (before as Record<string, unknown>)[k] !== (data as Record<string, unknown>)[k],
        );
        if (input.isDefault === true && !before.isDefault) {
          await repo.clearDefault(tx, userId, addressId);
          data.isDefault = true;
          changedFields.push('isDefault');
        }
        if (changedFields.length === 0) return toAddressDto(before);
        const after = await repo.updateAddress(tx, addressId, data);
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: ENTITY,
          entityId: addressId,
          eventKey: 'address.updated',
          before: addressAuditView(before),
          after: addressAuditView(after),
          metadata: { changedFields },
        });
        return toAddressDto(after);
      });
    },

    async remove(actor, userId, addressId) {
      return withTransaction(db, async ({ tx }) => {
        await repo.lockUser(tx, userId);
        const before = await loadOwned(tx, userId, addressId);
        await repo.deleteAddress(tx, addressId);
        let promotedId: string | null = null;
        if (before.isDefault) {
          const next = await repo.newestOtherAddress(tx, userId, addressId);
          if (next !== null) {
            await repo.updateAddress(tx, next.id, { isDefault: true });
            promotedId = next.id;
          }
        }
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: ENTITY,
          entityId: addressId,
          eventKey: 'address.deleted',
          before: addressAuditView(before),
          ...(promotedId === null ? {} : { metadata: { promotedDefaultId: promotedId } }),
        });
        return { id: addressId, deleted: true as const };
      });
    },

    async setDefault(actor, userId, addressId) {
      return withTransaction(db, async ({ tx }) => {
        await repo.lockUser(tx, userId);
        const before = await loadOwned(tx, userId, addressId);
        if (!before.isDefault) {
          await repo.clearDefault(tx, userId, addressId);
          const after = await repo.updateAddress(tx, addressId, { isDefault: true });
          await audit.record(tx, actor, {
            action: 'UPDATE',
            module: MODULE,
            entityType: ENTITY,
            entityId: addressId,
            eventKey: 'address.default_changed',
            before: addressAuditView(before),
            after: addressAuditView(after),
            metadata: { changedFields: ['isDefault'] },
          });
        }
        return { id: addressId, isDefault: true as const };
      });
    },
  };
}
