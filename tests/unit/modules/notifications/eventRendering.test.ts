/**
 * TC-060 — every NotificationEvent renders; dedupe; outbox refusal of token-bearing events; no
 * sensitive payment data (TESTING_STRATEGY.md; NOTIFICATION_WORKFLOWS.md §3.1, §4, §9).
 *
 * Table-driven over the generated `NotificationEvent` enum, so an event added without a catalogue
 * spec / default template is detected here. Templates come from the default template rows
 * (`prisma/seed/notification-templates.seed.ts` → `buildNotificationTemplateRows`, pure) and are
 * rendered through the real dispatcher with fake providers. MOCKED DB (tests/helpers/mockDb.ts):
 * no SQL runs, no network.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  buildNotificationTemplateRows,
  type NotificationTemplateSeedRow,
} from '../../../../prisma/seed/notification-templates.seed.js';
import { NotificationEvent } from '../../../../src/generated/prisma/enums.js';
import { FakeEmailProviderAdapter } from '../../../../src/integrations/email/emailProvider.js';
import type {
  SendWhatsAppInput,
  WhatsAppProviderAdapter,
} from '../../../../src/integrations/whatsapp/whatsappProvider.js';
import {
  COD_VARIANT,
  EVENT_SPECS,
  SECRET_VARIABLE,
  implicitVariant,
} from '../../../../src/modules/notifications/notifications.catalog.js';
import { createNotificationDispatcher } from '../../../../src/modules/notifications/notifications.dispatcher.js';
import {
  extractPlaceholders,
  htmlToText,
  renderTemplate,
  unknownPlaceholders,
  type TemplateValue,
} from '../../../../src/modules/notifications/notifications.render.js';
import {
  buildDedupeKey,
  createNotificationService,
} from '../../../../src/modules/notifications/notifications.service.js';
import { parseTemplateMeta } from '../../../../src/modules/notifications/notifications.templates.js';
import { createMockDb } from '../../../helpers/mockDb.js';

const NOW = new Date('2026-11-20T06:30:00.000Z'); // 12:00 IST (outside quiet hours)
const USER = randomUUID();
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const EVENTS = Object.values(NotificationEvent);
const ROWS = buildNotificationTemplateRows();

function templateFor(
  event: NotificationEvent,
  channel: 'EMAIL' | 'WHATSAPP',
): NotificationTemplateSeedRow | undefined {
  return ROWS.find((r) => r.event === event && r.channel === channel);
}

/**
 * NOTIFICATION_WORKFLOWS.md §3.1 "Channels" column: does the design call for a WhatsApp template?
 * VERIFICATION_REQUESTED: "W only for mobile OTP" — mobile OTP is not adopted (OQ-09 link default),
 * so no WhatsApp template is expected. PASSWORD_RESET_REQUESTED / STAFF_INVITED: "E only".
 * LOW_STOCK_ALERT: "E" (no staff WhatsApp in v1, §4.16).
 */
const DOC_WHATSAPP: Readonly<Record<NotificationEvent, boolean>> = {
  USER_REGISTERED: true,
  VERIFICATION_REQUESTED: false,
  PASSWORD_RESET_REQUESTED: false,
  PASSWORD_CHANGED: true,
  ORDER_PLACED: true,
  ORDER_CONFIRMED: true,
  PAYMENT_SUCCEEDED: true,
  PAYMENT_FAILED: true,
  INVOICE_AVAILABLE: true,
  ORDER_PROCESSING: true,
  ORDER_SHIPPED: true,
  ORDER_OUT_FOR_DELIVERY: true,
  ORDER_DELIVERED: true,
  ORDER_CANCELLED: true,
  REFUND_INITIATED: true,
  REFUND_COMPLETED: true,
  LOW_STOCK_ALERT: false,
  STAFF_INVITED: false,
  CANCELLATION_REQUESTED: true,
  CANCELLATION_REJECTED: true,
  REFUND_REJECTED: true,
  SECURITY_ALERT: true,
};

