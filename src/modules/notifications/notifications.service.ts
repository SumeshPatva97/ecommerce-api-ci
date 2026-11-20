/**
 * NotificationService.enqueue — the transactional outbox (BACKEND_STRUCTURE.md §13,
 * NOTIFICATION_WORKFLOWS.md §2.2, §8). PROVISIONAL (OQ-77): `notifications` rows are the outbox; no
 * separate `outbox_events` table.
 *
 * Callers pass THEIR transaction client so the rows exist iff the business change commits:
 *
 *   await notifications.enqueue(tx, {
 *     event: 'ORDER_SHIPPED', channels: ['EMAIL', 'WHATSAPP'],
 *     recipientUserId: order.userId, to: { email, phone },
 *     entityType: 'ORDER', entityId: order.id, discriminator: shipment.id,
 *     variables: { firstName, orderNumber, courier, awb },
 *   });
 *
 * - One row per channel; `dedupe_key = sha256(event|entityType|entityId|channel|recipient|discriminator)`
 *   (UNIQUE) — a duplicate is reported as `created: false` and never throws.
 * - Rows with no address or an unsupported channel are stored as `SKIPPED` with a log row.
 * - Secret-looking variable names are refused (payload stores variables only, never secrets).
 *   Token-bearing events (verification, reset, staff invite) are refused: they keep using the auth
 *   module's direct send until a token-reference design exists (tokens must not rest in payloads).
 * - Delivery happens later in `dispatchPending` (src/jobs/notificationDispatcher.ts).
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Queryable } from '../../core/db/transaction.js';
import { isPrismaKnownError } from '../../core/errors/prismaErrorMapper.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationEvent,
  NotificationStatus,
} from '../../generated/prisma/enums.js';
import {
  EVENT_SPECS,
  SECRET_VARIABLE,
  SENDABLE_CHANNELS,
  implicitVariant,
  quietHoursDeferral,
  type SkipReason,
} from './notifications.catalog.js';
import type { TemplateValue, TemplateVariables } from './notifications.render.js';

export interface EnqueueNotificationInput {
  readonly event: NotificationEvent;
  readonly channels: readonly NotificationChannel[];
  readonly recipientUserId?: string | null | undefined;
  readonly to: {
    readonly email?: string | null | undefined;
    readonly phone?: string | null | undefined;
  };
  readonly variables: TemplateVariables;
  /** Template variant inside the (event, channel) template, e.g. `ALREADY_REGISTERED` (OQ-82). */
  readonly variant?: string | undefined;
  /** Overrides the event's consent category (e.g. `MARKETING`). */
  readonly category?: NotificationCategory | undefined;
  readonly entityType?: string | undefined;
  /** UUID of the entity (column is CHAR(36)); business numbers go in `variables`. */
  readonly entityId?: string | undefined;
  /** Dedupe discriminator (§8.1), e.g. shipment id for ORDER_SHIPPED. */
  readonly discriminator?: string | undefined;
  readonly locale?: string | undefined;
  readonly triggeredById?: string | null | undefined;
  readonly resendOfId?: string | null | undefined;
}

export interface EnqueuedNotification {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  /** false when an identical notification (same dedupe key) already existed. */
  readonly created: boolean;
}

/** Shape of `notifications.payload` (variables only — never secrets or rendered bodies). */
export interface NotificationPayload {
  readonly v: 1;
  readonly locale: string;
  readonly category: NotificationCategory;
  readonly variant?: string;
  readonly variables: Record<string, TemplateValue>;
}

