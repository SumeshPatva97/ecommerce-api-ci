/**
 * Notification dispatcher — NOTIFICATION_WORKFLOWS.md §2.2 (conditional QUEUED→SENDING claim),
 * §5.3 (consent re-checked at send time), §7 (retry schedule, error classes, WhatsApp→email
 * fallback), §10 (WhatsApp template approval guard). Providers: `container.providers.email` /
 * `.whatsapp` (fake/mock adapters, OQ-08 — no real vendor).
 *
 * No queue (Redis/BullMQ deferred, D-38/OQ-35): `dispatchPending(limit)` polls due rows
 * (`status = QUEUED AND (next_attempt_at IS NULL OR next_attempt_at <= now)`), so it doubles as the
 * recovery sweep. Each row is claimed with a compare-and-set update, so concurrent runs never send
 * the same row twice. Provider calls run outside any DB transaction.
 */
import { randomUUID } from 'node:crypto';

import type { DbClient } from '../../core/db/transaction.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Notification, NotificationTemplate } from '../../generated/prisma/client.js';
import type { NotificationStatus } from '../../generated/prisma/enums.js';
import type { EmailProviderAdapter } from '../../integrations/email/emailProvider.js';
import type { WhatsAppProviderAdapter } from '../../integrations/whatsapp/whatsappProvider.js';
import {
  EVENT_SPECS,
  MAX_ATTEMPTS,
  retryDelayMs,
  type SkipReason,
} from './notifications.catalog.js';
import { consentDecision } from './notifications.policy.js';
import {
  htmlToText,
  renderTemplate,
  whatsappParameters,
  type TemplateValue,
} from './notifications.render.js';
import {
  DEFAULT_LOCALE,
  parsePayload,
  type NotificationPayload,
  type NotificationService,
} from './notifications.service.js';
import { parseTemplateMeta, resolveVariant } from './notifications.templates.js';

/** Provider error classes (§7.2); adapters map vendor codes to these. */
export type SendErrorClass =
  'TRANSIENT' | 'PERMANENT_RECIPIENT' | 'PERMANENT_TEMPLATE' | 'PERMANENT_POLICY' | 'AUTH';

export class NotificationSendError extends Error {
  constructor(
    readonly errorClass: SendErrorClass,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'NotificationSendError';
  }
}

export interface DispatcherDeps {
  readonly db: DbClient;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly clock: () => Date;
  readonly email: EmailProviderAdapter;
  readonly whatsapp: WhatsAppProviderAdapter;
  readonly notifications: NotificationService;
  /** Jitter source (tests pass a constant). */
  readonly random?: () => number;
  /** Provider call timeout (BACKEND_STRUCTURE §15: email/WhatsApp 10 s). */
  readonly timeoutMs?: number;
}

export interface DispatchSummary {
  picked: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
  /** Claimed by a concurrent run (compare-and-set lost). */
  lost: number;
}

export type DispatchOutcome = 'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'LOST';

export const WHATSAPP_ENABLED_SETTING = 'notifications.whatsapp_enabled';

interface BatchContext {
  whatsappEnabled: boolean;
  defaults: Record<string, TemplateValue>;
}