/** Key variables the rendered email (subject + body) must show, per §4 per-event specs. */
const EMAIL_KEY_VARS: Readonly<Record<NotificationEvent, readonly string[]>> = {
  USER_REGISTERED: ['firstName', 'brandName', 'accountUrl'],
  VERIFICATION_REQUESTED: ['brandName', 'verifyUrl', 'expiresInHours'],
  PASSWORD_RESET_REQUESTED: ['brandName', 'resetUrl', 'expiresInMinutes'],
  PASSWORD_CHANGED: ['brandName', 'changedAt', 'accountRecoveryUrl'],
  ORDER_PLACED: ['orderNumber', 'amount', 'paymentMethod', 'orderUrl'],
  ORDER_CONFIRMED: ['orderNumber', 'amount', 'orderUrl'],
  PAYMENT_SUCCEEDED: ['orderNumber', 'amount', 'paymentMethod', 'orderUrl'],
  PAYMENT_FAILED: ['orderNumber', 'retryMinutes', 'orderUrl'],
  INVOICE_AVAILABLE: ['orderNumber', 'invoiceNumber', 'orderUrl'],
  ORDER_PROCESSING: ['orderNumber', 'orderUrl'],
  ORDER_SHIPPED: ['orderNumber', 'shipmentNumber', 'courier', 'awb', 'trackingUrl'],
  ORDER_OUT_FOR_DELIVERY: ['orderNumber', 'orderUrl'],
  ORDER_DELIVERED: ['orderNumber', 'orderUrl'],
  ORDER_CANCELLED: ['orderNumber', 'refundNote', 'orderUrl'],
  REFUND_INITIATED: ['orderNumber', 'refundNumber', 'amount', 'methodLabel', 'businessDays'],
  REFUND_COMPLETED: ['orderNumber', 'amount', 'reference'],
  LOW_STOCK_ALERT: ['count', 'summary', 'inventoryUrl'],
  STAFF_INVITED: ['brandName', 'inviterName', 'acceptUrl', 'expiresInHours'],
  CANCELLATION_REQUESTED: ['orderNumber', 'orderUrl'],
  CANCELLATION_REJECTED: ['orderNumber', 'reason', 'orderUrl'],
  REFUND_REJECTED: ['orderNumber', 'refundNumber', 'reason'],
  SECURITY_ALERT: ['brandName', 'signedInAt', 'device', 'accountRecoveryUrl'],
};

const SAMPLES: Readonly<Record<string, TemplateValue>> = {
  firstName: 'Asha',
  brandName: 'Gehna Test',
  supportEmail: 'help@example.test',
  orderNumber: 'ORD-261120-00042',
  amount: '2,499.00',
  paymentMethod: 'COD',
  shipmentNumber: 'SHP-261120-00007',
  courier: 'Delhivery',
  awb: 'AWB77001234',
  expectedDelivery: '24 Nov 2026',
  refundNumber: 'RFD-261120-00003',
  methodLabel: 'original payment method',
  reference: 'UTR4455AB',
  reason: 'Already being prepared',
  businessDays: 7,
  invoiceNumber: 'INV/2627/000123',
  retryMinutes: 60,
  holdUntil: '20 Nov 2026 13:30 IST',
  expectedDispatch: '22 Nov 2026',
  deliveredAt: '25 Nov 2026',
  refundNote: 'Any amount paid will be refunded to your original payment method.',
  codAmount: '1,299.00',
  changedAt: '20 Nov 2026 12:00 IST',
  signedInAt: '20 Nov 2026 12:05 IST',
  device: 'Chrome on Windows',
  city: 'Jaipur',
  count: 3,
  summary: 'SKU-RING-7 has 2 left',
  inviterName: 'Ravi Admin',
  expiresInHours: 72,
  expiresInMinutes: 30,
};

function sampleValue(name: string): TemplateValue {
  const known = SAMPLES[name];
  if (known !== undefined) return known;
  if (/url$/i.test(name)) return `https://shop.example.test/${name.toLowerCase()}`;
  return `${name}-sample`;
}

function sampleVariables(event: NotificationEvent): Record<string, TemplateValue> {
  return Object.fromEntries(EVENT_SPECS[event].variables.map((n) => [n, sampleValue(n)]));
}

/**
 * Sensitive payment / credential data (NOTIFICATION_WORKFLOWS.md §9 "Never include"). Passed to
 * the renderer alongside the legitimate variables: none of these values may surface in output.
 */
