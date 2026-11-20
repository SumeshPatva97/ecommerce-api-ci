/**
 * Admin notification use-cases — API_DOCUMENTATION.md §4.16, NOTIFICATION_WORKFLOWS.md §10–§11.
 *
 * - Templates: email subject/body editable (body sanitised with `sanitizeRichText`, placeholders
 *   must be allow-listed for the event → 422 `UNKNOWN_VARIABLE`); WhatsApp body is read-only, only
 *   the approved provider template name, language, parameter order and (PROVISIONAL, OQ-08 — no BSP
 *   sync yet) approval status are editable. Content changes bump `version`. Audit `UPDATE`.
 * - Logs: notifications with their attempt/callback timeline; recipients masked.
 * - Resend: FAILED/SENT transactional notifications only; never token-bearing events; consent
 *   re-checked (422 `RECIPIENT_OPTED_OUT`); same address (or the account's address on a channel
 *   switch); max 3 per notification per 24 h; a repeat within 60 s returns the previous resend.
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { NotificationChannel, NotificationStatus } from '../../generated/prisma/enums.js';
import { maskEmail, maskPhone } from '../../lib/redact.js';
import { sanitizeRichText } from '../../lib/sanitizeHtml.js';
import { istDayRange } from '../../lib/time.js';
import type { AuditActor } from '../audit/audit.service.js';
import { EVENT_SPECS } from './notifications.catalog.js';
import { consentDecision } from './notifications.policy.js';
import { unknownPlaceholders } from './notifications.render.js';
import type {
  LogListQueryInput,
  ResendInput,
  TemplateListQueryInput,
  UpdateTemplateInput,
} from './notifications.schemas.js';
import { parsePayload, type NotificationService } from './notifications.service.js';
import {
  parseTemplateMeta,
  serializeTemplateMeta,
  toTemplateDto,
  type TemplateDto,
  type TemplateVariant,
} from './notifications.templates.js';

const MODULE = 'notifications';
export const RESEND_LIMIT_PER_DAY = 3;
const RESEND_REPLAY_WINDOW_MS = 60_000;

export interface NotificationLogDto {
  readonly id: string;
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly recipient: string;
  readonly recipientUserId: string | null;
  readonly entity: { readonly type: string | null; readonly id: string | null };
  readonly status: NotificationStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly providerMessageId: string | null;
  readonly resendOfId: string | null;
  readonly lastError: { readonly code: string | null; readonly message: string | null } | null;
  readonly attempts: readonly {
    readonly attemptNo: number;
    readonly type: string;
    readonly status: NotificationStatus;
    readonly providerStatus: string | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly at: string;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function maskRecipient(channel: NotificationChannel, address: string): string {
  if (address === '') return '';
  return channel === 'EMAIL' ? maskEmail(address) : maskPhone(address);
}

function unknownVariableError(details: ErrorDetail[]): AppError {
  return new AppError('VALIDATION_ERROR', 'The template uses variables that are not allowed.', {
    details,
  });
}

function notEditable(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    details: [{ field, message, code: 'NOT_EDITABLE' }],
  });
}

/** A stored WhatsApp variant's parameter order (not editable via PATCH; kept on variant edits). */
function pickOrder(existing: TemplateVariant | undefined): { order?: readonly string[] } {
  return existing?.order === undefined ? {} : { order: existing.order };
}

type LogRow = Prisma.NotificationGetPayload<{ include: { logs: true } }>;

