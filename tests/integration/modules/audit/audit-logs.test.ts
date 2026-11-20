/**
 * Audit-log viewer & export — MOCKED DB (Prisma stand-in, no MySQL).
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { csvCell, unpackNewValues } from '../../../../src/modules/audit/audit.mapper.js';
import { resolveRange } from '../../../../src/modules/audit/audit.repository.js';
import { createAuditLogsModule } from '../../../../src/modules/audit/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');

function app() {
  const t = buildModuleTestApp([createAuditLogsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.user.findMany.mockResolvedValue([]);
  return t;
}

function auditRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    createdAt: new Date('2026-11-18T07:15:22.481Z'),
    actorType: 'STAFF',
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    actorRole: 'MANAGER',
    loginType: 'STAFF',
    action: 'UPDATE',
    module: 'coupons',
    entityType: 'Coupon',
    entityId: randomUUID(),
    outcome: 'SUCCESS',
    oldValues: { usageLimit: 1000 },
    newValues: {
      usageLimit: 1500,
      _event: {
        eventKey: 'coupons.updated',
        changedFields: ['usageLimit'],
        metadata: { entityLabel: 'FESTIVE500' },
      },
    },
    ipAddress: '203.0.113.24',
    requestId: 'req_1',
    userAgent: 'Mozilla/5.0',
    reason: 'Extended for weekend sale',
    ...over,
  };
}

describe('audit-logs module', () => {
  it('exposes only GET and export routes, guarded (export critical → re-auth)', () => {
    const t = app();
    const routes = expectAdminRoutesGuarded(createAuditLogsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${String(r.reauth)}`)).toEqual([
      'GET /audit-logs false',
      'POST /audit-logs/export true',
    ]);
  });

  it('lists with filters, unpacks _event and returns pagination meta', async () => {
    const t = app();
    const viewer = t.staff({ permissions: ['audit_logs.view'] });
    t.m.auditLog.count.mockResolvedValue(1);
    t.m.auditLog.findMany.mockResolvedValue([auditRow()]);
    t.m.user.findMany.mockResolvedValue([
      {
        id: 'a0000000-0000-4000-8000-000000000001',
        firstName: 'Ravi',
        lastName: 'Kulkarni',
        accountType: 'STAFF',
        email: 'ravi@example.com',
      },
    ]);
    const res = await request(t.app)
      .get(
        '/api/v1/admin/audit-logs?module=coupons&action=UPDATE,PERMISSION_DENIED&from=2026-11-01&to=2026-11-13&eventKey=coupons.updated&ip=203.0.113.*&limit=50',
      )
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 50, totalItems: 1, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({
      timezone: 'Asia/Kolkata',
      actor: { name: 'Ravi Kulkarni', roles: ['MANAGER'], isSuperadmin: false },
      action: 'UPDATE',
      eventKey: 'coupons.updated',
      entityLabel: 'FESTIVE500',
      changes: { old: { usageLimit: 1000 }, new: { usageLimit: 1500 } },
      changedFields: ['usageLimit'],
      reason: 'Extended for weekend sale',
    });
    const where = t.m.auditLog.findMany.mock.calls[0]?.[0].where.AND as Record<string, unknown>[];
    expect(where).toContainEqual({ action: { in: ['UPDATE', 'PERMISSION_DENIED'] } });
    expect(where).toContainEqual({ module: { in: ['coupons'] } });
    expect(where).toContainEqual({ ipAddress: { startsWith: '203.0.113.' } });
    expect(where).toContainEqual({
      newValues: { path: '$._event.eventKey', equals: 'coupons.updated' },
    });
    expect(where[0]).toEqual({
      createdAt: {
        gte: new Date('2026-10-31T18:30:00.000Z'),
        lt: new Date('2026-11-13T18:30:00.000Z'),
      },
    });
    expect(t.m.auditLog.findMany.mock.calls[0]?.[0].orderBy[0]).toEqual({ createdAt: 'desc' });
  });

  it('defaults to the last 7 days and rejects ranges over 366 days / bad enums', async () => {
    const range = resolveRange(undefined, undefined, NOW);
    expect(range.end.getTime() - range.start.getTime()).toBe(7 * 24 * 3600 * 1000);
    const t = app();
    const viewer = t.staff({ permissions: ['audit_logs.view'] });
    const tooWide = await request(t.app)
      .get('/api/v1/admin/audit-logs?from=2024-01-01&to=2026-11-01')
      .set(viewer.headers);
    expect(tooWide.status).toBe(422);
    expect(
      (await request(t.app).get('/api/v1/admin/audit-logs?action=HACK').set(viewer.headers)).status,
    ).toBe(422);
  });

  it('resolves actorEmail to an actor id and hides customer names without customers.view', async () => {
    const t = app();
    const viewer = t.staff({ permissions: ['audit_logs.view'] });
    t.m.user.findUnique.mockResolvedValue({ id: 'c0000000-0000-4000-8000-000000000009' });
    t.m.auditLog.count.mockResolvedValue(1);
    t.m.auditLog.findMany.mockResolvedValue([
      auditRow({
        actorType: 'CUSTOMER',
        actorUserId: 'c0000000-0000-4000-8000-000000000009',
        actorRole: null,
      }),
    ]);
    t.m.user.findMany.mockResolvedValue([
      {
        id: 'c0000000-0000-4000-8000-000000000009',
        firstName: 'Ananya',
        lastName: null,
        accountType: 'CUSTOMER',
        email: 'a@example.com',
      },
    ]);
    const res = await request(t.app)
      .get('/api/v1/admin/audit-logs?actorEmail=A@Example.com')
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect(t.m.user.findUnique.mock.calls[0]?.[0].where).toEqual({
      emailNormalized: 'a@example.com',
    });
    expect(res.body.data[0].actor.name).toBeNull();
    const where = t.m.auditLog.findMany.mock.calls[0]?.[0].where.AND;
    expect(where).toContainEqual({ actorUserId: { in: ['c0000000-0000-4000-8000-000000000009'] } });
  });

  it('exports CSV (re-auth) with CSV-injection protection and audits EXPORT', async () => {
    const t = app();
    const actor = t.staff({ permissions: ['audit_logs.export'], reauthenticated: true });
    t.m.auditLog.count.mockResolvedValue(1);
    t.m.auditLog.findMany.mockResolvedValue([auditRow({ reason: '=HYPERLINK("http://x")' })]);
    const res = await request(t.app)
      .post('/api/v1/admin/audit-logs/export')
      .set(actor.headers)
      .send({ module: ['coupons'], format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="audit-logs-\d{8}T\d{6}\.csv"/,
    );
    expect(res.text).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(res.text).toContain('Generated by');
    const exportAudit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(exportAudit).toMatchObject({
      action: 'EXPORT',
      module: 'audit_logs',
      actorUserId: actor.ctx.userId,
      outcome: 'SUCCESS',
    });
    expect(exportAudit.newValues).toMatchObject({ format: 'csv', rowCount: 1 });
  });

  it('export: no re-auth → 403; > 10 000 rows → 422 EXPORT_TOO_LARGE; xlsx/unknown keys → 422', async () => {
    const t = app();
    const noReauth = t.staff({ permissions: ['audit_logs.export'] });
    const r1 = await request(t.app)
      .post('/api/v1/admin/audit-logs/export')
      .set(noReauth.headers)
      .send({});
    expect(r1.body.error.code).toBe('REAUTH_REQUIRED');

    const actor = t.staff({ permissions: ['audit_logs.export'], reauthenticated: true });
    t.m.auditLog.count.mockResolvedValue(10_001);
    const big = await request(t.app)
      .post('/api/v1/admin/audit-logs/export')
      .set(actor.headers)
      .send({});
    expect(big.status).toBe(422);
    expect(big.body.error.details[0].code).toBe('EXPORT_TOO_LARGE');
    expect(t.m.auditLog.findMany).not.toHaveBeenCalled();

    for (const body of [{ format: 'xlsx' }, { delete: true }]) {
      const res = await request(t.app)
        .post('/api/v1/admin/audit-logs/export')
        .set(actor.headers)
        .send(body);
      expect(res.status).toBe(422);
    }
  });

  it('has no update/delete routes', async () => {
    const t = app();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    expect(
      (await request(t.app).delete(`/api/v1/admin/audit-logs/${randomUUID()}`).set(sa.headers))
        .status,
    ).toBe(404);
    expect(
      (
        await request(t.app)
          .patch(`/api/v1/admin/audit-logs/${randomUUID()}`)
          .set(sa.headers)
          .send({})
      ).status,
    ).toBe(404);
  });
});

describe('audit mapper helpers', () => {
  it('csvCell neutralises formula prefixes and quotes separators', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+91 98')).toBe("'+91 98");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('');
  });

  it('unpackNewValues separates _event from the payload', () => {
    expect(unpackNewValues({ _event: { eventKey: 'authz.denied', metadata: { m: 1 } } })).toEqual({
      newValues: null,
      eventKey: 'authz.denied',
      changedFields: [],
      metadata: { m: 1 },
    });
    expect(unpackNewValues(null).eventKey).toBeNull();
  });
});
