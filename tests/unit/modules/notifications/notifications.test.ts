/**
 * Notifications — rendering, consent, retry schedule, outbox enqueue and dispatcher.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies logic and the Prisma calls made; no SQL runs.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  FakeEmailProviderAdapter,
  type EmailProviderAdapter,
} from '../../../../src/integrations/email/emailProvider.js';
import { MockWhatsAppProviderAdapter } from '../../../../src/integrations/whatsapp/whatsappProvider.js';
import {
  MAX_ATTEMPTS,
  quietHoursDeferral,
  retryDelayMs,
} from '../../../../src/modules/notifications/notifications.catalog.js';
import {
  createNotificationDispatcher,
  NotificationSendError,
} from '../../../../src/modules/notifications/notifications.dispatcher.js';
import { consentDecision } from '../../../../src/modules/notifications/notifications.policy.js';
import {
  escapeHtml,
  htmlToText,
  renderTemplate,
  unknownPlaceholders,
  whatsappParameters,
} from '../../../../src/modules/notifications/notifications.render.js';
import {
  buildDedupeKey,
  createNotificationService,
} from '../../../../src/modules/notifications/notifications.service.js';
import {
  buildNotificationTemplateRows,
  seedNotificationTemplates,
} from '../../../../prisma/seed/notification-templates.seed.js';
import { extractPlaceholders } from '../../../../src/modules/notifications/notifications.render.js';
import { EVENT_SPECS } from '../../../../src/modules/notifications/notifications.catalog.js';
import { createMockDb } from '../../../helpers/mockDb.js';

const NOW = new Date('2026-11-19T06:30:00.000Z'); // 12:00 IST
const USER = randomUUID();
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('template rendering', () => {
  it('HTML-escapes variables in bodies and never emits unsafe URLs', () => {
    const html = renderTemplate(
      '<p>Hi {{firstName}}</p><a href="{{trackingUrl}}">Track</a><a href="{{orderUrl}}">Order</a>',
      {
        firstName: '<script>alert(1)</script>"Riya"',
        trackingUrl: 'javascript:alert(1)',
        orderUrl: 'https://www.example.com/orders/ORD-261119-00001',
      },
      'html',
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;Riya&quot;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<a href="">Track</a>');
    expect(html).toContain('href="https://www.example.com/orders/ORD-261119-00001"');
  });

  it('keeps subjects single-line (header injection guard) and renders missing vars empty', () => {
    expect(
      renderTemplate('Order {{orderNumber}}{{nope}}', { orderNumber: 'A\r\nBcc: x' }, 'subject'),
    ).toBe('Order A Bcc: x');
  });

  it('lists placeholders and flags unknown ones', () => {
    expect(extractPlaceholders('{{a}} {{ b }} {{a}} {{1}}')).toEqual(['a', 'b', '1']);
    expect(unknownPlaceholders('{{firstName}} {{password}}', ['firstName'])).toEqual(['password']);
  });

  it('builds plain text and positional WhatsApp parameters', () => {
    expect(htmlToText('<p>Hi &amp; welcome</p><p>Line<br>two</p>')).toBe('Hi & welcome\nLine\ntwo');
    expect(
      whatsappParameters(['firstName', 'orderNumber'], { firstName: 'Riya', orderNumber: 7 }),
    ).toEqual({
      '1': 'Riya',
      '2': '7',
    });
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

describe('consent policy', () => {
  it('always allows transactional email and needs opt-in for WhatsApp and marketing', () => {
    expect(consentDecision('EMAIL', 'TRANSACTIONAL', [])).toBe('ALLOW');
    expect(consentDecision('WHATSAPP', 'TRANSACTIONAL', [])).toBe('NO_CONSENT');
    expect(
      consentDecision('WHATSAPP', 'TRANSACTIONAL', [
        { channel: 'WHATSAPP', category: 'TRANSACTIONAL', isOptedIn: false },
      ]),
    ).toBe('OPTED_OUT');
    expect(
      consentDecision('EMAIL', 'MARKETING', [
        { channel: 'EMAIL', category: 'MARKETING', isOptedIn: true },
      ]),
    ).toBe('ALLOW');
    expect(consentDecision('EMAIL', 'STAFF_ALERTS', [])).toBe('NO_CONSENT');
    expect(
      consentDecision('WHATSAPP', 'STAFF_ALERTS', [
        { channel: 'WHATSAPP', category: 'STAFF_ALERTS', isOptedIn: true },
      ]),
    ).toBe('NO_CONSENT');
  });
});

describe('retry schedule & quiet hours', () => {
  it('backs off 1 min, 5 min, 30 min, 2 h with ±10 % jitter', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, mid))).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000,
    ]);
    expect(retryDelayMs(1, () => 0)).toBe(54_000);
    expect(retryDelayMs(1, () => 0.999_999)).toBeLessThanOrEqual(66_000);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it('defers to the next 09:00 IST only inside 21:00–09:00 IST', () => {
    expect(quietHoursDeferral(NOW)).toBeUndefined();
    // 22:30 IST on 19 Nov → 09:00 IST on 20 Nov (03:30Z).
    expect(quietHoursDeferral(new Date('2026-11-19T17:00:00.000Z'))?.toISOString()).toBe(
      '2026-11-20T03:30:00.000Z',
    );
    // 02:00 IST on 20 Nov → 09:00 IST the same day.
    expect(quietHoursDeferral(new Date('2026-11-19T20:30:00.000Z'))?.toISOString()).toBe(
      '2026-11-20T03:30:00.000Z',
    );
  });
});

describe('NotificationService.enqueue (outbox)', () => {
  const base = {
    event: 'ORDER_SHIPPED' as const,
    channels: ['EMAIL', 'WHATSAPP'] as const,
    recipientUserId: USER,
    entityType: 'ORDER',
    entityId: randomUUID(),
    discriminator: 'shp-1',
    variables: { firstName: 'Riya', orderNumber: 'ORD-261119-00001' },
  };

  it('inserts one QUEUED row per channel inside the caller transaction', async () => {
    const { db, m } = createMockDb();
    m.notification.findUnique.mockResolvedValue(null);
    const service = createNotificationService({ clock: () => NOW });
    const out = await service.enqueue(db, {
      ...base,
      channels: [...base.channels],
      to: { email: 'riya@example.com', phone: '+919812345678' },
    });
    expect(out.map((o) => [o.channel, o.status, o.created])).toEqual([
      ['EMAIL', 'QUEUED', true],
      ['WHATSAPP', 'QUEUED', true],
    ]);
    const data = m.notification.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      event: 'ORDER_SHIPPED',
      channel: 'EMAIL',
      recipientAddress: 'riya@example.com',
      status: 'QUEUED',
      nextAttemptAt: null,
      payload: { v: 1, category: 'TRANSACTIONAL', variables: base.variables },
    });
    expect(data.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores SKIPPED (NO_ADDRESS) when the phone is missing and dedupes repeats', async () => {
    const { db, m } = createMockDb();
    m.notification.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const service = createNotificationService({ clock: () => NOW });
    const out = await service.enqueue(db, {
      ...base,
      channels: [...base.channels],
      to: { email: 'riya@example.com', phone: null },
    });
    expect(out[1]).toMatchObject({ channel: 'WHATSAPP', status: 'SKIPPED' });
    expect(m.notificationLog.create.mock.calls[0]?.[0].data).toMatchObject({
      status: 'SKIPPED',
      errorCode: 'NO_ADDRESS',
    });

    m.notification.findUnique.mockResolvedValue({ id: 'existing', status: 'SENT' });
    const again = await service.enqueue(db, {
      ...base,
      channels: ['EMAIL'],
      to: { email: 'riya@example.com' },
    });
    expect(again).toEqual([{ id: 'existing', channel: 'EMAIL', status: 'SENT', created: false }]);
  });

  it('defers WhatsApp quiet-hour events to 09:00 IST', async () => {
    const { db, m } = createMockDb();
    m.notification.findUnique.mockResolvedValue(null);
    const service = createNotificationService({
      clock: () => new Date('2026-11-19T17:00:00.000Z'),
    });
    await service.enqueue(db, {
      ...base,
      channels: ['WHATSAPP'],
      to: { phone: '+919812345678' },
    });
    expect(m.notification.create.mock.calls[0]?.[0].data.nextAttemptAt).toEqual(
      new Date('2026-11-20T03:30:00.000Z'),
    );
  });

  it('refuses secret-looking variables and token-bearing events', async () => {
    const { db } = createMockDb();
    const service = createNotificationService({ clock: () => NOW });
    await expect(
      service.enqueue(db, {
        ...base,
        channels: ['EMAIL'],
        to: { email: 'a@b.co' },
        variables: { resetToken: 'x' },
      }),
    ).rejects.toThrow(/looks secret/);
    await expect(
      service.enqueue(db, {
        ...base,
        event: 'PASSWORD_RESET_REQUESTED',
        channels: ['EMAIL'],
        to: { email: 'a@b.co' },
      }),
    ).rejects.toThrow(/single-use token/);
  });

  it('dedupe keys are deterministic and include the discriminator', () => {
    const parts = { event: 'ORDER_SHIPPED' as const, channel: 'EMAIL' as const, recipient: USER };
    expect(buildDedupeKey(parts)).toBe(buildDedupeKey(parts));
    expect(buildDedupeKey({ ...parts, discriminator: 'a' })).not.toBe(
      buildDedupeKey({ ...parts, discriminator: 'b' }),
    );
  });
});

function notificationRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event: 'ORDER_SHIPPED',
    channel: 'EMAIL',
    recipientUserId: USER,
    recipientAddress: 'riya@example.com',
    templateId: null,
    entityType: 'ORDER',
    entityId: randomUUID(),
    dedupeKey: 'k',
    payload: {
      v: 1,
      locale: 'en-IN',
      category: 'TRANSACTIONAL',
      variables: {
        firstName: '<b>Riya</b>',
        orderNumber: 'ORD-261119-00001',
        trackingUrl: 'javascript:alert(1)',
      },
    },
    status: 'QUEUED',
    attemptCount: 0,
    nextAttemptAt: null,
    providerMessageId: null,
    resendOfId: null,
    triggeredById: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function templateRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event: 'ORDER_SHIPPED',
    channel: 'EMAIL',
    locale: 'en-IN',
    name: 'Shipped',
    subject: 'Shipped {{orderNumber}}',
    body: '<p>Hi {{firstName}}</p><a href="{{trackingUrl}}">Track</a>',
    whatsappTemplateName: null,
    whatsappLanguage: null,
    whatsappApprovalStatus: null,
    variables: {
      allowed: ['firstName', 'orderNumber', 'trackingUrl'],
      order: ['firstName', 'orderNumber'],
    },
    version: 1,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function dispatcherSetup(
  row: ReturnType<typeof notificationRow>,
  options: {
    email?: { name: string; send: ReturnType<typeof vi.fn> } | FakeEmailProviderAdapter;
    whatsapp?: MockWhatsAppProviderAdapter;
    template?: ReturnType<typeof templateRow> | null;
    prefs?: { channel: string; category: string; isOptedIn: boolean }[];
    settings?: { settingKey: string; value: unknown }[];
  } = {},
) {
  const { db, m } = createMockDb();
  m.notification.findMany.mockResolvedValue([row]);
  m.notification.updateMany.mockResolvedValue({ count: 1 });
  m.notification.findUnique.mockResolvedValue(null);
  m.setting.findMany.mockResolvedValue(
    options.settings ?? [{ settingKey: 'store.name', value: 'Gehna' }],
  );
  m.notificationPreference.findMany.mockResolvedValue(options.prefs ?? []);
  m.notificationTemplate.findFirst.mockResolvedValue(
    options.template === undefined ? templateRow() : options.template,
  );
  m.user.findUnique.mockResolvedValue({ email: 'riya@example.com' });
  const email = options.email ?? new FakeEmailProviderAdapter();
  const whatsapp = options.whatsapp ?? new MockWhatsAppProviderAdapter();
  const dispatcher = createNotificationDispatcher({
    db,
    logger: silent,
    clock: () => NOW,
    email: email as EmailProviderAdapter,
    whatsapp,
    notifications: createNotificationService({ clock: () => NOW }),
    random: () => 0.5,
  });
  const lastUpdate = (): unknown => m.notification.update.mock.calls.at(-1)?.[0].data;
  const lastLog = (): unknown => m.notificationLog.create.mock.calls.at(-1)?.[0].data;
  return { m, dispatcher, email, whatsapp, lastUpdate, lastLog };
}

describe('dispatcher', () => {
  it('claims, renders with escaping and sends through the email adapter', async () => {
    const { dispatcher, email, lastUpdate, lastLog, m } = dispatcherSetup(notificationRow());
    const summary = await dispatcher.dispatchPending(10);
    expect(summary).toMatchObject({ picked: 1, sent: 1 });
    expect(m.notification.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'QUEUED' },
      data: { status: 'SENDING', attemptCount: { increment: 1 } },
    });
    const sent = (email as FakeEmailProviderAdapter).outbox[0];
    expect(sent?.subject).toBe('Shipped ORD-261119-00001');
    expect(sent?.html).toContain('&lt;b&gt;Riya&lt;/b&gt;');
    expect(sent?.html).toContain('<a href="">Track</a>');
    expect(sent?.text).toContain('Hi <b>Riya</b>');
    expect(lastUpdate()).toMatchObject({ status: 'SENT', providerMessageId: 'fake_email_1' });
    expect(lastLog()).toMatchObject({ logType: 'SEND_ATTEMPT', status: 'SENT', attemptNo: 1 });
  });

  it('re-queues transient failures with backoff and fails after the 5th attempt', async () => {
    const failing = { name: 'flaky', send: vi.fn().mockRejectedValue(new Error('503')) };
    const first = dispatcherSetup(notificationRow(), { email: failing });
    expect(await first.dispatcher.dispatchPending()).toMatchObject({ retried: 1 });
    expect(first.lastUpdate()).toMatchObject({
      status: 'QUEUED',
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });
    expect(first.lastLog()).toMatchObject({
      status: 'FAILED',
      errorCode: 'PROVIDER_ERROR',
      providerStatus: 'TRANSIENT',
    });

    const last = dispatcherSetup(notificationRow({ attemptCount: 4 }), { email: failing });
    expect(await last.dispatcher.dispatchPending()).toMatchObject({ failed: 1 });
    expect(last.lastUpdate()).toMatchObject({ status: 'FAILED', nextAttemptAt: null });
    expect(last.lastLog()).toMatchObject({ attemptNo: 5, status: 'FAILED' });
  });

  it('does not retry permanent recipient errors', async () => {
    const bounced = {
      name: 'x',
      send: vi
        .fn()
        .mockRejectedValue(new NotificationSendError('PERMANENT_RECIPIENT', 'HARD_BOUNCE')),
    };
    const { dispatcher, lastUpdate, lastLog } = dispatcherSetup(notificationRow(), {
      email: bounced,
    });
    expect(await dispatcher.dispatchPending()).toMatchObject({ failed: 1 });
    expect(lastUpdate()).toMatchObject({ status: 'FAILED' });
    expect(lastLog()).toMatchObject({ errorCode: 'HARD_BOUNCE', attemptNo: 1 });
  });

  it('skips WhatsApp without opt-in, and when opted out (re-checked at send time)', async () => {
    const wa = notificationRow({ channel: 'WHATSAPP', recipientAddress: '+919812345678' });
    const enabled = [{ settingKey: 'notifications.whatsapp_enabled', value: true }];
    const noConsent = dispatcherSetup(wa, { settings: enabled });
    expect(await noConsent.dispatcher.dispatchPending()).toMatchObject({ skipped: 1 });
    expect(noConsent.lastLog()).toMatchObject({ status: 'SKIPPED', errorCode: 'NO_CONSENT' });

    const optedOut = dispatcherSetup(
      notificationRow({ channel: 'WHATSAPP', recipientAddress: '+919812345678' }),
      {
        settings: enabled,
        prefs: [{ channel: 'WHATSAPP', category: 'TRANSACTIONAL', isOptedIn: false }],
      },
    );
    await optedOut.dispatcher.dispatchPending();
    expect(optedOut.lastLog()).toMatchObject({ errorCode: 'OPTED_OUT' });
  });

  it('sends approved WhatsApp templates with positional parameters', async () => {
    const whatsapp = new MockWhatsAppProviderAdapter();
    const spy = vi.spyOn(whatsapp, 'send');
    const { dispatcher } = dispatcherSetup(
      notificationRow({ channel: 'WHATSAPP', recipientAddress: '+919812345678' }),
      {
        whatsapp,
        settings: [{ settingKey: 'notifications.whatsapp_enabled', value: true }],
        prefs: [{ channel: 'WHATSAPP', category: 'TRANSACTIONAL', isOptedIn: true }],
        template: templateRow({
          channel: 'WHATSAPP',
          subject: null,
          body: null,
          whatsappTemplateName: 'order_shipped_v1',
          whatsappApprovalStatus: 'APPROVED',
        }),
      },
    );
    expect(await dispatcher.dispatchPending()).toMatchObject({ sent: 1 });
    expect(spy).toHaveBeenCalledWith({
      to: '+919812345678',
      templateKey: 'order_shipped_v1',
      variables: { '1': '<b>Riya</b>', '2': 'ORD-261119-00001' },
    });
  });

  it('skips WhatsApp when the channel is disabled and falls back to email', async () => {
    const { dispatcher, m } = dispatcherSetup(
      notificationRow({ channel: 'WHATSAPP', recipientAddress: '+919812345678' }),
      { settings: [] },
    );
    expect(await dispatcher.dispatchPending()).toMatchObject({ skipped: 1 });
    const created = m.notification.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      channel: 'EMAIL',
      recipientAddress: 'riya@example.com',
      status: 'QUEUED',
    });
    expect(m.notificationLog.create.mock.calls.some((c) => c[0].data.logType === 'FALLBACK')).toBe(
      true,
    );
  });

  it('skips unapproved WhatsApp templates, missing templates and unconsented marketing', async () => {
    const unapproved = dispatcherSetup(
      notificationRow({ channel: 'WHATSAPP', recipientAddress: '+919812345678' }),
      {
        settings: [{ settingKey: 'notifications.whatsapp_enabled', value: true }],
        prefs: [{ channel: 'WHATSAPP', category: 'TRANSACTIONAL', isOptedIn: true }],
        template: templateRow({
          channel: 'WHATSAPP',
          whatsappTemplateName: 'x_v1',
          whatsappApprovalStatus: 'DRAFT',
        }),
      },
    );
    await unapproved.dispatcher.dispatchPending();
    expect(unapproved.m.notificationLog.create.mock.calls[0]?.[0].data.errorCode).toBe(
      'TEMPLATE_NOT_APPROVED',
    );

    const missing = dispatcherSetup(notificationRow(), { template: null });
    await missing.dispatcher.dispatchPending();
    expect(missing.lastLog()).toMatchObject({ errorCode: 'TEMPLATE_MISSING' });

    const marketing = dispatcherSetup(
      notificationRow({ payload: { v: 1, locale: 'en-IN', category: 'MARKETING', variables: {} } }),
    );
    await marketing.dispatcher.dispatchPending();
    expect(marketing.lastLog()).toMatchObject({ errorCode: 'NO_CONSENT' });
  });

  it('counts rows claimed by a concurrent run as lost and sends nothing', async () => {
    const { dispatcher, m, email } = dispatcherSetup(notificationRow());
    m.notification.updateMany.mockResolvedValue({ count: 0 });
    expect(await dispatcher.dispatchPending()).toMatchObject({ lost: 1, sent: 0 });
    expect((email as FakeEmailProviderAdapter).outbox).toHaveLength(0);
  });
});

describe('notification template seed', () => {
  const rows = buildNotificationTemplateRows();

  it('covers every event by email, unique per (event, channel)', () => {
    const keys = rows.map((r) => `${r.event}:${r.channel}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const event of Object.keys(EVENT_SPECS)) expect(keys).toContain(`${event}:EMAIL`);
  });

  it('only uses allow-listed variables (subjects, bodies, variants, WhatsApp order)', () => {
    for (const row of rows) {
      const allowed = EVENT_SPECS[row.event].variables;
      const meta = row.variables as {
        order: string[];
        variants: Record<string, { subject?: string; body?: string; order?: string[] }>;
      };
      const texts = [
        row.subject ?? '',
        row.body ?? '',
        ...Object.values(meta.variants).flatMap((v) => [v.subject ?? '', v.body ?? '']),
      ];
      for (const text of texts)
        expect(unknownPlaceholders(text, allowed), `${row.event} ${text}`).toEqual([]);
      for (const name of meta.order) expect(allowed).toContain(name);
      // WhatsApp variant parameter orders (e.g. §4.11 COD) are allow-listed too.
      for (const v of Object.values(meta.variants))
        for (const name of v.order ?? []) expect(allowed).toContain(name);
      if (row.channel === 'WHATSAPP') {
        expect(row.whatsappApprovalStatus).toBe('DRAFT');
        expect(row.whatsappTemplateName).toMatch(/^[a-z0-9_]+_v1$/);
      }
    }
  });

  it('upserts without overwriting existing rows', async () => {
    const { db, m } = createMockDb();
    const result = await seedNotificationTemplates(db);
    expect(result.total).toBe(rows.length);
    expect(m.notificationTemplate.upsert).toHaveBeenCalledTimes(rows.length);
    expect(m.notificationTemplate.upsert.mock.calls[0]?.[0].update).toEqual({});
  });
});