const POISON: Readonly<Record<string, string>> = {
  cardNumber: '4111111111111111',
  cvv: 'CVV-737-X',
  cardExpiry: 'EXP-12/29-X',
  vpa: 'asha.secret@okbank',
  upiId: 'asha.upi@okaxis',
  razorpayPaymentId: 'pay_SECRETPAYID123',
  razorpaySignature: 'sig_SECRETSIGNATURE',
  accessToken: 'eyJSECRETACCESSTOKEN',
  refreshToken: 'rt_SECRETREFRESHTOKEN',
  password: 'Hunter2!SecretPw',
  otp: 'OTP-918273',
  bankAccountNumber: '001122334455667',
};
const POISON_VALUES = Object.values(POISON);
/** Card-number-like digit runs (13–19 digits, optional space/hyphen separators). */
const PAN_LIKE = /\b(?:\d[ -]?){13,19}\b/;

function expectNoSensitive(output: string): void {
  for (const secret of POISON_VALUES) expect(output).not.toContain(secret);
  expect(output).not.toMatch(PAN_LIKE);
  expect(output).not.toMatch(/\bcvv\b/i);
}

/** Every template string (base + variants) of the event's email template. */
function emailTemplateStrings(row: NotificationTemplateSeedRow): string[] {
  const meta = parseTemplateMeta(row.event, row.variables);
  const out = [row.subject ?? '', row.body ?? ''];
  for (const v of Object.values(meta.variants)) out.push(v.subject ?? '', v.body ?? '');
  return out.filter((s) => s !== '');
}

