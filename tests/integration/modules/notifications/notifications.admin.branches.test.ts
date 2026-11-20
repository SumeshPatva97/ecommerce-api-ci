/**
 * Notifications admin HTTP — template editing rules per channel (email vs WhatsApp, variants,
 * variable order, version bumps), log filters / DTO mapping, and resend edge cases (replay window,
 * channel switch, missing address, consent, non-transactional payloads).
 * MOCKED DB (tests/helpers/mockDb.ts): no SQL runs; assertions target service logic and contracts.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createNotificationsModule } from '../../../../src/modules/notifications/index.js';
import { maskRecipient } from '../../../../src/modules/notifications/notifications.admin.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ALL = ['notifications.view', 'notifications.update'];

function setup() {
  const t = buildModuleTestApp([createNotificationsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  const staff = t.staff({ permissions: ALL });
  return { t, staff, auth: staff.headers };
}

type T = ReturnType<typeof setup>['t'];

function template(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event: 'ORDER_SHIPPED',
    channel: 'EMAIL',
    locale: 'en-IN',
    name: 'Order shipped (email)',
    subject: 'Your order {{orderNumber}} has shipped',
    body: '<p>Hi {{firstName}}</p>',
    whatsappTemplateName: null,
    whatsappLanguage: null,
    whatsappApprovalStatus: null,
    variables: {
      allowed: ['firstName', 'orderNumber'],
      order: ['firstName'],
      variants: { LATE: { subject: 'Late {{orderNumber}}' } },
    },
    version: 1,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function waTemplate(over: Record<string, unknown> = {}) {
  return template({
    channel: 'WHATSAPP',
    name: 'Order shipped (WhatsApp)',
    subject: null,
    body: 'Hi {{1}}, order {{2}} shipped',
    whatsappTemplateName: 'order_shipped_v1',
    whatsappLanguage: 'en',
    whatsappApprovalStatus: 'APPROVED',
    ...over,
  });
}

function notification(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    event: 'ORDER_SHIPPED',
    channel: 'EMAIL',
    recipientUserId: randomUUID(),
    recipientAddress: 'riya@example.com',
    templateId: null,
    entityType: 'ORDER',
    entityId: randomUUID(),
    dedupeKey: 'k',
    payload: { v: 1, locale: 'en-IN', category: 'TRANSACTIONAL', variables: { firstName: 'Riya' } },
    status: 'FAILED',
    attemptCount: 5,
    nextAttemptAt: null,
    providerMessageId: null,
    resendOfId: null,
    triggeredById: null,
    createdAt: NOW,
    updatedAt: NOW,
    logs: [],
    ...over,
  };
}

/** Template update mock that echoes the written data onto the row. */
function echoUpdate(t: T, row: Record<string, unknown>) {
  t.m.notificationTemplate.update.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data, version: 2 }),
  );
}

