/**
 * Settings API (admin + public) — MOCKED DB (Prisma stand-in, no MySQL).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { REDACTED } from '../../../../src/lib/redact.js';
import { createSettingsModule } from '../../../../src/modules/settings/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');

function row(
  settingKey: string,
  value: unknown,
  valueType: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON',
  isPublic = false,
  version = 1,
) {
  return {
    settingKey,
    groupKey: settingKey.split('.')[0] ?? '',
    value,
    valueType,
    isPublic,
    description: null,
    version,
    updatedAt: NOW,
  };
}

const ROWS = [
  row('store.name', 'Gehna', 'STRING', true),
  row('store.support_phone', '+919812345678', 'STRING', true),
  row('checkout.max_qty_per_line', 5, 'NUMBER', true, 3),
  row('tax.prices_include_tax', true, 'BOOLEAN', true),
  row('integrations.webhook_secret', 'leaky', 'STRING'),
];

function app() {
  const t = buildModuleTestApp([createSettingsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.setting.updateMany.mockResolvedValue({ count: 1 });
  return t;
}

describe('settings module', () => {
  it('guards admin routes (PATCH is critical → re-auth)', () => {
    const t = app();
    const routes = expectAdminRoutesGuarded(createSettingsModule(t.container));
    expect(routes.find((r) => r.method === 'PATCH')?.reauth).toBe(true);
  });

  it('GET /admin/settings groups rows and masks secret-looking keys', async () => {
    const t = app();
    const viewer = t.staff({ permissions: ['settings.view'] });
    t.m.setting.findMany.mockResolvedValue(ROWS);
    const res = await request(t.app).get('/api/v1/admin/settings').set(viewer.headers);
    expect(res.status).toBe(200);
    const groups = res.body.data as {
      group: string;
      settings: { key: string; value: unknown }[];
    }[];
    expect(groups.map((g) => g.group)).toEqual(['checkout', 'integrations', 'store', 'tax']);
    const all = groups.flatMap((g) => g.settings);
    expect(all.find((s) => s.key === 'integrations.webhook_secret')?.value).toBe(REDACTED);
    expect(all.find((s) => s.key === 'store.support_phone')?.value).toBe('+919812345678');
    expect(all.find((s) => s.key === 'checkout.max_qty_per_line')).toMatchObject({
      value: 5,
      valueType: 'NUMBER',
      version: 3,
    });
  });

  it('GET /settings/public returns public rows only (camelCase per group) and caches them', async () => {
    const t = app();
    t.m.setting.findMany.mockResolvedValue(ROWS.filter((r) => r.isPublic));
    const res = await request(t.app).get('/api/v1/settings/public');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      store: { name: 'Gehna', supportPhone: '+919812345678' },
      checkout: { maxQtyPerLine: 5 },
      tax: { pricesIncludeTax: true },
    });
    expect(t.m.setting.findMany.mock.calls[0]?.[0].where).toEqual({ isPublic: true });
    await request(t.app).get('/api/v1/settings/public');
    expect(t.m.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('PATCH validates, updates with optimistic concurrency, audits SETTINGS_CHANGE and busts the public cache', async () => {
    const t = app();
    const actor = t.staff({ permissions: ['settings.update'], reauthenticated: true });
    t.store.set('settings:public', { stale: true }, 60);
    t.m.setting.findMany.mockResolvedValue([ROWS[2]]);
    const res = await request(t.app)
      .patch('/api/v1/admin/settings')
      .set(actor.headers)
      .send({
        changes: [{ key: 'checkout.max_qty_per_line', value: 6, version: 3 }],
        reason: 'Festive season',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.updated[0]).toMatchObject({
      key: 'checkout.max_qty_per_line',
      value: 6,
      version: 4,
    });
    expect(t.m.setting.updateMany).toHaveBeenCalledWith({
      where: { settingKey: 'checkout.max_qty_per_line', version: 3 },
      data: { value: 6, version: { increment: 1 }, updatedById: actor.ctx.userId },
    });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({
      action: 'SETTINGS_CHANGE',
      module: 'settings',
      reason: 'Festive season',
      oldValues: { 'checkout.max_qty_per_line': 5 },
    });
    expect(audit.newValues['checkout.max_qty_per_line']).toBe(6);
    expect(t.store.get('settings:public')).toBeUndefined();
  });

  it('redacts secret-looking values in the audit row', async () => {
    const t = app();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    t.m.setting.findMany.mockResolvedValue([ROWS[4]]);
    const res = await request(t.app)
      .patch('/api/v1/admin/settings')
      .set(sa.headers)
      .send({ changes: [{ key: 'integrations.webhook_secret', value: 'n3w-s3cret', version: 1 }] });
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(t.m.auditLog.create.mock.calls[0]?.[0].data);
    expect(serialized).not.toContain('n3w-s3cret');
    expect(serialized).not.toContain('leaky');
    expect(res.body.data.updated[0].value).toBe(REDACTED);
  });

  it('stale version → 409 VERSION_MISMATCH; lost race (0 rows) → 409', async () => {
    const t = app();
    const actor = t.staff({ permissions: ['settings.update'], reauthenticated: true });
    t.m.setting.findMany.mockResolvedValue([ROWS[2]]);
    const stale = await request(t.app)
      .patch('/api/v1/admin/settings')
      .set(actor.headers)
      .send({ changes: [{ key: 'checkout.max_qty_per_line', value: 6, version: 2 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details[0]).toMatchObject({
      code: 'VERSION_MISMATCH',
      meta: { currentVersion: 3 },
    });
    t.m.setting.updateMany.mockResolvedValueOnce({ count: 0 });
    const race = await request(t.app)
      .patch('/api/v1/admin/settings')
      .set(actor.headers)
      .send({ changes: [{ key: 'checkout.max_qty_per_line', value: 6, version: 3 }] });
    expect(race.status).toBe(409);
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });

  it('validates value types, known-key rules and unknown keys (422)', async () => {
    const t = app();
    const actor = t.staff({ permissions: ['settings.update'], reauthenticated: true });
    t.m.setting.findMany.mockResolvedValue([ROWS[2], ROWS[0]]);
    const res = await request(t.app)
      .patch('/api/v1/admin/settings')
      .set(actor.headers)
      .send({
        changes: [
          { key: 'checkout.max_qty_per_line', value: '6', version: 3 },
          { key: 'store.name', value: '', version: 1 },
          { key: 'store.unknown_key', value: 'x', version: 1 },
        ],
      });
    expect(res.status).toBe(422);
    expect((res.body.error.details as { field: string }[]).map((d) => d.field)).toEqual([
      'changes[0].value',
      'changes[1].value',
      'changes[2].key',
    ]);
  });

  it('tax.* keys also need tax.update (403, audited); PATCH needs re-auth', async () => {
    const t = app();
    const actor = t.staff({ permissions: ['settings.update'], reauthenticated: true });
    t.m.setting.findMany.mockResolvedValue([ROWS[3]]);
    const res = await request(t.app)
      .patch('/api/v1/admin/settings')
      .set(actor.headers)
      .send({ changes: [{ key: 'tax.prices_include_tax', value: false, version: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'PERMISSION_DENIED',
      outcome: 'FAILURE',
    });
    const noReauth = t.staff({ permissions: ['settings.update'] });
    const r2 = await request(t.app)
      .patch('/api/v1/admin/settings')
      .set(noReauth.headers)
      .send({ changes: [{ key: 'store.name', value: 'x', version: 1 }] });
    expect(r2.body.error.code).toBe('REAUTH_REQUIRED');
  });
});