function dispatchRow(
  event: NotificationEvent,
  channel: 'EMAIL' | 'WHATSAPP',
  variables: Record<string, TemplateValue>,
  variant?: string,
) {
  return {
    id: randomUUID(),
    event,
    channel,
    recipientUserId: USER,
    recipientAddress: channel === 'EMAIL' ? 'asha@example.test' : '+919812345678',
    templateId: null,
    entityType: 'ORDER',
    entityId: randomUUID(),
    dedupeKey: 'k',
    payload: {
      v: 1,
      locale: 'en-IN',
      category: EVENT_SPECS[event].category,
      ...(variant === undefined ? {} : { variant }),
      variables,
    },
    status: 'QUEUED',
    attemptCount: 0,
    nextAttemptAt: null,
    providerMessageId: null,
    resendOfId: null,
    triggeredById: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Runs one row through the real dispatcher with fake providers; returns what was sent. */
async function dispatchOnce(
  template: NotificationTemplateSeedRow,
  row: ReturnType<typeof dispatchRow>,
) {
  const { db, m } = createMockDb();
  m.notification.findMany.mockResolvedValue([row]);
  m.notification.updateMany.mockResolvedValue({ count: 1 });
  m.notification.findUnique.mockResolvedValue(null);
  m.setting.findMany.mockResolvedValue([
    { settingKey: 'store.name', value: SAMPLES.brandName },
    { settingKey: 'store.support_email', value: SAMPLES.supportEmail },
    { settingKey: 'notifications.whatsapp_enabled', value: true },
  ]);
  const category = EVENT_SPECS[row.event].category;
  m.notificationPreference.findMany.mockResolvedValue([
    { channel: 'EMAIL', category, isOptedIn: true },
    { channel: 'WHATSAPP', category, isOptedIn: true },
  ]);
  m.notificationTemplate.findFirst.mockResolvedValue({
    ...template,
    id: randomUUID(),
    // Seed WhatsApp rows are DRAFT (skipped at send time, OQ-08); approve to exercise rendering.
    whatsappApprovalStatus: template.channel === 'WHATSAPP' ? 'APPROVED' : null,
    version: 1,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const email = new FakeEmailProviderAdapter();
  const waSent: SendWhatsAppInput[] = [];
  const whatsapp: WhatsAppProviderAdapter = {
    name: 'spy',
    send: (input) => {
      waSent.push(input);
      return Promise.resolve({ provider: 'spy', messageId: 'wa_1', accepted: true });
    },
  };
  const dispatcher = createNotificationDispatcher({
    db,
    logger: silent,
    clock: () => NOW,
    email,
    whatsapp,
    notifications: createNotificationService({ clock: () => NOW }),
    random: () => 0.5,
  });
  const summary = await dispatcher.dispatchPending(10);
  return { summary, email: email.outbox[0], whatsapp: waSent[0] };
}

describe('TC-060 catalogue coverage', () => {
  it('every NotificationEvent enum value has a catalogue spec (and no extra specs exist)', () => {
    expect(Object.keys(EVENT_SPECS).sort()).toEqual([...EVENTS].sort());
    expect(EVENTS).toHaveLength(22);
  });

  it('default template rows only reference enum events and are unique per (event, channel)', () => {
    const keys = ROWS.map((r) => `${r.event}|${r.channel}|${r.locale}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ROWS) expect(EVENTS).toContain(r.event);
  });
});

describe.each(EVENTS)('TC-060 %s', (event) => {
  const emailTpl = templateFor(event, 'EMAIL');
  const waTpl = templateFor(event, 'WHATSAPP');

  it('has an implemented email template with a subject and body', () => {
    expect(emailTpl).toBeDefined();
    expect(emailTpl?.subject).toBeTruthy();
    expect(emailTpl?.body).toBeTruthy();
  });

  it(`WhatsApp template presence matches NOTIFICATION_WORKFLOWS §3.1 (expected: ${String(DOC_WHATSAPP[event])})`, () => {
    expect(waTpl !== undefined).toBe(DOC_WHATSAPP[event]);
    if (waTpl !== undefined) {
      expect(waTpl.whatsappTemplateName).toBe(`${event.toLowerCase()}_v1`);
      expect(waTpl.subject).toBeNull();
      expect(waTpl.body).toBeNull();
    }
  });

  it('templates only reference allow-listed variables (EVENT_SPECS)', () => {
    if (emailTpl === undefined) throw new Error('no email template');
    const allowed = EVENT_SPECS[event].variables;
    for (const tpl of emailTemplateStrings(emailTpl)) {
      expect(unknownPlaceholders(tpl, allowed)).toEqual([]);
    }
    if (waTpl !== undefined) {
      const order = parseTemplateMeta(event, waTpl.variables).order;
      expect(order.length).toBeGreaterThan(0);
      for (const name of order) expect(allowed).toContain(name);
    }
  });

  it('renders the email through the dispatcher with every key variable and no leftovers', async () => {
    if (emailTpl === undefined) throw new Error('no email template');
    const variables = sampleVariables(event);
    const { summary, email } = await dispatchOnce(emailTpl, dispatchRow(event, 'EMAIL', variables));
    expect(summary).toMatchObject({ picked: 1, sent: 1 });
    if (email === undefined) throw new Error('no email captured');
    expect(email.to).toBe('asha@example.test');
    expect(email.templateKey).toBe(event.toLowerCase());
    const html = email.html ?? '';
    const visible = `${email.subject}\n${email.text ?? ''}`;
    for (const name of EMAIL_KEY_VARS[event]) {
      const value = String(sampleValue(name));
      if (/url$/i.test(name)) expect(html).toContain(`href="${value}"`);
      else expect(visible).toContain(value);
    }
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(`${email.subject}${html}`).not.toContain('{{');
    // Every placeholder used by the base template actually rendered a value.
    for (const name of extractPlaceholders(`${emailTpl.subject ?? ''}${emailTpl.body ?? ''}`)) {
      const rendered = renderTemplate(`{{${name}}}`, variables, 'html');
      expect(rendered, name).not.toBe('');
    }
  });

  it('never renders sensitive payment / credential data (email, all variants)', async () => {
    if (emailTpl === undefined) throw new Error('no email template');
    const variables = { ...sampleVariables(event), ...POISON };
    const meta = parseTemplateMeta(event, emailTpl.variables);
    for (const variant of [undefined, ...Object.keys(meta.variants)]) {
      const { email } = await dispatchOnce(
        emailTpl,
        dispatchRow(event, 'EMAIL', variables, variant),
      );
      if (email === undefined) throw new Error(`no email captured (${String(variant)})`);
      if (variant !== undefined) {
        expect(email.templateKey).toBe(`${event.toLowerCase()}:${variant.toLowerCase()}`);
      }
      expectNoSensitive(`${email.subject}\n${email.html ?? ''}\n${email.text ?? ''}`);
      expect(email.html ?? '').not.toContain('{{');
    }
    // No template placeholder is itself a payment-secret name.
    for (const tpl of emailTemplateStrings(emailTpl)) {
      for (const name of extractPlaceholders(tpl)) {
        expect(name).not.toMatch(/card|cvv|vpa|upi|signature|token|account_?number|^otp$/i);
      }
    }
  });

  if (DOC_WHATSAPP[event]) {
    it('renders WhatsApp parameters in template order without sensitive data', async () => {
      if (waTpl === undefined) throw new Error('no WhatsApp template');
      const variables = { ...sampleVariables(event), ...POISON };
      const { summary, whatsapp } = await dispatchOnce(
        waTpl,
        dispatchRow(event, 'WHATSAPP', variables),
      );
      expect(summary).toMatchObject({ sent: 1 });
      if (whatsapp === undefined) throw new Error('no WhatsApp captured');
      expect(whatsapp.templateKey).toBe(`${event.toLowerCase()}_v1`);
      const order = parseTemplateMeta(event, waTpl.variables).order;
      expect(whatsapp.variables).toEqual(
        Object.fromEntries(order.map((n, i) => [String(i + 1), String(sampleValue(n))])),
      );
      expectNoSensitive(JSON.stringify(whatsapp.variables));
    });
  }
});

describe('TC-060 DF-03 ORDER_OUT_FOR_DELIVERY COD variant (NOTIFICATION_WORKFLOWS §4.11)', () => {
  const ofdEmail = templateFor('ORDER_OUT_FOR_DELIVERY', 'EMAIL');
  const ofdWa = templateFor('ORDER_OUT_FOR_DELIVERY', 'WHATSAPP');
  const prepaidVars = (): Record<string, TemplateValue> =>
    Object.fromEntries(
      Object.entries(sampleVariables('ORDER_OUT_FOR_DELIVERY')).filter(([k]) => k !== 'codAmount'),
    );

  it('ORDER_OUT_FOR_DELIVERY allows codAmount and only the COD variant uses it', () => {
    if (ofdEmail === undefined || ofdWa === undefined) throw new Error('missing OFD templates');
    expect(EVENT_SPECS.ORDER_OUT_FOR_DELIVERY.variables).toContain('codAmount');
    const emailMeta = parseTemplateMeta('ORDER_OUT_FOR_DELIVERY', ofdEmail.variables);
    const waMeta = parseTemplateMeta('ORDER_OUT_FOR_DELIVERY', ofdWa.variables);
    // Base (prepaid) templates never mention an amount to pay.
    expect(extractPlaceholders(`${ofdEmail.subject ?? ''}${ofdEmail.body ?? ''}`)).not.toContain(
      'codAmount',
    );
    expect(waMeta.order).not.toContain('codAmount');
    // COD variant: email body + WhatsApp `order_out_for_delivery_cod_v1` with {{3}} = codAmount.
    expect(extractPlaceholders(emailMeta.variants[COD_VARIANT]?.body ?? '')).toContain('codAmount');
    expect(emailMeta.variants[COD_VARIANT]?.body).toContain('Amount to pay: ₹{{codAmount}}');
    expect(waMeta.variants[COD_VARIANT]).toEqual({
      whatsappTemplateName: 'order_out_for_delivery_cod_v1',
      order: ['firstName', 'orderNumber', 'codAmount'],
    });
    expect(ofdWa.whatsappApprovalStatus).toBe('DRAFT');
  });

  it('ORDER_OUT_FOR_DELIVERY — COD variant `order_out_for_delivery_cod_v1` ("Amount to pay: ₹{{3}}", §4.11) renders the amount (email + WhatsApp)', async () => {
    if (ofdEmail === undefined || ofdWa === undefined) throw new Error('missing OFD templates');
    const variables = { ...sampleVariables('ORDER_OUT_FOR_DELIVERY'), ...POISON };
    const mail = await dispatchOnce(
      ofdEmail,
      dispatchRow('ORDER_OUT_FOR_DELIVERY', 'EMAIL', variables, COD_VARIANT),
    );
    if (mail.email === undefined) throw new Error('no email captured');
    expect(mail.email.templateKey).toBe('order_out_for_delivery:cod');
    expect(mail.email.text).toContain('Amount to pay: ₹1,299.00');
    expect(mail.email.text).toContain('ORD-261120-00042');
    expectNoSensitive(`${mail.email.subject}\n${mail.email.html ?? ''}\n${mail.email.text ?? ''}`);

    const wa = await dispatchOnce(
      ofdWa,
      dispatchRow('ORDER_OUT_FOR_DELIVERY', 'WHATSAPP', variables, COD_VARIANT),
    );
    if (wa.whatsapp === undefined) throw new Error('no WhatsApp captured');
    expect(wa.whatsapp.templateKey).toBe('order_out_for_delivery_cod_v1');
    expect(wa.whatsapp.variables).toEqual({ 1: 'Asha', 2: 'ORD-261120-00042', 3: '1,299.00' });
    expectNoSensitive(JSON.stringify(wa.whatsapp.variables));
  });

  it('prepaid out-for-delivery keeps the existing message (no amount to pay)', async () => {
    if (ofdEmail === undefined || ofdWa === undefined) throw new Error('missing OFD templates');
    const mail = await dispatchOnce(
      ofdEmail,
      dispatchRow('ORDER_OUT_FOR_DELIVERY', 'EMAIL', prepaidVars()),
    );
    if (mail.email === undefined) throw new Error('no email captured');
    expect(mail.email.templateKey).toBe('order_out_for_delivery');
    expect(mail.email.text).toContain('is out for delivery today');
    expect(mail.email.text).not.toContain('Amount to pay');
    expect(mail.email.html).not.toContain('₹');

    const wa = await dispatchOnce(
      ofdWa,
      dispatchRow('ORDER_OUT_FOR_DELIVERY', 'WHATSAPP', prepaidVars()),
    );
    if (wa.whatsapp === undefined) throw new Error('no WhatsApp captured');
    expect(wa.whatsapp.templateKey).toBe('order_out_for_delivery_v1');
    expect(wa.whatsapp.variables).toEqual({ 1: 'Asha', 2: 'ORD-261120-00042' });
  });

  it('enqueue selects the COD variant only when codAmount is present (prepaid stays on the base)', async () => {
    expect(implicitVariant('ORDER_OUT_FOR_DELIVERY', { codAmount: '2499.00' })).toBe(COD_VARIANT);
    expect(implicitVariant('ORDER_OUT_FOR_DELIVERY', {})).toBeUndefined();
    expect(implicitVariant('ORDER_OUT_FOR_DELIVERY', { codAmount: '' })).toBeUndefined();
    expect(implicitVariant('ORDER_SHIPPED', { codAmount: '2499.00' })).toBeUndefined();

    const enqueueOfd = async (variables: Record<string, TemplateValue>) => {
      const { db, m } = createMockDb();
      m.notification.findUnique.mockResolvedValue(null);
      const service = createNotificationService({ clock: () => NOW });
      await service.enqueue(db, {
        event: 'ORDER_OUT_FOR_DELIVERY',
        channels: ['EMAIL', 'WHATSAPP'],
        recipientUserId: USER,
        to: { email: 'asha@example.test', phone: '+919812345678' },
        entityType: 'ORDER',
        entityId: randomUUID(),
        variables,
      });
      return m.notification.create.mock.calls.map(
        (c) => (c[0] as { data: { payload: Record<string, unknown> } }).data.payload,
      );
    };
    const cod = await enqueueOfd(sampleVariables('ORDER_OUT_FOR_DELIVERY'));
    expect(cod).toHaveLength(2);
    for (const payload of cod) {
      expect(payload.variant).toBe(COD_VARIANT);
      expect(payload.variables).toMatchObject({ codAmount: '1,299.00' });
    }
    const prepaid = await enqueueOfd(prepaidVars());
    expect(prepaid).toHaveLength(2);
    for (const payload of prepaid) {
      expect(payload).not.toHaveProperty('variant');
      expect(payload.variables).not.toHaveProperty('codAmount');
    }
  });
});

describe('TC-060 outbox: token-bearing events and the secret-variable guard', () => {
  const TOKEN_EVENTS = EVENTS.filter((e) => EVENT_SPECS[e].tokenBearing);
  const OUTBOX_EVENTS = EVENTS.filter((e) => !EVENT_SPECS[e].tokenBearing);

  it('token-bearing events are exactly verification, password reset and staff invite', () => {
    expect([...TOKEN_EVENTS].sort()).toEqual(
      ['PASSWORD_RESET_REQUESTED', 'STAFF_INVITED', 'VERIFICATION_REQUESTED'].sort(),
    );
  });

  it.each(TOKEN_EVENTS)('%s is refused by enqueue (never rests in the outbox)', async (event) => {
    const { db, m } = createMockDb();
    const service = createNotificationService({ clock: () => NOW });
    await expect(
      service.enqueue(db, {
        event,
        channels: ['EMAIL'],
        recipientUserId: USER,
        to: { email: 'asha@example.test' },
        variables: { firstName: 'Asha' },
      }),
    ).rejects.toThrow(/not sent through the outbox/);
    expect(m.notification.create).not.toHaveBeenCalled();
  });

  it.each(Object.keys(POISON).filter((name) => SECRET_VARIABLE.test(name)))(
    'enqueue refuses secret-looking variable "%s"',
    async (name) => {
      const { db, m } = createMockDb();
      const service = createNotificationService({ clock: () => NOW });
      await expect(
        service.enqueue(db, {
          event: 'ORDER_CONFIRMED',
          channels: ['EMAIL'],
          recipientUserId: USER,
          to: { email: 'asha@example.test' },
          variables: { ...sampleVariables('ORDER_CONFIRMED'), [name]: POISON[name] ?? 'x' },
        }),
      ).rejects.toThrow(/looks secret/);
      expect(m.notification.create).not.toHaveBeenCalled();
    },
  );

  it('SECRET_VARIABLE guard matches `upiId` and gateway payment ids (`razorpayPaymentId`) — §9 never-include (DF-02)', () => {
    expect(SECRET_VARIABLE.test('upiId')).toBe(true);
    expect(SECRET_VARIABLE.test('razorpayPaymentId')).toBe(true);
  });

  /** §9 "Never include" names (and close variants) the guard must refuse. */
  const FORBIDDEN_NAMES = [
    ...Object.keys(POISON),
    'upi',
    'upiVpa',
    'customerUpi',
    'vpa',
    'paymentId',
    'payment_id',
    'gatewayPaymentId',
    'providerPaymentId',
    'razorpayOrderId',
    'razorpay_payment_id',
    'gatewayReference',
    'password',
    'newPassword',
    'resetToken',
    'otpCode',
    'cardLast4',
    'bank_account_number',
    'apiSecret',
  ];

  it.each(FORBIDDEN_NAMES)('DF-02 guard refuses forbidden variable name "%s"', (name) => {
    expect(SECRET_VARIABLE.test(name)).toBe(true);
  });

  it('DF-02 guard never blocks a variable allowed by any EVENT_SPECS entry', () => {
    const blocked = EVENTS.flatMap((e) =>
      EVENT_SPECS[e].variables.filter((n) => SECRET_VARIABLE.test(n)).map((n) => `${e}.${n}`),
    );
    expect(blocked).toEqual([]);
    for (const legit of ['paymentMethod', 'orderNumber', 'amount', 'codAmount', 'reference']) {
      expect(SECRET_VARIABLE.test(legit)).toBe(false);
    }
  });

  it.each(['upiId', 'razorpayPaymentId', 'paymentId', 'gatewayReference'])(
    'DF-02 enqueue refuses "%s" and queues nothing',
    async (name) => {
      const { db, m } = createMockDb();
      const service = createNotificationService({ clock: () => NOW });
      await expect(
        service.enqueue(db, {
          event: 'PAYMENT_SUCCEEDED',
          channels: ['EMAIL', 'WHATSAPP'],
          recipientUserId: USER,
          to: { email: 'asha@example.test', phone: '+919812345678' },
          variables: { ...sampleVariables('PAYMENT_SUCCEEDED'), [name]: 'x' },
        }),
      ).rejects.toThrow(/looks secret/);
      expect(m.notification.create).not.toHaveBeenCalled();
    },
  );

  /** Events whose own template variables trip the secret guard (none since DF-01). */
  const KNOWN_SELF_BLOCKED: readonly NotificationEvent[] = [];
  const selfBlocked = OUTBOX_EVENTS.filter((e) =>
    EVENT_SPECS[e].variables.some((n) => SECRET_VARIABLE.test(n)),
  );

  it('no new outbox event has allow-listed variables that the secret guard refuses', () => {
    for (const e of selfBlocked) expect(KNOWN_SELF_BLOCKED).toContain(e);
  });
  it('PASSWORD_CHANGED / SECURITY_ALERT — the recovery link `accountRecoveryUrl` is not refused by SECRET_VARIABLE (DF-01)', () => {
    expect(selfBlocked).toEqual([]);
    for (const e of ['PASSWORD_CHANGED', 'SECURITY_ALERT'] as const) {
      expect(EVENT_SPECS[e].variables).toContain('accountRecoveryUrl');
      expect(EVENT_SPECS[e].variables).not.toContain('forgotPasswordUrl');
      expect(EVENT_SPECS[e].variables.filter((n) => SECRET_VARIABLE.test(n))).toEqual([]);
    }
    // The old name stays blocked by the guard; no default template uses it any more.
    expect(SECRET_VARIABLE.test('forgotPasswordUrl')).toBe(true);
    for (const row of ROWS) expect(JSON.stringify(row)).not.toContain('forgotPasswordUrl');
  });

  it.each(['PASSWORD_CHANGED', 'SECURITY_ALERT'] as const)(
    'DF-01 %s enqueues with the token-free account-recovery link and renders it',
    async (event) => {
      const { db, m } = createMockDb();
      m.notification.findUnique.mockResolvedValue(null);
      const service = createNotificationService({ clock: () => NOW });
      const link = 'https://shop.example.test/forgot-password';
      const variables = { ...sampleVariables(event), accountRecoveryUrl: link };
      const out = await service.enqueue(db, {
        event,
        channels: ['EMAIL'],
        recipientUserId: USER,
        to: { email: 'asha@example.test' },
        entityType: 'USER',
        entityId: USER,
        variables,
      });
      expect(out).toEqual([expect.objectContaining({ channel: 'EMAIL', created: true })]);
      const data = (m.notification.create.mock.calls[0]?.[0] as { data: Record<string, unknown> })
        .data;
      const payload = data.payload as { variables: Record<string, unknown> };
      expect(payload.variables.accountRecoveryUrl).toBe(link);
      expect(link).not.toMatch(/[?&#]|token/i); // public page, no token in the link (§4.20)

      const tpl = templateFor(event, 'EMAIL');
      if (tpl === undefined) throw new Error('no email template');
      const { email } = await dispatchOnce(tpl, dispatchRow(event, 'EMAIL', variables));
      expect(email?.html).toContain(`href="${link}"`);
    },
  );

  it.each(OUTBOX_EVENTS.filter((e) => !selfBlocked.includes(e)))(
    '%s enqueues one row per channel with variables-only payload and a stable dedupe key',
    async (event) => {
      const { db, m } = createMockDb();
      m.notification.findUnique.mockResolvedValue(null);
      const service = createNotificationService({ clock: () => NOW });
      const input = {
        event,
        channels: ['EMAIL', 'WHATSAPP'] as const,
        recipientUserId: USER,
        to: { email: 'asha@example.test', phone: '+919812345678' },
        entityType: 'ORDER',
        entityId: randomUUID(),
        variables: sampleVariables(event),
      };
      const out = await service.enqueue(db, { ...input, channels: [...input.channels] });
      expect(out.map((o) => [o.channel, o.created])).toEqual([
        ['EMAIL', true],
        ['WHATSAPP', true],
      ]);
      const creates = m.notification.create.mock.calls.map(
        (c) => (c[0] as { data: Record<string, unknown> }).data,
      );
      expect(creates).toHaveLength(2);
      for (const data of creates) {
        const payload = data.payload as { variables: Record<string, unknown> };
        expect(payload.variables).toEqual(input.variables);
        for (const key of Object.keys(payload.variables)) expect(key).not.toMatch(SECRET_VARIABLE);
        expect(data.dedupeKey).toBe(
          buildDedupeKey({
            event,
            entityType: input.entityType,
            entityId: input.entityId,
            channel: data.channel as 'EMAIL' | 'WHATSAPP',
            recipient: USER,
          }),
        );
      }

      // Dedupe: an identical enqueue finds the existing row and creates nothing.
      m.notification.findUnique.mockResolvedValue({ id: 'existing', status: 'QUEUED' });
      const again = await service.enqueue(db, { ...input, channels: [...input.channels] });
      expect(again.every((o) => !o.created && o.id === 'existing')).toBe(true);
      expect(m.notification.create).toHaveBeenCalledTimes(2);
    },
  );

  it('dedupe keys are distinct for every (event, channel) pair on the same entity', () => {
    const entityId = randomUUID();
    const keys = EVENTS.flatMap((event) =>
      (['EMAIL', 'WHATSAPP'] as const).map((channel) =>
        buildDedupeKey({ event, entityType: 'ORDER', entityId, channel, recipient: USER }),
      ),
    );
    expect(new Set(keys).size).toBe(EVENTS.length * 2);
  });
});

describe('TC-060 plain-text alternative', () => {
  it.each(EVENTS)('%s email text part is derived from the HTML without tags', (event) => {
    const tpl = templateFor(event, 'EMAIL');
    if (tpl === undefined) throw new Error('no email template');
    const html = renderTemplate(tpl.body ?? '', sampleVariables(event), 'html');
    const text = htmlToText(html);
    expect(text).not.toMatch(/<[a-z/][^>]*>/i);
    expect(text).toContain(String(SAMPLES.supportEmail));
  });
});