describe('notifications admin — templates', () => {
  it('GET templates passes event/channel filters; bad enum → 422', async () => {
    const { t, auth } = setup();
    t.m.notificationTemplate.findMany.mockResolvedValue([waTemplate({ isActive: false })]);
    t.m.notificationTemplate.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get('/api/v1/admin/notifications/templates?event=ORDER_SHIPPED&channel=WHATSAPP')
      .set(auth);
    expect(res.status).toBe(200);
    expect(t.m.notificationTemplate.findMany.mock.calls[0]?.[0].where).toEqual({
      event: 'ORDER_SHIPPED',
      channel: 'WHATSAPP',
    });
    expect(res.body.data[0]).toMatchObject({
      channel: 'WHATSAPP',
      providerTemplateName: 'order_shipped_v1',
      approvalStatus: 'APPROVED',
      status: 'INACTIVE',
      variableOrder: ['firstName'],
    });
    t.m.notificationTemplate.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/notifications/templates').set(auth);
    expect(t.m.notificationTemplate.findMany.mock.calls[0]?.[0].where).toEqual({});
    expect(
      (await request(t.app).get('/api/v1/admin/notifications/templates?channel=FAX').set(auth))
        .status,
    ).toBe(422);
  });

  it('PATCH unknown template → 404; viewer → 403', async () => {
    const { t, auth } = setup();
    t.m.notificationTemplate.findUnique.mockResolvedValue(null);
    const id = randomUUID();
    const res = await request(t.app)
      .patch(`/api/v1/admin/notifications/templates/${id}`)
      .set(auth)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(404);
    const viewer = t.staff({ permissions: ['notifications.view'] }).headers;
    expect(
      (
        await request(t.app)
          .patch(`/api/v1/admin/notifications/templates/${id}`)
          .set(viewer)
          .send({ name: 'Renamed' })
      ).status,
    ).toBe(403);
  });

  it('email templates reject every WhatsApp-only field with NOT_EDITABLE', async () => {
    const { t, auth } = setup();
    const row = template();
    t.m.notificationTemplate.findUnique.mockResolvedValue(row);
    const cases: [string, unknown][] = [
      ['providerTemplateName', 'order_shipped_v2'],
      ['whatsappLanguage', 'en_US'],
      ['approvalStatus', 'APPROVED'],
      ['variableOrder', ['firstName']],
    ];
    for (const [field, value] of cases) {
      const res = await request(t.app)
        .patch(`/api/v1/admin/notifications/templates/${row.id}`)
        .set(auth)
        .send({ [field]: value });
      expect(res.status, field).toBe(422);
      expect(res.body.error.details[0]).toMatchObject({ field, code: 'NOT_EDITABLE' });
    }
    const variant = await request(t.app)
      .patch(`/api/v1/admin/notifications/templates/${row.id}`)
      .set(auth)
      .send({ variants: { LATE: { whatsappTemplateName: 'late_v1' } } });
    expect(variant.status).toBe(422);
    expect(variant.body.error.details[0]).toMatchObject({
      field: 'variants.LATE',
      code: 'NOT_EDITABLE',
    });
    expect(t.m.notificationTemplate.update).not.toHaveBeenCalled();
  });

  it('WhatsApp templates: subject read-only, variant text read-only, unknown variableOrder → 422', async () => {
    const { t, auth } = setup();
    const row = waTemplate();
    t.m.notificationTemplate.findUnique.mockResolvedValue(row);
    const url = `/api/v1/admin/notifications/templates/${row.id}`;
    const subject = await request(t.app).patch(url).set(auth).send({ subject: 'Hi' });
    expect(subject.status).toBe(422);
    expect(subject.body.error.details[0]).toMatchObject({ field: 'subject', code: 'NOT_EDITABLE' });

    const variantText = await request(t.app)
      .patch(url)
      .set(auth)
      .send({ variants: { LATE: { body: 'Late!' } } });
    expect(variantText.status).toBe(422);
    expect(variantText.body.error.details[0].field).toBe('variants.LATE');

    const order = await request(t.app)
      .patch(url)
      .set(auth)
      .send({ variableOrder: ['firstName', 'password', 'otp'] });
    expect(order.status).toBe(422);
    expect(order.body.error.details[0]).toMatchObject({
      field: 'variableOrder',
      code: 'UNKNOWN_VARIABLE',
      meta: { unknown: ['password', 'otp'] },
    });
    expect(t.m.notificationTemplate.update).not.toHaveBeenCalled();
  });

  it('WhatsApp edit writes provider fields + variant mapping and bumps version', async () => {
    const { t, auth } = setup();
    const row = waTemplate();
    t.m.notificationTemplate.findUnique.mockResolvedValue(row);
    echoUpdate(t, row);
    const res = await request(t.app)
      .patch(`/api/v1/admin/notifications/templates/${row.id}`)
      .set(auth)
      .send({
        providerTemplateName: 'order_shipped_v2',
        whatsappLanguage: 'en_US',
        approvalStatus: 'SUBMITTED',
        variableOrder: ['firstName', 'orderNumber', 'trackingUrl'],
        variants: { LATE: { whatsappTemplateName: 'order_late_v1' } },
        status: 'INACTIVE',
      });
    expect(res.status).toBe(200);
    const data = t.m.notificationTemplate.update.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      whatsappTemplateName: 'order_shipped_v2',
      whatsappLanguage: 'en_US',
      whatsappApprovalStatus: 'SUBMITTED',
      isActive: false,
      version: { increment: 1 },
    });
    expect(data.variables.order).toEqual(['firstName', 'orderNumber', 'trackingUrl']);
    expect(data.variables.variants).toEqual({ LATE: { whatsappTemplateName: 'order_late_v1' } });
    expect(data.variables.allowed).toContain('trackingUrl');
    expect(res.body.data).toMatchObject({
      providerTemplateName: 'order_shipped_v2',
      status: 'INACTIVE',
      variableOrder: ['firstName', 'orderNumber', 'trackingUrl'],
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'UPDATE',
      entityType: 'NotificationTemplate',
    });
  });

  it('email variants: unknown placeholders flagged per field; valid variant body sanitised', async () => {
    const { t, auth } = setup();
    const row = template();
    t.m.notificationTemplate.findUnique.mockResolvedValue(row);
    const url = `/api/v1/admin/notifications/templates/${row.id}`;
    const bad = await request(t.app)
      .patch(url)
      .set(auth)
      .send({
        bodyTemplate: '<p>{{secretToken}}</p>',
        variants: { LATE: { subject: '{{orderNumber}} {{cardNumber}}', body: '<p>ok</p>' } },
      });
    expect(bad.status).toBe(422);
    expect(
      (bad.body.error.details as { field: string; code: string }[]).map((d) => [d.field, d.code]),
    ).toEqual([
      ['bodyTemplate', 'UNKNOWN_VARIABLE'],
      ['variants.LATE.subject', 'UNKNOWN_VARIABLE'],
    ]);

    echoUpdate(t, row);
    const ok = await request(t.app)
      .patch(url)
      .set(auth)
      .send({
        subject: 'Shipped: {{orderNumber}}',
        variants: {
          LATE: {
            subject: 'Late {{orderNumber}}',
            body: '<p onclick="x()">Sorry {{firstName}}</p>',
          },
          EARLY: { body: '<p>Early</p>' },
        },
      });
    expect(ok.status).toBe(200);
    const data = t.m.notificationTemplate.update.mock.calls[0]?.[0].data;
    expect(data.subject).toBe('Shipped: {{orderNumber}}');
    expect(data.variables.variants).toEqual({
      LATE: { subject: 'Late {{orderNumber}}', body: '<p>Sorry {{firstName}}</p>' },
      EARLY: { body: '<p>Early</p>' },
    });
    expect(data.variables.order).toEqual(['firstName']); // kept from stored meta
    expect(data.version).toEqual({ increment: 1 });
  });

  it('name/status-only edits keep stored meta and do not bump the version', async () => {
    const { t, auth } = setup();
    const row = template();
    t.m.notificationTemplate.findUnique.mockResolvedValue(row);
    echoUpdate(t, row);
    const res = await request(t.app)
      .patch(`/api/v1/admin/notifications/templates/${row.id}`)
      .set(auth)
      .send({ name: 'Shipped email', status: 'ACTIVE' });
    expect(res.status).toBe(200);
    const data = t.m.notificationTemplate.update.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty('version');
    expect(data).toMatchObject({ name: 'Shipped email', isActive: true });
    expect(data.variables.variants).toEqual({ LATE: { subject: 'Late {{orderNumber}}' } });
    expect(data.variables.order).toEqual(['firstName']);
  });
});