function classify(error: unknown): { errorClass: SendErrorClass; code: string; message: string } {
  if (error instanceof NotificationSendError) {
    return { errorClass: error.errorClass, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : 'Unknown provider error';
  return { errorClass: 'TRANSIENT', code: 'PROVIDER_ERROR', message };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new NotificationSendError('TRANSIENT', 'TIMEOUT', 'Provider call timed out.'));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createNotificationDispatcher(deps: DispatcherDeps) {
  const { db, logger, clock } = deps;
  const random = deps.random ?? Math.random;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  async function loadBatchContext(): Promise<BatchContext> {
    const rows = await db.setting.findMany({
      where: {
        settingKey: { in: [WHATSAPP_ENABLED_SETTING, 'store.name', 'store.support_email'] },
      },
      select: { settingKey: true, value: true },
    });
    const value = (key: string): unknown => rows.find((r) => r.settingKey === key)?.value;
    const str = (key: string): string | undefined => {
      const v = value(key);
      return typeof v === 'string' && v !== '' ? v : undefined;
    };
    const brandName = str('store.name');
    const supportEmail = str('store.support_email');
    return {
      // Seed default is false until a BSP is chosen (OQ-08); a missing row means disabled.
      whatsappEnabled: value(WHATSAPP_ENABLED_SETTING) === true,
      defaults: {
        ...(brandName === undefined ? {} : { brandName }),
        ...(supportEmail === undefined ? {} : { supportEmail }),
      },
    };
  }

  async function log(
    notificationId: string,
    entry: {
      logType: string;
      attemptNo: number;
      status: NotificationStatus;
      providerStatus?: string;
      errorCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    await db.notificationLog.create({
      data: {
        id: randomUUID(),
        notificationId,
        logType: entry.logType,
        attemptNo: entry.attemptNo,
        status: entry.status,
        providerStatus: entry.providerStatus?.slice(0, 100) ?? null,
        errorCode: entry.errorCode?.slice(0, 60) ?? null,
        errorMessage: entry.errorMessage?.slice(0, 500) ?? null,
        createdAt: clock(),
      },
    });
  }

  async function finish(
    row: Notification,
    status: NotificationStatus,
    data: { providerMessageId?: string; templateId?: string; nextAttemptAt?: Date | null } = {},
  ): Promise<void> {
    await db.notification.update({
      where: { id: row.id },
      data: {
        status,
        ...(data.providerMessageId === undefined
          ? {}
          : { providerMessageId: data.providerMessageId.slice(0, 191) }),
        ...(data.templateId === undefined ? {} : { templateId: data.templateId }),
        ...(data.nextAttemptAt === undefined ? {} : { nextAttemptAt: data.nextAttemptAt }),
      },
    });
  }

  /** §7.3: WhatsApp gave up → email for the same event/entity unless one already exists. */
  async function fallbackToEmail(row: Notification, payload: NotificationPayload): Promise<void> {
    if (row.channel !== 'WHATSAPP' || row.recipientUserId === null) return;
    if (EVENT_SPECS[row.event].tokenBearing) return;
    const user = await db.user.findUnique({
      where: { id: row.recipientUserId },
      select: { email: true },
    });
    if (user === null) return;
    const [created] = await deps.notifications.enqueue(db, {
      event: row.event,
      channels: ['EMAIL'],
      recipientUserId: row.recipientUserId,
      to: { email: user.email },
      variables: payload.variables,
      variant: payload.variant,
      category: payload.category,
      entityType: row.entityType ?? undefined,
      entityId: row.entityId ?? undefined,
      resendOfId: row.id,
    });
    if (created?.created === true) {
      await log(created.id, { logType: 'FALLBACK', attemptNo: 0, status: 'QUEUED' });
    }
  }

  async function skip(
    row: Notification,
    attemptNo: number,
    reason: SkipReason,
    payload: NotificationPayload,
  ): Promise<DispatchOutcome> {
    await finish(row, 'SKIPPED');
    await log(row.id, { logType: 'SKIPPED', attemptNo, status: 'SKIPPED', errorCode: reason });
    if (reason === 'TEMPLATE_NOT_APPROVED' || reason === 'CHANNEL_DISABLED') {
      await fallbackToEmail(row, payload);
    }
    return 'SKIPPED';
  }

  async function findTemplate(
    row: Notification,
    locale: string,
  ): Promise<NotificationTemplate | null> {
    const exact = await db.notificationTemplate.findFirst({
      where: { event: row.event, channel: row.channel, locale, isActive: true },
    });
    if (exact !== null || locale === DEFAULT_LOCALE) return exact;
    return db.notificationTemplate.findFirst({
      where: { event: row.event, channel: row.channel, locale: DEFAULT_LOCALE, isActive: true },
    });
  }

  async function send(
    row: Notification,
    template: NotificationTemplate,
    payload: NotificationPayload,
    batch: BatchContext,
  ): Promise<{ messageId: string; accepted: boolean }> {
    const meta = parseTemplateMeta(row.event, template.variables);
    const resolved = resolveVariant(template, meta, payload.variant);
    const variables = { ...batch.defaults, ...payload.variables };
    if (row.channel === 'EMAIL') {
      if (resolved.subject === null || resolved.body === null) {
        throw new NotificationSendError('PERMANENT_TEMPLATE', 'TEMPLATE_INCOMPLETE');
      }
      const html = renderTemplate(resolved.body, variables, 'html');
      const result = await withTimeout(
        deps.email.send({
          to: row.recipientAddress,
          subject: renderTemplate(resolved.subject, variables, 'subject'),
          html,
          text: htmlToText(html),
          templateKey: `${row.event.toLowerCase()}${payload.variant === undefined ? '' : `:${payload.variant.toLowerCase()}`}`,
        }),
        timeoutMs,
      );
      return { messageId: result.messageId, accepted: result.accepted };
    }
    if (resolved.whatsappTemplateName === null) {
      throw new NotificationSendError('PERMANENT_TEMPLATE', 'TEMPLATE_INCOMPLETE');
    }
    const result = await withTimeout(
      deps.whatsapp.send({
        to: row.recipientAddress,
        templateKey: resolved.whatsappTemplateName,
        variables: whatsappParameters(resolved.order, variables),
      }),
      timeoutMs,
    );
    return { messageId: result.messageId, accepted: result.accepted };
  }

  async function processRow(row: Notification, batch: BatchContext): Promise<DispatchOutcome> {
    const now = clock();
    const claimed = await db.notification.updateMany({
      where: {
        id: row.id,
        status: 'QUEUED',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: { status: 'SENDING', attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) return 'LOST';
    const attemptNo = row.attemptCount + 1;
    const payload = parsePayload(row.payload);

    if (row.channel !== 'EMAIL' && row.channel !== 'WHATSAPP') {
      return skip(row, attemptNo, 'CHANNEL_UNSUPPORTED', payload);
    }
    if (row.recipientAddress === '') return skip(row, attemptNo, 'NO_ADDRESS', payload);
    if (row.channel === 'WHATSAPP' && !batch.whatsappEnabled) {
      return skip(row, attemptNo, 'CHANNEL_DISABLED', payload);
    }

    const prefs =
      row.recipientUserId === null
        ? []
        : await db.notificationPreference.findMany({
            where: { userId: row.recipientUserId },
            select: { channel: true, category: true, isOptedIn: true },
          });
    const decision = consentDecision(row.channel, payload.category, prefs);
    if (decision !== 'ALLOW') {
      return skip(row, attemptNo, decision === 'OPTED_OUT' ? 'OPTED_OUT' : 'NO_CONSENT', payload);
    }

    const template = await findTemplate(row, payload.locale);
    if (template === null) {
      logger.warn(
        { notificationId: row.id, event: row.event, channel: row.channel },
        'no template',
      );
      return skip(row, attemptNo, 'TEMPLATE_MISSING', payload);
    }
    if (row.channel === 'WHATSAPP' && template.whatsappApprovalStatus !== 'APPROVED') {
      return skip(row, attemptNo, 'TEMPLATE_NOT_APPROVED', payload);
    }

    try {
      const result = await send(row, template, payload, batch);
      if (!result.accepted) {
        throw new NotificationSendError('PERMANENT_RECIPIENT', 'PROVIDER_REJECTED');
      }
      await finish(row, 'SENT', { providerMessageId: result.messageId, templateId: template.id });
      await log(row.id, {
        logType: 'SEND_ATTEMPT',
        attemptNo,
        status: 'SENT',
        providerStatus: 'accepted',
      });
      return 'SENT';
    } catch (error) {
      const { errorClass, code, message } = classify(error);
      const retryable = errorClass === 'TRANSIENT' || errorClass === 'AUTH';
      if (retryable && attemptNo < MAX_ATTEMPTS) {
        const nextAttemptAt = new Date(clock().getTime() + retryDelayMs(attemptNo, random));
        await finish(row, 'QUEUED', { templateId: template.id, nextAttemptAt });
        await log(row.id, {
          logType: 'SEND_ATTEMPT',
          attemptNo,
          status: 'FAILED',
          providerStatus: errorClass,
          errorCode: code,
          errorMessage: message,
        });
        return 'RETRY';
      }
      await finish(row, 'FAILED', { templateId: template.id, nextAttemptAt: null });
      await log(row.id, {
        logType: 'SEND_ATTEMPT',
        attemptNo,
        status: 'FAILED',
        providerStatus: errorClass,
        errorCode: code,
        errorMessage: message,
      });
      if (errorClass === 'PERMANENT_TEMPLATE') {
        logger.error(
          { notificationId: row.id, event: row.event, code },
          'notification template error',
        );
      }
      await fallbackToEmail(row, payload);
      return 'FAILED';
    }
  }

  return {
    /**
     * Sends up to `limit` due notifications. Safe to run concurrently and repeatedly.
     * `signal` (Batch 9, WP-O2): checked before each row is claimed; rows not yet claimed stay QUEUED
     * for the next pass, and the row being sent is always finished.
     */
    async dispatchPending(limit = 50, signal?: AbortSignal): Promise<DispatchSummary> {
      const now = clock();
      const rows = await db.notification.findMany({
        where: {
          status: 'QUEUED',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: Math.max(1, Math.min(limit, 500)),
      });
      const summary: DispatchSummary = {
        picked: rows.length,
        sent: 0,
        skipped: 0,
        retried: 0,
        failed: 0,
        lost: 0,
      };
      if (rows.length === 0) return summary;
      const batch = await loadBatchContext();
      let processed = 0;
      for (const row of rows) {
        if (signal?.aborted === true) {
          logger.info(
            { processed, remaining: rows.length - processed },
            'notification dispatch stopping early (shutdown)',
          );
          break;
        }
        processed += 1;
        let outcome: DispatchOutcome;
        try {
          outcome = await processRow(row, batch);
        } catch (error) {
          // A DB failure mid-row leaves it SENDING; it is logged and picked up by an operator.
          logger.error({ err: error, notificationId: row.id }, 'notification dispatch failed');
          outcome = 'FAILED';
        }
        if (outcome === 'SENT') summary.sent += 1;
        else if (outcome === 'SKIPPED') summary.skipped += 1;
        else if (outcome === 'RETRY') summary.retried += 1;
        else if (outcome === 'LOST') summary.lost += 1;
        else summary.failed += 1;
      }
      if (summary.picked > 0) logger.info({ ...summary }, 'notification dispatch run');
      return summary;
    },
  };
}

export type NotificationDispatcher = ReturnType<typeof createNotificationDispatcher>;
