/**
 * Seed builders and seed functions — MOCKED DB (the seeds are never run against MySQL here).
 * Verifies the data each seed would upsert and that re-runs never overwrite client data.
 */
import { describe, expect, it } from 'vitest';

import { PERMISSIONS, templatePermissions } from '../../../../src/lib/permissions.js';
import { validateSettingValue } from '../../../../src/modules/settings/settings.values.js';
import { buildPermissionRows, seedPermissions } from '../../../../prisma/seed/permissions.seed.js';
import { buildRoleDefinitions, seedRoles } from '../../../../prisma/seed/roles.seed.js';
import { buildSettingRows, seedSettings } from '../../../../prisma/seed/settings.seed.js';
import { GST_STATES, buildStateRows, seedStates } from '../../../../prisma/seed/states.seed.js';
import { runSeeds } from '../../../../prisma/seed/index.js';
import { createMockDb } from '../../../helpers/mockDb.js';

describe('permissions seed', () => {
  it('builds 88 rows with code = key, module/action split and critical flags', () => {
    const rows = buildPermissionRows();
    expect(rows).toHaveLength(88);
    expect(new Set(rows.map((r) => r.code)).size).toBe(88);
    expect(new Set(rows.map((r) => `${r.module}.${r.action}`)).size).toBe(88);
    expect(rows.find((r) => r.code === 'audit_logs.export')).toMatchObject({
      module: 'audit_logs',
      action: 'export',
      isCritical: true,
    });
    expect(rows.every((r) => r.description.length <= 255)).toBe(true);
  });

  it('upserts by code and flags keys missing from the catalogue as deprecated', async () => {
    const { db, m } = createMockDb();
    m.permission.updateMany.mockResolvedValue({ count: 1 });
    const result = await seedPermissions(db);
    expect(result).toEqual({ upserted: 88, deprecated: 1 });
    expect(m.permission.upsert).toHaveBeenCalledTimes(88);
    expect(m.permission.upsert.mock.calls[0]?.[0]).toMatchObject({
      where: { code: 'dashboard.view' },
      update: { isDeprecated: false },
    });
    expect(m.permission.updateMany.mock.calls[0]?.[0].data).toEqual({ isDeprecated: true });
  });
});