describe('notifications admin — logs', () => {
  it('builds filters from event/channel/recipient/orderNumber/date range', async () => {
    const { t, auth } = setup();
    const orderId = randomUUID();
    t.m.order.findUnique.mockResolvedValue({ id: orderId });
    t.m.notification.findMany.mockResolvedValue([]);
    t.m.notification.count.mockResolvedValue(0);
    const res = await request(t.app)
      .get(
        '/api/v1/admin/notifications/logs?event=ORDER_SHIPPED&channel=WHATSAPP&recipient=9812&orderNumber=ord-261119-00001&from=2026-11-01&to=2026-11-19',
      )
      .set(auth);
    expect(res.status).toBe(200);
    expect(t.m.order.findUnique.mock.calls[0]?.[0].where).toEqual({
      orderNumber: 'ORD-261119-00001',
    });
    const where = t.m.notification.findMany.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      event: 'ORDER_SHIPPED',
      channel: 'WHATSAPP',
      recipientAddress: { contains: '9812' },
      entityType: 'ORDER',
      entityId: orderId,
    });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lt).toBeInstanceOf(Date);

    t.m.notification.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/notifications/logs?to=2026-11-19').set(auth);
    expect(t.m.notification.findMany.mock.calls[0]?.[0].where).toEqual({
      createdAt: { lt: expect.any(Date) },
    });
    t.m.notification.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/notifications/logs?from=2026-11-19').set(auth);
    expect(t.m.notification.findMany.mock.calls[0]?.[0].where).toEqual({
      createdAt: { gte: expect.any(Date) },
    });
    expect(
      (await request(t.app).get('/api/v1/admin/notifications/logs?orderNumber=123').set(auth))
        .status,
    ).toBe(422);
  });

  it('sorts attempts chronologically, picks the latest failure, masks phones and empty addresses', async () => {
    const { t, auth } = setup();
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const log = (attemptNo: number, min: number, errorCode: string | null) => ({
      id: `l${String(attemptNo)}`,
      notificationId: 'n',
      logType: 'SEND_ATTEMPT',
      attemptNo,
      status: errorCode === null ? 'SENT' : 'FAILED',
      providerStatus: null,
      errorCode,
      errorMessage: errorCode === null ? null : `${errorCode} happened`,
      createdAt: at(min),
    });
    t.m.notification.findMany.mockResolvedValue([
      notification({
        channel: 'WHATSAPP',
        recipientAddress: '+919812345678',
        status: 'SENT',
        nextAttemptAt: at(30),
        providerMessageId: 'wamid.1',
        logs: [log(3, 20, null), log(1, 0, 'TIMEOUT'), log(2, 10, 'RATE_LIMIT')],
      }),
      notification({ recipientAddress: '', status: 'SKIPPED', logs: [] }),
    ]);
    t.m.notification.count.mockResolvedValue(2);
    const res = await request(t.app).get('/api/v1/admin/notifications/logs').set(auth);
    expect(res.status).toBe(200);
    const [wa, skipped] = res.body.data as Record<string, unknown>[];
    expect(wa).toMatchObject({
      recipient: '+91******5678',
      nextAttemptAt: at(30).toISOString(),
      providerMessageId: 'wamid.1',
      lastError: { code: 'RATE_LIMIT', message: 'RATE_LIMIT happened' },
    });
    expect((wa?.attempts as { attemptNo: number }[]).map((a) => a.attemptNo)).toEqual([1, 2, 3]);
    expect(skipped).toMatchObject({ recipient: '', lastError: null, attempts: [] });
    expect(maskRecipient('EMAIL', 'x@y.in')).toBe('x***@y.in');
  });
});