function toLogDto(row: LogRow): NotificationLogDto {
  const logs = [...row.logs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const lastFailure = [...logs].reverse().find((l) => l.errorCode !== null);
  return {
    id: row.id,
    event: row.event,
    channel: row.channel,
    recipient: maskRecipient(row.channel, row.recipientAddress),
    recipientUserId: row.recipientUserId,
    entity: { type: row.entityType, id: row.entityId },
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    providerMessageId: row.providerMessageId,
    resendOfId: row.resendOfId,
    lastError:
      lastFailure === undefined
        ? null
        : { code: lastFailure.errorCode, message: lastFailure.errorMessage },
    attempts: logs.map((l) => ({
      attemptNo: l.attemptNo,
      type: l.logType,
      status: l.status,
      providerStatus: l.providerStatus,
      errorCode: l.errorCode,
      errorMessage: l.errorMessage,
      at: l.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createNotificationsAdminService(
  container: AppContainer,
  notifications: NotificationService,
) {
  const { db, audit, clock } = container;

  function checkPlaceholders(
    allowed: readonly string[],
    fields: readonly (readonly [string, string | undefined])[],
  ): void {
    const details: ErrorDetail[] = [];
    for (const [field, value] of fields) {
      if (value === undefined) continue;
      const unknown = unknownPlaceholders(value, allowed);
      if (unknown.length > 0) {
        details.push({
          field,
          message: `Unknown variables: ${unknown.join(', ')}.`,
          code: 'UNKNOWN_VARIABLE',
          meta: { unknown, allowed },
        });
      }
    }
    if (details.length > 0) throw unknownVariableError(details);
  }

  return {
    async listTemplates(
      query: TemplateListQueryInput,
    ): Promise<{ items: TemplateDto[]; meta: PageMeta }> {
      const where: Prisma.NotificationTemplateWhereInput = {
        ...(query.event === undefined ? {} : { event: query.event }),
        ...(query.channel === undefined ? {} : { channel: query.channel }),
      };
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.notificationTemplate.findMany({
          where,
          orderBy: [{ event: 'asc' }, { channel: 'asc' }, { locale: 'asc' }],
          skip,
          take,
        }),
        db.notificationTemplate.count({ where }),
      ]);
      return {
        items: rows.map(toTemplateDto),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async updateTemplate(
      actor: AuditActor,
      templateId: string,
      input: UpdateTemplateInput,
    ): Promise<TemplateDto> {
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.notificationTemplate.findUnique({ where: { id: templateId } });
        if (before === null) throw new AppError('NOT_FOUND', 'Template not found.');
        const allowed = EVENT_SPECS[before.event].variables;
        const meta = parseTemplateMeta(before.event, before.variables);
        const isEmail = before.channel === 'EMAIL';

        if (isEmail) {
          for (const field of [
            'providerTemplateName',
            'whatsappLanguage',
            'approvalStatus',
            'variableOrder',
          ] as const) {
            if (input[field] !== undefined) {
              throw notEditable(field, 'This field applies to WhatsApp templates only.');
            }
          }
        } else {
          for (const field of ['subject', 'bodyTemplate'] as const) {
            if (input[field] !== undefined) {
              throw notEditable(
                field,
                'WhatsApp template text is read-only; it must match the approved provider template.',
              );
            }
          }
        }

        const variants = input.variants;
        const variantFields: (readonly [string, string | undefined])[] = [];
        for (const [key, v] of Object.entries(variants ?? {})) {
          if (!isEmail && (v.subject !== undefined || v.body !== undefined)) {
            throw notEditable(`variants.${key}`, 'WhatsApp variants map a template name only.');
          }
          if (isEmail && v.whatsappTemplateName !== undefined) {
            throw notEditable(`variants.${key}`, 'Email variants cannot set a WhatsApp template.');
          }
          variantFields.push([`variants.${key}.subject`, v.subject]);
          variantFields.push([`variants.${key}.body`, v.body]);
        }
        checkPlaceholders(allowed, [
          ['subject', input.subject],
          ['bodyTemplate', input.bodyTemplate],
          ...variantFields,
        ]);
        if (input.variableOrder !== undefined) {
          const bad = input.variableOrder.filter((name) => !allowed.includes(name));
          if (bad.length > 0) {
            throw unknownVariableError([
              {
                field: 'variableOrder',
                message: `Unknown variables: ${bad.join(', ')}.`,
                code: 'UNKNOWN_VARIABLE',
                meta: { unknown: bad, allowed },
              },
            ]);
          }
        }

        const sanitizedVariants: Record<string, TemplateVariant> | undefined =
          variants === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(variants).map(([key, v]) => [
                  key,
                  {
                    ...(v.subject === undefined ? {} : { subject: v.subject }),
                    ...(v.body === undefined ? {} : { body: sanitizeRichText(v.body) }),
                    ...(v.whatsappTemplateName === undefined
                      ? {}
                      : { whatsappTemplateName: v.whatsappTemplateName }),
                    // Keep a seeded WhatsApp variant's parameter order (e.g. COD, §4.11).
                    ...pickOrder(meta.variants[key]),
                  },
                ]),
              );
        const nextMeta = {
          allowed: [...allowed],
          order: input.variableOrder ?? meta.order,
          variants: sanitizedVariants ?? meta.variants,
        };
        const contentChanged =
          input.subject !== undefined ||
          input.bodyTemplate !== undefined ||
          input.providerTemplateName !== undefined ||
          input.whatsappLanguage !== undefined ||
          input.variableOrder !== undefined ||
          input.variants !== undefined;

        const after = await tx.notificationTemplate.update({
          where: { id: templateId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            ...(input.bodyTemplate === undefined
              ? {}
              : { body: sanitizeRichText(input.bodyTemplate) }),
            ...(input.providerTemplateName === undefined
              ? {}
              : { whatsappTemplateName: input.providerTemplateName }),
            ...(input.whatsappLanguage === undefined
              ? {}
              : { whatsappLanguage: input.whatsappLanguage }),
            ...(input.approvalStatus === undefined
              ? {}
              : { whatsappApprovalStatus: input.approvalStatus }),
            ...(input.status === undefined ? {} : { isActive: input.status === 'ACTIVE' }),
            variables: serializeTemplateMeta(nextMeta) as Prisma.InputJsonValue,
            ...(contentChanged ? { version: { increment: 1 } } : {}),
          },
        });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'NotificationTemplate',
          entityId: templateId,
          before: { ...before },
          after: { ...after },
          metadata: { event: before.event, channel: before.channel },
        });
        return toTemplateDto(after);
      });
    },

    async listLogs(
      query: LogListQueryInput,
    ): Promise<{ items: NotificationLogDto[]; meta: PageMeta }> {
      const where: Prisma.NotificationWhereInput = {
        ...(query.event === undefined ? {} : { event: query.event }),
        ...(query.channel === undefined ? {} : { channel: query.channel }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.recipient === undefined
          ? {}
          : { recipientAddress: { contains: query.recipient } }),
      };
      if (query.orderNumber !== undefined) {
        const order = await db.order.findUnique({
          where: { orderNumber: query.orderNumber },
          select: { id: true },
        });
        if (order === null) {
          return { items: [], meta: buildPageMeta(query.page, query.limit, 0) };
        }
        where.entityType = 'ORDER';
        where.entityId = order.id;
      }
      if (query.from !== undefined || query.to !== undefined) {
        where.createdAt = {
          ...(query.from === undefined ? {} : { gte: istDayRange(query.from).start }),
          ...(query.to === undefined ? {} : { lt: istDayRange(query.to).end }),
        };
      }
      const { skip, take } = toSkipTake(query.page, query.limit);
      const [rows, total] = await Promise.all([
        db.notification.findMany({
          where,
          include: { logs: true },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        db.notification.count({ where }),
      ]);
      return { items: rows.map(toLogDto), meta: buildPageMeta(query.page, query.limit, total) };
    },

    async resend(
      actor: AuditActor,
      notificationId: string,
      input: ResendInput,
    ): Promise<{
      id: string;
      resendOfId: string;
      channel: NotificationChannel;
      status: NotificationStatus;
      replayed: boolean;
    }> {
      return withTransaction(db, async ({ tx }) => {
        const now = clock();
        const original = await tx.notification.findUnique({ where: { id: notificationId } });
        if (original === null) throw new AppError('NOT_FOUND', 'Notification not found.');
        const payload = parsePayload(original.payload);
        if (EVENT_SPECS[original.event].tokenBearing || payload.category !== 'TRANSACTIONAL') {
          const message =
            'This notification cannot be resent (customers must request a fresh link or code).';
          throw new AppError('VALIDATION_ERROR', message, {
            details: [{ message, code: 'RESEND_NOT_ALLOWED' }],
          });
        }
        if (original.status !== 'FAILED' && original.status !== 'SENT') {
          throw new AppError(
            'INVALID_STATE_TRANSITION',
            'Only failed or sent notifications can be resent.',
            { details: [{ message: 'Resend not allowed.', meta: { status: original.status } }] },
          );
        }

        const recent = await tx.notification.findFirst({
          where: {
            resendOfId: original.id,
            triggeredById: { not: null },
            createdAt: { gte: new Date(now.getTime() - RESEND_REPLAY_WINDOW_MS) },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, channel: true, status: true },
        });
        if (recent !== null) {
          return {
            id: recent.id,
            resendOfId: original.id,
            channel: recent.channel,
            status: recent.status,
            replayed: true,
          };
        }
        const countToday = await tx.notification.count({
          where: {
            resendOfId: original.id,
            triggeredById: { not: null },
            createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
          },
        });
        if (countToday >= RESEND_LIMIT_PER_DAY) {
          throw new AppError(
            'RATE_LIMITED',
            'This notification was already resent 3 times today.',
            {
              details: [{ message: 'Resend limit reached.', code: 'RESEND_LIMIT' }],
            },
          );
        }

        const channel = input.channel ?? original.channel;
        let to: { email?: string | null; phone?: string | null };
        if (channel === original.channel) {
          to =
            channel === 'EMAIL'
              ? { email: original.recipientAddress }
              : { phone: original.recipientAddress };
        } else {
          const user =
            original.recipientUserId === null
              ? null
              : await tx.user.findUnique({
                  where: { id: original.recipientUserId },
                  select: { email: true, phone: true },
                });
          to = { email: user?.email ?? null, phone: user?.phone ?? null };
        }
        if ((channel === 'EMAIL' ? to.email : to.phone) == null) {
          const message = 'The customer has no address for this channel.';
          throw new AppError('VALIDATION_ERROR', message, {
            details: [{ field: 'channel', message, code: 'NO_ADDRESS' }],
          });
        }
        const prefs =
          original.recipientUserId === null
            ? []
            : await tx.notificationPreference.findMany({
                where: { userId: original.recipientUserId },
                select: { channel: true, category: true, isOptedIn: true },
              });
        if (consentDecision(channel, payload.category, prefs) !== 'ALLOW') {
          const message = 'The recipient has not opted in to this channel.';
          throw new AppError('VALIDATION_ERROR', message, {
            details: [{ field: 'channel', message, code: 'RECIPIENT_OPTED_OUT' }],
          });
        }

        const [child] = await notifications.enqueue(tx, {
          event: original.event,
          channels: [channel],
          recipientUserId: original.recipientUserId,
          to,
          variables: payload.variables,
          variant: payload.variant,
          category: payload.category,
          locale: payload.locale,
          entityType: original.entityType ?? undefined,
          entityId: original.entityId ?? undefined,
          discriminator: `resend:${randomUUID()}`,
          triggeredById: actor.userId ?? null,
          resendOfId: original.id,
        });
        if (child === undefined) throw new Error('Resend produced no notification.');
        await tx.notificationLog.create({
          data: {
            id: randomUUID(),
            notificationId: child.id,
            logType: 'RESEND',
            attemptNo: 0,
            status: child.status,
            createdAt: now,
          },
        });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Notification',
          entityId: original.id,
          eventKey: 'notification.resend',
          reason: input.reason,
          diff: false,
          metadata: { resendId: child.id, channel, event: original.event },
        });
        return {
          id: child.id,
          resendOfId: original.id,
          channel,
          status: child.status,
          replayed: false,
        };
      });
    },
  };
}

export type NotificationsAdminService = ReturnType<typeof createNotificationsAdminService>;