describe('roles seed', () => {
  it('defines SUPERADMIN (no rows), ADMIN (all keys incl. reserved) and three templates', () => {
    const defs = buildRoleDefinitions();
    expect(defs.map((d) => d.code)).toEqual([
      'SUPERADMIN',
      'ADMIN',
      'MANAGER',
      'EMPLOYEE',
      'STAFF',
    ]);
    const byCode = new Map(defs.map((d) => [d.code, d]));
    expect(byCode.get('SUPERADMIN')).toMatchObject({
      isSystem: true,
      permissionKeys: [],
      sync: 'none',
    });
    expect(byCode.get('ADMIN')?.permissionKeys).toHaveLength(88);
    expect(byCode.get('ADMIN')?.permissionKeys).toContain('orders.delete');
    expect(byCode.get('MANAGER')).toMatchObject({
      isSystem: false,
      sync: 'on-create',
      permissionKeys: templatePermissions('MANAGER'),
    });
    const reserved = PERMISSIONS.filter((p) => p.isReserved).map((p) => p.key);
    for (const code of ['MANAGER', 'EMPLOYEE', 'STAFF']) {
      expect(byCode.get(code)?.permissionKeys.some((k) => reserved.includes(k))).toBe(false);
    }
  });

  it('creates missing roles with grants; on re-run only tops up ADMIN and never touches templates', async () => {
    const { db, m } = createMockDb();
    m.permission.findMany.mockResolvedValue(
      PERMISSIONS.map((p) => ({ id: `id-${p.key}`, code: p.key })),
    );
    m.role.findUnique.mockResolvedValue(null);
    m.role.create.mockImplementation(({ data }: { data: { code: string } }) =>
      Promise.resolve({ id: `role-${data.code}` }),
    );
    m.rolePermission.createMany.mockImplementation(({ data }: { data: unknown[] }) =>
      Promise.resolve({ count: data.length }),
    );
    const first = await seedRoles(db);
    expect(first.created).toEqual(['SUPERADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'STAFF']);
    expect(m.role.create.mock.calls[1]?.[0].data).toMatchObject({
      code: 'ADMIN',
      nameNormalized: 'admin',
      isSystem: true,
    });
    expect(m.rolePermission.deleteMany).toHaveBeenCalledWith({
      where: { roleId: 'role-SUPERADMIN' },
    });
    expect(m.rolePermission.createMany).toHaveBeenCalledTimes(4);

    // Re-run: every role exists.
    m.role.create.mockClear();
    m.rolePermission.createMany.mockClear();
    m.role.findUnique.mockImplementation(({ where }: { where: { code: string } }) =>
      Promise.resolve({ id: `role-${where.code}` }),
    );
    const second = await seedRoles(db);
    expect(second.created).toEqual([]);
    expect(m.role.create).not.toHaveBeenCalled();
    expect(m.rolePermission.createMany).toHaveBeenCalledTimes(1); // ADMIN auto-grant only
    expect(m.rolePermission.createMany.mock.calls[0]?.[0]).toMatchObject({ skipDuplicates: true });
  });

  it('fails clearly when permission rows are missing', async () => {
    const { db, m } = createMockDb();
    m.permission.findMany.mockResolvedValue([]);
    m.role.findUnique.mockResolvedValue(null);
    m.role.create.mockResolvedValue({ id: 'r' });
    await expect(seedRoles(db)).rejects.toThrow(/seed permissions first/);
  });
});

describe('states seed', () => {
  it('contains the GST codes of §25.1 and seeds only active ones', () => {
    expect(GST_STATES).toHaveLength(39);
    const rows = buildStateRows();
    expect(rows).toHaveLength(37);
    expect(rows.map((r) => r.code)).not.toContain('25');
    expect(rows.map((r) => r.code)).not.toContain('28');
    expect(rows.find((r) => r.code === '27')).toEqual({
      code: '27',
      name: 'Maharashtra',
      isUnionTerritory: false,
      hasLegislature: true,
    });
    expect(rows.find((r) => r.code === '04')).toMatchObject({
      isUnionTerritory: true,
      hasLegislature: false,
    });
    expect(rows.every((r) => /^\d{2}$/.test(r.code))).toBe(true);
    expect(rows.every((r) => r.isUnionTerritory || r.hasLegislature)).toBe(true);
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });

  it('upserts by code', async () => {
    const { db, m } = createMockDb();
    expect(await seedStates(db)).toEqual({ upserted: 37 });
    expect(m.state.upsert.mock.calls[0]?.[0].where).toEqual({ code: '01' });
  });
});

describe('settings seed', () => {
  it('defaults are valid for their value type and carry no secrets', () => {
    const rows = buildSettingRows();
    expect(new Set(rows.map((r) => r.settingKey)).size).toBe(rows.length);
    for (const row of rows) {
      expect(
        validateSettingValue(row.settingKey, row.valueType, row.value),
        row.settingKey,
      ).toBeUndefined();
      expect(row.groupKey).toBe(row.settingKey.split('.')[0]);
      expect(row.settingKey).not.toMatch(/secret|token|password|api_?key/i);
    }
    const byKey = new Map(rows.map((r) => [r.settingKey, r]));
    expect(byKey.get('checkout.max_qty_per_line')).toMatchObject({ value: 5, isPublic: true });
    expect(byKey.get('customer.max_addresses_per_customer')?.value).toBe(20);
    // RD-08 option B: 30 idle days before ABANDONED; validated 1–365; not public.
    expect(byKey.get('cart.abandon_after_days')).toMatchObject({
      value: 30,
      valueType: 'NUMBER',
      isPublic: false,
      groupKey: 'cart',
    });
    expect(validateSettingValue('cart.abandon_after_days', 'NUMBER', 0)).toBeDefined();
    expect(validateSettingValue('cart.abandon_after_days', 'NUMBER', 366)).toBeDefined();
    expect(validateSettingValue('cart.abandon_after_days', 'NUMBER', 30)).toBeUndefined();
    // D-57: seller GSTIN lives only under tax.seller_* and is not seeded (absent = not configured).
    expect(byKey.has('store.gstin')).toBe(false);
    expect(byKey.has('store.state_code')).toBe(false);
    expect(byKey.has('tax.seller_gstin')).toBe(false);
    expect(byKey.get('shipping.free_shipping_threshold')).toMatchObject({
      value: '999.00',
      valueType: 'STRING',
    });
  });

  it('never overwrites value or version on re-run', async () => {
    const { db, m } = createMockDb();
    await seedSettings(db);
    const call = m.setting.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.create).toMatchObject({ version: 1 });
    expect(Object.keys(call.update).sort()).toEqual(['description', 'groupKey', 'isPublic']);
  });
});

describe('runSeeds', () => {
  it('runs permissions → roles → states → settings, each in its own transaction', async () => {
    const { db, m } = createMockDb();
    m.permission.updateMany.mockResolvedValue({ count: 0 });
    m.permission.findMany.mockResolvedValue(PERMISSIONS.map((p) => ({ id: p.key, code: p.key })));
    m.role.findUnique.mockResolvedValue({ id: 'existing' });
    m.rolePermission.createMany.mockResolvedValue({ count: 0 });
    const info: string[] = [];
    await runSeeds(db, {
      info: ((_o: unknown, msg: string) => info.push(msg)) as never,
    });
    expect(m.$transaction).toHaveBeenCalledTimes(4);
    expect(info).toEqual(['seed: permissions', 'seed: roles', 'seed: states', 'seed: settings']);
  });
});
