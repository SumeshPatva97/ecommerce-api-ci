/**
 * Customer notification preferences — API_DOCUMENTATION.md §3.2, NOTIFICATION_WORKFLOWS.md §5.
 * PROVISIONAL (OQ-38 legal/DPDP review).
 *
 * - EMAIL transactional is always on: `EMAIL.transactional = false` → 422 (essential messages such
 *   as security alerts and order confirmations cannot be disabled). The approved schema has no
 *   separate "order updates" category, so order-update emails follow the same rule.
 * - WhatsApp needs explicit opt-in; opting in requires a phone number on the account.
 * - Every consent change upserts `notification_preferences` (source, text version, timestamps, IP)
 *   and writes an audit row (`UPDATE`, eventKey `consent.changed`) in the same transaction.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import type { NotificationCategory, NotificationChannel } from '../../generated/prisma/enums.js';
import type { AuditActor } from '../audit/audit.service.js';
import type { UpdatePreferencesInput } from './notifications.schemas.js';

export interface PreferencesDto {
  readonly channels: {
    readonly EMAIL: { readonly transactional: true; readonly marketing: boolean };
    readonly WHATSAPP: {
      readonly transactional: boolean;
      readonly marketing: boolean;
      readonly optedOutAt: string | null;
    };
  };
  readonly updatedAt: string | null;
}

interface PrefRow {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly category: NotificationCategory;
  readonly isOptedIn: boolean;
  readonly optedOutAt: Date | null;
  readonly updatedAt: Date;
}

export function toPreferencesDto(rows: readonly PrefRow[]): PreferencesDto {
  const find = (channel: NotificationChannel, category: NotificationCategory) =>
    rows.find((r) => r.channel === channel && r.category === category);
  const waTx = find('WHATSAPP', 'TRANSACTIONAL');
  const waMk = find('WHATSAPP', 'MARKETING');
  const optedOut = [waTx?.optedOutAt, waMk?.optedOutAt]
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const latest = rows.map((r) => r.updatedAt).sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    channels: {
      EMAIL: { transactional: true, marketing: find('EMAIL', 'MARKETING')?.isOptedIn ?? false },
      WHATSAPP: {
        transactional: waTx?.isOptedIn ?? false,
        marketing: waMk?.isOptedIn ?? false,
        optedOutAt: optedOut?.toISOString() ?? null,
      },
    },
    updatedAt: latest?.toISOString() ?? null,
  };
}

const SELECT = {
  id: true,
  channel: true,
  category: true,
  isOptedIn: true,
  optedOutAt: true,
  updatedAt: true,
} as const;

export function createPreferencesService(container: AppContainer) {
  const { db, audit, clock } = container;

  return {
    async get(userId: string): Promise<PreferencesDto> {
      const rows = await db.notificationPreference.findMany({ where: { userId }, select: SELECT });
      return toPreferencesDto(rows);
    },

    async update(
      actor: AuditActor,
      userId: string,
      input: UpdatePreferencesInput,
    ): Promise<PreferencesDto> {
      if (input.channels.EMAIL?.transactional === false) {
        const message = 'Essential emails (security and order messages) cannot be turned off.';
        throw new AppError('VALIDATION_ERROR', message, {
          details: [
            { field: 'channels.EMAIL.transactional', message, code: 'ESSENTIAL_EMAIL_REQUIRED' },
          ],
        });
      }
      const changes: {
        channel: NotificationChannel;
        category: NotificationCategory;
        on: boolean;
      }[] = [];
      if (input.channels.EMAIL?.marketing !== undefined) {
        changes.push({
          channel: 'EMAIL',
          category: 'MARKETING',
          on: input.channels.EMAIL.marketing,
        });
      }
      const wa = input.channels.WHATSAPP;
      if (wa?.transactional !== undefined) {
        changes.push({ channel: 'WHATSAPP', category: 'TRANSACTIONAL', on: wa.transactional });
      }
      if (wa?.marketing !== undefined) {
        changes.push({ channel: 'WHATSAPP', category: 'MARKETING', on: wa.marketing });
      }

      return withTransaction(db, async ({ tx }) => {
        const now = clock();
        if (changes.some((c) => c.channel === 'WHATSAPP' && c.on)) {
          const user = await tx.user.findUnique({ where: { id: userId }, select: { phone: true } });
          if (user?.phone === null || user?.phone === undefined) {
            const message = 'Add a mobile number to your profile before enabling WhatsApp.';
            throw new AppError('VALIDATION_ERROR', message, {
              details: [{ field: 'channels.WHATSAPP', message, code: 'PHONE_REQUIRED' }],
            });
          }
        }
        const existing = await tx.notificationPreference.findMany({
          where: { userId },
          select: SELECT,
        });
        for (const change of changes) {
          const before = existing.find(
            (r) => r.channel === change.channel && r.category === change.category,
          );
          if (before?.isOptedIn === change.on) continue;
          const consent = {
            isOptedIn: change.on,
            consentSource: 'ACCOUNT',
            consentTextVersion: input.consentTextVersion ?? null,
            ipAddress: actor.ip?.slice(0, 45) ?? null,
            ...(change.on ? { consentedAt: now, optedOutAt: null } : { optedOutAt: now }),
          };
          const row = await tx.notificationPreference.upsert({
            where: {
              userId_channel_category: {
                userId,
                channel: change.channel,
                category: change.category,
              },
            },
            create: {
              id: randomUUID(),
              userId,
              channel: change.channel,
              category: change.category,
              ...consent,
            },
            update: consent,
          });
          await audit.record(tx, actor, {
            action: 'UPDATE',
            module: 'notifications',
            entityType: 'NotificationPreference',
            entityId: row.id,
            eventKey: 'consent.changed',
            before: before === undefined ? null : { isOptedIn: before.isOptedIn },
            after: { isOptedIn: change.on },
            diff: false,
            metadata: {
              channel: change.channel,
              category: change.category,
              source: 'ACCOUNT',
              consentTextVersion: input.consentTextVersion ?? null,
            },
          });
        }
        const rows = await tx.notificationPreference.findMany({
          where: { userId },
          select: SELECT,
        });
        return toPreferencesDto(rows);
      });
    },
  };
}

export type PreferencesService = ReturnType<typeof createPreferencesService>;
