/**
 * LOW_STOCK_ALERT delivery (NOTIFICATION_WORKFLOWS §4.16, OQ-47 PROVISIONAL). MOCKED DB — no SQL runs.
 */
import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../../../src/core/logger/logger.js';
import { createLowStockNotifier } from '../../../../src/modules/inventory/inventory.alerts.js';
import type { NotificationService } from '../../../../src/modules/notifications/notifications.service.js';
import { FakePermissionService } from '../../../helpers/container.js';
import { createMockDb } from '../../../helpers/mockDb.js';
import { testConfig } from '../../../helpers/testApp.js';

const NOW = new Date('2026-11-20T04:30:00.000Z');

function setup() {
  const { db, m } = createMockDb();
  const permissions = new FakePermissionService();
  const enqueue = vi
    .fn()
    .mockResolvedValue([{ id: 'n1', channel: 'EMAIL', status: 'PENDING', created: true }]);
  const notifications = { enqueue } as unknown as NotificationService;
  const notify = createLowStockNotifier({
    db,
    permissions,
    notifications,
    adminUrl: 'https://admin.example.com',
    clock: () => NOW,
    logger: createLogger(testConfig()),
  });
  return { m, permissions, enqueue, notify };
}

const crossing = { variantId: 'v-1', available: 2, threshold: 5 };

describe('low-stock alert notifier', () => {
  it('emails only opted-in active staff who hold inventory.view (or are Superadmin)', async () => {
    const t = setup();
    t.m.user.findMany.mockResolvedValue([
      { id: 'u-viewer', email: 'viewer@example.com', isSuperadmin: false },
      { id: 'u-other', email: 'other@example.com', isSuperadmin: false },
      { id: 'u-sa', email: 'sa@example.com', isSuperadmin: true },
    ]);
    vi.spyOn(t.permissions, 'effectivePermissions').mockImplementation((_db, userId, isSa) =>
      Promise.resolve(isSa ? 'ALL' : userId === 'u-viewer' ? ['inventory.view'] : ['orders.view']),
    );
    t.m.productVariant.findMany.mockResolvedValue([{ id: 'v-1', sku: 'RING-GLD-7' }]);

    await expect(t.notify([crossing])).resolves.toBe(2);

    const where = t.m.user.findMany.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      accountType: 'STAFF',
      status: 'ACTIVE',
      deletedAt: null,
      notificationPrefs: { some: { channel: 'EMAIL', category: 'STAFF_ALERTS', isOptedIn: true } },
    });
    const recipients = t.enqueue.mock.calls.map(
      (c) => (c[1] as { to: { email: string } }).to.email,
    );
    expect(recipients).toEqual(['viewer@example.com', 'sa@example.com']);
    const input = t.enqueue.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({
      event: 'LOW_STOCK_ALERT',
      channels: ['EMAIL'],
      category: 'STAFF_ALERTS',
      variables: {
        count: 1,
        summary: 'RING-GLD-7: 2 available (threshold 5)',
        inventoryUrl: 'https://admin.example.com/inventory?lowStock=true',
      },
    });
  });

  it('does nothing without crossings or without eligible recipients', async () => {
    const t = setup();
    await expect(t.notify([])).resolves.toBe(0);
    expect(t.m.user.findMany).not.toHaveBeenCalled();

    t.m.user.findMany.mockResolvedValue([
      { id: 'u-x', email: 'x@example.com', isSuperadmin: false },
    ]);
    vi.spyOn(t.permissions, 'effectivePermissions').mockResolvedValue(['orders.view']);
    await expect(t.notify([crossing])).resolves.toBe(0);
    expect(t.enqueue).not.toHaveBeenCalled();
  });
});
