/**
 * Customer profile use-cases — API_DOCUMENTATION.md §3.2 (`GET/PATCH /me`). Always scoped to the
 * authenticated user (no client-supplied user id, §20).
 */
import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { userActor, type RequestMeta } from '../auth/auth.context.js';
import { toMeDto, type MeDto, type MeRow } from './me.profile.mapper.js';
import type { UpdateMeInput } from './me.profile.schemas.js';

const ME_SELECT = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  phone: true,
  phoneVerifiedAt: true,
  firstName: true,
  lastName: true,
  status: true,
  createdAt: true,
  deletedAt: true,
} as const;

export interface MeProfileService {
  get(userId: string): Promise<MeDto>;
  update(userId: string, input: UpdateMeInput, meta: RequestMeta): Promise<MeDto>;
}

export function createMeProfileService(container: AppContainer): MeProfileService {
  const { db } = container;

  async function load(userId: string): Promise<MeRow> {
    const user = await db.user.findUnique({ where: { id: userId }, select: ME_SELECT });
    if (user?.deletedAt !== null) {
      throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
    }
    return user;
  }

  async function defaultAddressId(userId: string): Promise<string | null> {
    const address = await db.userAddress.findFirst({
      where: { userId, isDefault: true },
      select: { id: true },
    });
    return address?.id ?? null;
  }

  async function get(userId: string): Promise<MeDto> {
    const [user, addressId] = await Promise.all([load(userId), defaultAddressId(userId)]);
    return toMeDto(user, addressId);
  }

  return {
    get,

    async update(userId, input, meta) {
      const before = await load(userId);
      const data: {
        firstName?: string;
        lastName?: string | null;
        phone?: string | null;
        phoneVerifiedAt?: null;
      } = {};
      if (input.firstName !== undefined && input.firstName !== before.firstName) {
        data.firstName = input.firstName;
      }
      if (input.lastName !== undefined) {
        const lastName = input.lastName === '' ? null : input.lastName;
        if (lastName !== before.lastName) data.lastName = lastName;
      }
      if (input.phone !== undefined && input.phone !== before.phone) {
        if (input.phone !== null) {
          const owner = await db.user.findUnique({
            where: { phone: input.phone },
            select: { id: true },
          });
          if (owner !== null && owner.id !== userId) {
            throw new AppError('DUPLICATE_RESOURCE', 'This mobile number is already in use.', {
              details: [{ field: 'phone', message: 'This mobile number is already in use.' }],
            });
          }
        }
        data.phone = input.phone;
        data.phoneVerifiedAt = null; // a changed number must be re-verified (OTP)
      }
      if (Object.keys(data).length > 0) {
        await withTransaction(db, async (ctx) => {
          await ctx.tx.user.update({ where: { id: userId }, data });
          await container.audit.record(ctx.tx, userActor(meta, userId, 'storefront'), {
            action: 'UPDATE',
            module: 'customers',
            entityType: 'User',
            entityId: userId,
            eventKey: 'profile.updated',
            before: { firstName: before.firstName, lastName: before.lastName, phone: before.phone },
            after: {
              firstName: data.firstName ?? before.firstName,
              lastName: data.lastName === undefined ? before.lastName : data.lastName,
              phone: data.phone === undefined ? before.phone : data.phone,
            },
          });
          ctx.afterCommit(() => {
            container.permissions.invalidateUser(userId);
          });
        });
      }
      return get(userId);
    },
  };
}