describe('notifications admin — resend edges', () => {
  const send = (t: T, auth: Record<string, string>, id: string, body: Record<string, unknown>) =>
    request(t.app)
      .post(`/api/v1/admin/notifications/${id}/resend`)
      .set(auth)
      .send({ reason: 'Customer asked', ...body });

  it('non-transactional payloads cannot be resent', async () => {
    const { t, auth } = setup();
    const promo = notification({
      payload: { v: 1, category: 'MARKETING', variables: {} },
    });
    t.m.notification.findUnique.mockResolvedValueOnce(promo);
    const res = await send(t, auth, promo.id, {});
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('RESEND_NOT_ALLOWED');
  });

  it('a repeat within 60 s replays the previous resend (200, replayed) without new rows', async () => {
    const { t, auth } = setup();
    const original = notification({ status: 'SENT' });
    const previous = { id: randomUUID(), channel: 'EMAIL', status: 'QUEUED' };
    t.m.notification.findUnique.mockResolvedValueOnce(original);
    t.m.notification.findFirst.mockResolvedValue(previous);
    const res = await send(t, auth, original.id, {});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: previous.id,
      resendOfId: original.id,
      channel: 'EMAIL',
      status: 'QUEUED',
      replayed: true,
    });
    expect(t.m.notification.findFirst.mock.calls[0]?.[0].where.createdAt.gte).toEqual(
      new Date(NOW.getTime() - 60_000),
    );
    expect(t.m.notification.create).not.toHaveBeenCalled();
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });

  it('channel switch uses the account address and requires WhatsApp opt-in', async () => {
    const { t, auth, staff } = setup();
    const original = notification({
      payload: {
        v: 1,
        locale: 'en-IN',
        category: 'TRANSACTIONAL',
        variant: 'LATE',
        variables: { firstName: 'Riya', ok: true, n: 2, skip: { nested: 1 } },
      },
    });
    t.m.notification.findUnique.mockResolvedValueOnce(original).mockResolvedValue(null);
    t.m.notification.findFirst.mockResolvedValue(null);
    t.m.notification.count.mockResolvedValue(2);
    t.m.user.findUnique.mockResolvedValue({ email: 'riya@example.com', phone: '+919812345678' });
    t.m.notificationPreference.findMany.mockResolvedValue([
      { channel: 'WHATSAPP', category: 'TRANSACTIONAL', isOptedIn: true },
    ]);
    const res = await send(t, auth, original.id, { channel: 'WHATSAPP' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ channel: 'WHATSAPP', replayed: false });
    expect(t.m.user.findUnique.mock.calls[0]?.[0].where).toEqual({ id: original.recipientUserId });
    const created = t.m.notification.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      channel: 'WHATSAPP',
      recipientAddress: '+919812345678',
      resendOfId: original.id,
      triggeredById: staff.ctx.userId,
    });
    expect(created.payload).toMatchObject({
      variant: 'LATE',
      variables: { firstName: 'Riya', ok: true, n: 2 },
    });
    expect(created.payload.variables).not.toHaveProperty('skip');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({ reason: 'Customer asked' });
  });

  it('channel switch without a known address → 422 NO_ADDRESS (guest or account lacks it)', async () => {
    const { t, auth } = setup();
    const guest = notification({ recipientUserId: null });
    t.m.notification.findUnique.mockResolvedValueOnce(guest);
    t.m.notification.findFirst.mockResolvedValue(null);
    t.m.notification.count.mockResolvedValue(0);
    const res = await send(t, auth, guest.id, { channel: 'WHATSAPP' });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({ field: 'channel', code: 'NO_ADDRESS' });
    expect(t.m.user.findUnique).not.toHaveBeenCalled();

    const wa = notification({ channel: 'WHATSAPP', recipientAddress: '+919812345678' });
    t.m.notification.findUnique.mockResolvedValueOnce(wa);
    t.m.user.findUnique.mockResolvedValueOnce(null);
    const noUser = await send(t, auth, wa.id, { channel: 'EMAIL' });
    expect(noUser.status).toBe(422);
    expect(noUser.body.error.details[0].code).toBe('NO_ADDRESS');
  });

  it('guest WhatsApp resend on the same channel has no consent record → RECIPIENT_OPTED_OUT', async () => {
    const { t, auth } = setup();
    const guest = notification({
      recipientUserId: null,
      channel: 'WHATSAPP',
      recipientAddress: '+919812345678',
    });
    t.m.notification.findUnique.mockResolvedValueOnce(guest);
    t.m.notification.findFirst.mockResolvedValue(null);
    t.m.notification.count.mockResolvedValue(0);
    const res = await send(t, auth, guest.id, {});
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('RECIPIENT_OPTED_OUT');
    expect(t.m.notificationPreference.findMany).not.toHaveBeenCalled();
  });

  it('guest email resend of a SENT notification is allowed (essential email)', async () => {
    const { t, auth } = setup();
    const guest = notification({ recipientUserId: null, status: 'SENT', entityType: null });
    t.m.notification.findUnique.mockResolvedValueOnce(guest).mockResolvedValue(null);
    t.m.notification.findFirst.mockResolvedValue(null);
    t.m.notification.count.mockResolvedValue(0);
    const res = await send(t, auth, guest.id, { channel: 'EMAIL' });
    expect(res.status).toBe(201);
    expect(t.m.notification.create.mock.calls[0]?.[0].data).toMatchObject({
      recipientUserId: null,
      recipientAddress: 'riya@example.com',
      entityType: null,
    });
    expect(t.m.notificationLog.create.mock.calls[0]?.[0].data).toMatchObject({
      logType: 'RESEND',
      status: 'QUEUED',
    });
  });
});
