/**
 * LOW_STOCK_ALERT delivery — NOTIFICATION_WORKFLOWS.md §4.16, PROVISIONAL (OQ-47 working assumption,
 * D-56): instant mode, email only, recipients = active staff with effective `inventory.view` who opted
 * in (`notification_preferences`: EMAIL + STAFF_ALERTS + is_opted_in). One alert per low-stock episode:
 * the stock service only reports a crossing when it opens a new episode (`low_stock_alerted_at`).
 *
 * Runs AFTER the stock movement has committed; a failure here never fails the movement (logged).
 */
import type { DbClient } from '../../core/db/transaction.js';
import type { Logger } from '../../core/logger/logger.js';
import { hasPermission, type PermissionService } from '../rbac/permission.service.js';
import type { NotificationService } from '../notifications/notifications.service.js';
import type { LowStockCrossing } from './inventory.stock.js';

export interface LowStockNotifierDeps {
  readonly db: DbClient;
  readonly permissions: PermissionService;
  readonly notifications: NotificationService;
  readonly adminUrl: string;
  readonly clock: () => Date;
  readonly logger: Logger;
}

export type LowStockNotifier = (crossings: readonly LowStockCrossing[]) => Promise<number>;

export function createLowStockNotifier(deps: LowStockNotifierDeps): LowStockNotifier {
  const { db, permissions, notifications, logger } = deps;

  return async (crossings) => {
    if (crossings.length === 0) return 0;

    const candidates = await db.user.findMany({
      where: {
        accountType: 'STAFF',
        status: 'ACTIVE',
        deletedAt: null,
        notificationPrefs: {
          some: { channel: 'EMAIL', category: 'STAFF_ALERTS', isOptedIn: true },
        },
      },
      select: { id: true, email: true, isSuperadmin: true },
    });
    const recipients: { id: string; email: string }[] = [];
    for (const user of candidates) {
      const effective = await permissions.effectivePermissions(db, user.id, user.isSuperadmin);
      if (
        hasPermission({ isSuperadmin: user.isSuperadmin, permissions: effective }, 'inventory.view')
      ) {
        recipients.push({ id: user.id, email: user.email });
      }
    }
    if (recipients.length === 0) return 0;

    const variants = await db.productVariant.findMany({
      where: { id: { in: crossings.map((c) => c.variantId) } },
      select: { id: true, sku: true },
    });
    const skuOf = new Map(variants.map((v) => [v.id, v.sku]));
    const summary = crossings
      .map(
        (c) =>
          `${skuOf.get(c.variantId) ?? c.variantId}: ${String(c.available)} available (threshold ${String(c.threshold)})`,
      )
      .join('; ');
    const episode = deps.clock().toISOString();

    let sent = 0;
    for (const recipient of recipients) {
      const created = await notifications.enqueue(db, {
        event: 'LOW_STOCK_ALERT',
        channels: ['EMAIL'],
        recipientUserId: recipient.id,
        to: { email: recipient.email },
        category: 'STAFF_ALERTS',
        variables: {
          count: crossings.length,
          summary,
          inventoryUrl: `${deps.adminUrl}/inventory?lowStock=true`,
        },
        entityType: 'Inventory',
        discriminator: `${crossings
          .map((c) => c.variantId)
          .sort()
          .join(',')}@${episode}`,
      });
      sent += created.filter((n) => n.created).length;
    }
    logger.info(
      { event: 'LOW_STOCK_ALERT', crossings: crossings.length, recipients: recipients.length },
      'low stock alert queued',
    );
    return sent;
  };
}
