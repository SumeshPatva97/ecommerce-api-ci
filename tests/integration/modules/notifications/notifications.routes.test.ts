/**
 * Notifications HTTP — customer preferences and admin templates / logs / resend through the real
 * Express app. MOCKED DB (tests/helpers/mockDb.ts): no SQL runs.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createNotificationsModule } from '../../../../src/modules/notifications/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ALL = ['notifications.view', 'notifications.update'];

function setup() {
  const t = buildModuleTestApp([createNotificationsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  return t;
}

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
    variables: { allowed: ['firstName', 'orderNumber'], order: [], variants: {} },
    version: 1,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
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

describe('notifications routes', () => {
  it('guards every admin route with notifications.*', () => {
    const t = setup();
    const routes = expectAdminRoutesGuarded(createNotificationsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /notifications/templates notifications.view',
      'PATCH /notifications/templates/:templateId notifications.update',
      'GET /notifications/logs notifications.view',
      'POST /notifications/:notificationId/resend notifications.update',
    ]);
  });

  it('requires a customer token for preferences (admin audience → 401)', async () => {
    const t = setup();
    expect((await request(t.app).get('/api/v1/me/notification-preferences')).status).toBe(401);
    const staff = t.staff({ permissions: ALL });
    const res = await request(t.app)
      .get('/api/v1/me/notification-preferences')
      .set({ Authorization: `Bearer ${staff.token}` });
    expect(res.status).toBe(401);
  });

  it('GET /me/notification-preferences returns the documented shape', async () => {
    const t = setup();
    const c = t.customer();
    t.m.notificationPreference.findMany.mockResolvedValue([
      {
        id: 'p1',
        channel: 'EMAIL',
        category: 'MARKETING',
        isOptedIn: true,
        optedOutAt: null,
        updatedAt: NOW,
      },
      {
        id: 'p2',
        channel: 'WHATSAPP',
        category: 'TRANSACTIONAL',
        isOptedIn: false,
        optedOutAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const res = await request(t.app).get('/api/v1/me/notification-preferences').set(c.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      channels: {
        EMAIL: { transactional: true, marketing: true },
        WHATSAPP: { transactional: false, marketing: false, optedOutAt: NOW.toISOString() },
      },
      updatedAt: NOW.toISOString(),
    });
  });

  it('PATCH refuses to disable essential email (422) and WhatsApp without a phone', async () => {
    const t = setup();
    const c = t.customer();
    const off = await request(t.app)
      .patch('/api/v1/me/notification-preferences')
      .set(c.headers)
      .send({ channels: { EMAIL: { transactional: false } } });
    expect(off.status).toBe(422);
    expect(off.body.error.details[0].code).toBe('ESSENTIAL_EMAIL_REQUIRED');

    t.m.user.findUnique.mockResolvedValue({ phone: null });
    const wa = await request(t.app)
      .patch('/api/v1/me/notification-preferences')
      .set(c.headers)
      .send({ channels: { WHATSAPP: { transactional: true } } });
    expect(wa.status).toBe(422);
    expect(wa.body.error.details[0].code).toBe('PHONE_REQUIRED');

    const unknown = await request(t.app)
      .patch('/api/v1/me/notification-preferences')
      .set(c.headers)
      .send({ channels: { SMS: { transactional: true } } });
    expect(unknown.status).toBe(422);
  });

  it('PATCH records WhatsApp consent with source/version/IP and audits the change', async () => {
    const t = setup();
    const c = t.customer();
    t.m.user.findUnique.mockResolvedValue({ phone: '+919812345678' });
    t.m.notificationPreference.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'p9',
        channel: 'WHATSAPP',
        category: 'TRANSACTIONAL',
        isOptedIn: true,
        optedOutAt: null,
        updatedAt: NOW,
      },
    ]);
    t.m.notificationPreference.upsert.mockResolvedValue({ id: randomUUID() });
    const res = await request(t.app)
      .patch('/api/v1/me/notification-preferences')
      .set(c.headers)
      .send({ channels: { WHATSAPP: { transactional: true } }, consentTextVersion: 'wa-v1' });
    expect(res.status).toBe(200);
    expect(res.body.data.channels.WHATSAPP.transactional).toBe(true);
    const upsert = t.m.notificationPreference.upsert.mock.calls[0]?.[0];
    expect(upsert.where.userId_channel_category).toEqual({
      userId: c.ctx.userId,
      channel: 'WHATSAPP',
      category: 'TRANSACTIONAL',
    });
    expect(upsert.update).toMatchObject({
      isOptedIn: true,
      consentSource: 'ACCOUNT',
      consentTextVersion: 'wa-v1',
      consentedAt: NOW,
      optedOutAt: null,
    });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({
      action: 'UPDATE',
      module: 'notifications',
      entityType: 'NotificationPreference',
    });
    expect(audit.newValues._event.eventKey).toBe('consent.changed');
  });

  it('lists templates with variables and paging meta', async () => {
    const t = setup();
    const staff = t.staff({ permissions: ['notifications.view'] });
    t.m.notificationTemplate.findMany.mockResolvedValue([template()]);
    t.m.notificationTemplate.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get('/api/v1/admin/notifications/templates')
      .set(staff.headers);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      event: 'ORDER_SHIPPED',
      bodyTemplate: '<p>Hi {{firstName}}</p>',
      status: 'ACTIVE',
    });
    expect(res.body.data[0].variables).toContain('trackingUrl');
    expect(res.body.meta.totalItems).toBe(1);
  });

  it('PATCH template: unknown variables → 422, WhatsApp text read-only, email body sanitised + audited', async () => {
    const t = setup();
    const staff = t.staff({ permissions: ALL });
    const row = template();
    t.m.notificationTemplate.findUnique.mockResolvedValue(row);
    const unknown = await request(t.app)
      .patch(`/api/v1/admin/notifications/templates/${row.id}`)
      .set(staff.headers)
      .send({ subject: 'Hi {{password}}' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details[0]).toMatchObject({
      field: 'subject',
      code: 'UNKNOWN_VARIABLE',
    });

    t.m.notificationTemplate.findUnique.mockResolvedValueOnce(template({ channel: 'WHATSAPP' }));
    const wa = await request(t.app)
      .patch(`/api/v1/admin/notifications/templates/${row.id}`)
      .set(staff.headers)
      .send({ bodyTemplate: '<p>x</p>' });
    expect(wa.status).toBe(422);
    expect(wa.body.error.details[0].code).toBe('NOT_EDITABLE');

    t.m.notificationTemplate.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...row, ...data, version: 2 }),
    );
    const ok = await request(t.app)
      .patch(`/api/v1/admin/notifications/templates/${row.id}`)
      .set(staff.headers)
      .send({ bodyTemplate: '<p onclick="x()">Hi {{firstName}}<script>alert(1)</script></p>' });
    expect(ok.status).toBe(200);
    const data = t.m.notificationTemplate.update.mock.calls[0]?.[0].data;
    expect(data.body).toBe('<p>Hi {{firstName}}</p>');
    expect(data.version).toEqual({ increment: 1 });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'UPDATE',
      entityType: 'NotificationTemplate',
    });
  });

  it('GET logs masks recipients and returns attempts; unknown order number → empty', async () => {
    const t = setup();
    const staff = t.staff({ permissions: ['notifications.view'] });
    t.m.notification.findMany.mockResolvedValue([
      notification({
        logs: [
          {
            id: 'l1',
            notificationId: 'n',
            logType: 'SEND_ATTEMPT',
            attemptNo: 1,
            status: 'FAILED',
            providerStatus: 'TRANSIENT',
            errorCode: 'TIMEOUT',
            errorMessage: 'Provider call timed out.',
            createdAt: NOW,
          },
        ],
      }),
    ]);
    t.m.notification.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get('/api/v1/admin/notifications/logs?status=FAILED')
      .set(staff.headers);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      recipient: 'r***@example.com',
      lastError: { code: 'TIMEOUT' },
      attempts: [{ attemptNo: 1, type: 'SEND_ATTEMPT', status: 'FAILED' }],
    });
    expect(t.m.notification.findMany.mock.calls[0]?.[0].where).toMatchObject({ status: 'FAILED' });

    t.m.order.findUnique.mockResolvedValue(null);
    const none = await request(t.app)
      .get('/api/v1/admin/notifications/logs?orderNumber=ORD-261119-00001')
      .set(staff.headers);
    expect(none.body.data).toEqual([]);
    expect(none.body.meta.totalItems).toBe(0);
  });

  it('POST resend creates a child notification, logs it and audits with the reason', async () => {
    const t = setup();
    const staff = t.staff({ permissions: ALL });
    const original = notification();
    t.m.notification.findUnique.mockResolvedValueOnce(original).mockResolvedValue(null);
    t.m.notification.findFirst.mockResolvedValue(null);
    t.m.notification.count.mockResolvedValue(0);
    t.m.notificationPreference.findMany.mockResolvedValue([]);
    const res = await request(t.app)
      .post(`/api/v1/admin/notifications/${original.id}/resend`)
      .set(staff.headers)
      .send({ reason: 'Customer asked again' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      resendOfId: original.id,
      channel: 'EMAIL',
      status: 'QUEUED',
    });
    const created = t.m.notification.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      resendOfId: original.id,
      triggeredById: staff.ctx.userId,
      recipientAddress: 'riya@example.com',
      status: 'QUEUED',
    });
    expect(t.m.notificationLog.create.mock.calls[0]?.[0].data.logType).toBe('RESEND');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'UPDATE',
      reason: 'Customer asked again',
      entityId: original.id,
    });
  });

  it('resend rules: token events 422, opted-out WhatsApp 422, limit 429, queued 409', async () => {
    const t = setup();
    const staff = t.staff({ permissions: ALL });
    const send = (id: string, body: Record<string, unknown> = { reason: 'retry please' }) =>
      request(t.app).post(`/api/v1/admin/notifications/${id}/resend`).set(staff.headers).send(body);

    const token = notification({ event: 'PASSWORD_RESET_REQUESTED' });
    t.m.notification.findUnique.mockResolvedValueOnce(token);
    expect((await send(token.id)).body.error.details[0].code).toBe('RESEND_NOT_ALLOWED');

    const wa = notification({ channel: 'WHATSAPP', recipientAddress: '+919812345678' });
    t.m.notification.findUnique.mockResolvedValueOnce(wa);
    t.m.notification.findFirst.mockResolvedValue(null);
    t.m.notification.count.mockResolvedValue(0);
    t.m.notificationPreference.findMany.mockResolvedValue([
      { channel: 'WHATSAPP', category: 'TRANSACTIONAL', isOptedIn: false },
    ]);
    const optedOut = await send(wa.id);
    expect(optedOut.status).toBe(422);
    expect(optedOut.body.error.details[0].code).toBe('RECIPIENT_OPTED_OUT');

    const busy = notification();
    t.m.notification.findUnique.mockResolvedValueOnce(busy);
    t.m.notification.count.mockResolvedValue(3);
    const limited = await send(busy.id);
    expect(limited.status).toBe(429);
    expect(limited.body.error.details[0].code).toBe('RESEND_LIMIT');

    const queued = notification({ status: 'QUEUED' });
    t.m.notification.findUnique.mockResolvedValueOnce(queued);
    expect((await send(queued.id)).status).toBe(409);

    t.m.notification.findUnique.mockResolvedValueOnce(null);
    expect((await send(randomUUID())).status).toBe(404);
    expect((await send(randomUUID(), {})).status).toBe(422);
  });
});