export const DEFAULT_LOCALE = 'en-IN';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildDedupeKey(parts: {
  event: NotificationEvent;
  entityType?: string | undefined;
  entityId?: string | undefined;
  channel: NotificationChannel;
  recipient: string;
  discriminator?: string | undefined;
}): string {
  const raw = [
    parts.event,
    parts.entityType ?? '',
    parts.entityId ?? '',
    parts.channel,
    parts.recipient,
    parts.discriminator ?? '',
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export function addressFor(
  channel: NotificationChannel,
  to: EnqueueNotificationInput['to'],
  recipientUserId: string | null | undefined,
): string | undefined {
  const pick = (v: string | null | undefined): string | undefined =>
    v === null || v === undefined || v.trim() === '' ? undefined : v.trim();
  switch (channel) {
    case 'EMAIL':
      return pick(to.email);
    case 'WHATSAPP':
    case 'SMS':
      return pick(to.phone);
    case 'IN_APP':
      return pick(recipientUserId);
  }
}

export function parsePayload(raw: unknown): NotificationPayload {
  const obj =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const variables: Record<string, TemplateValue> = {};
  const rawVars = obj.variables;
  if (typeof rawVars === 'object' && rawVars !== null && !Array.isArray(rawVars)) {
    for (const [k, v] of Object.entries(rawVars as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
        variables[k] = v;
      }
    }
  }
  const category = obj.category;
  return {
    v: 1,
    locale: typeof obj.locale === 'string' ? obj.locale : DEFAULT_LOCALE,
    category:
      category === 'MARKETING' || category === 'STAFF_ALERTS' || category === 'TRANSACTIONAL'
        ? category
        : 'TRANSACTIONAL',
    ...(typeof obj.variant === 'string' ? { variant: obj.variant } : {}),
    variables,
  };
}

export interface NotificationServiceDeps {
  readonly clock: () => Date;
}

export function createNotificationService(deps: NotificationServiceDeps) {
  async function insertOne(
    tx: Queryable,
    input: EnqueueNotificationInput,
    channel: NotificationChannel,
    payload: NotificationPayload,
  ): Promise<EnqueuedNotification> {
    const now = deps.clock();
    const address = addressFor(channel, input.to, input.recipientUserId);
    const recipientUserId = input.recipientUserId ?? null;
    const dedupeKey = buildDedupeKey({
      event: input.event,
      entityType: input.entityType,
      entityId: input.entityId,
      channel,
      recipient: recipientUserId ?? address ?? '',
      discriminator: input.discriminator,
    });

    const existing = await tx.notification.findUnique({
      where: { dedupeKey },
      select: { id: true, status: true },
    });
    if (existing !== null)
      return { id: existing.id, channel, status: existing.status, created: false };

    let skip: SkipReason | undefined;
    if (!SENDABLE_CHANNELS.has(channel)) skip = 'CHANNEL_UNSUPPORTED';
    else if (address === undefined) skip = 'NO_ADDRESS';

    const spec = EVENT_SPECS[input.event];
    const deferred =
      skip === undefined &&
      ((channel === 'WHATSAPP' && spec.quietHours) || payload.category === 'MARKETING')
        ? quietHoursDeferral(now)
        : undefined;

    const id = randomUUID();
    const status: NotificationStatus = skip === undefined ? 'QUEUED' : 'SKIPPED';
    const data: Prisma.NotificationUncheckedCreateInput = {
      id,
      event: input.event,
      channel,
      recipientUserId,
      recipientAddress: (address ?? '').slice(0, 254),
      entityType: input.entityType?.slice(0, 50) ?? null,
      entityId: input.entityId !== undefined && UUID.test(input.entityId) ? input.entityId : null,
      dedupeKey,
      payload: payload as unknown as Prisma.InputJsonValue,
      status,
      attemptCount: 0,
      nextAttemptAt: deferred ?? null,
      resendOfId: input.resendOfId ?? null,
      triggeredById: input.triggeredById ?? null,
      createdAt: now,
    };
    try {
      await tx.notification.create({ data });
    } catch (error) {
      if (isPrismaKnownError(error) && error.code === 'P2002') {
        const row = await tx.notification.findUnique({
          where: { dedupeKey },
          select: { id: true, status: true },
        });
        if (row !== null) return { id: row.id, channel, status: row.status, created: false };
      }
      throw error;
    }
    if (skip !== undefined) {
      await tx.notificationLog.create({
        data: {
          id: randomUUID(),
          notificationId: id,
          logType: 'SKIPPED',
          attemptNo: 0,
          status: 'SKIPPED',
          errorCode: skip,
          createdAt: now,
        },
      });
    }
    return { id, channel, status, created: true };
  }

  return {
    async enqueue(tx: Queryable, input: EnqueueNotificationInput): Promise<EnqueuedNotification[]> {
      const spec = EVENT_SPECS[input.event];
      if (spec.tokenBearing) {
        throw new Error(
          `${input.event} carries a single-use token and is not sent through the outbox.`,
        );
      }
      const secret = Object.keys(input.variables).find((name) => SECRET_VARIABLE.test(name));
      if (secret !== undefined) {
        throw new Error(`Notification variable "${secret}" looks secret and cannot be queued.`);
      }
      // §4.11: a COD out-for-delivery (caller passed `codAmount`) uses the COD variant.
      const variant = input.variant ?? implicitVariant(input.event, input.variables);
      const payload: NotificationPayload = {
        v: 1,
        locale: input.locale ?? DEFAULT_LOCALE,
        category: input.category ?? spec.category,
        ...(variant === undefined ? {} : { variant }),
        variables: { ...input.variables },
      };
      const channels = [...new Set(input.channels)];
      const out: EnqueuedNotification[] = [];
      for (const channel of channels) out.push(await insertOne(tx, input, channel, payload));
      return out;
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
