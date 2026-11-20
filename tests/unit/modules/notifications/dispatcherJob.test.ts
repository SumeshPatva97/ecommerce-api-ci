/**
 * src/jobs/notificationDispatcher.ts — one-pass runner and the opt-in poller (no timers at import).
 * MOCKED DB.
 */
import { describe, expect, it } from 'vitest';

import {
  createNotificationDispatchJob,
  runNotificationDispatch,
} from '../../../../src/jobs/notificationDispatcher.js';
import { createNotificationsModule } from '../../../../src/modules/notifications/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

describe('notification dispatcher job', () => {
  it('runs one pass over due rows using the container providers', async () => {
    const t = buildModuleTestApp([createNotificationsModule]);
    t.m.notification.findMany.mockResolvedValue([]);
    await expect(runNotificationDispatch(t.container, { limit: 5 })).resolves.toEqual({
      picked: 0,
      sent: 0,
      skipped: 0,
      retried: 0,
      failed: 0,
      lost: 0,
    });
    expect(t.m.notification.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'QUEUED' },
      take: 5,
    });
  });

  it('creates a stoppable poller that never overlaps passes and swallows DB errors', async () => {
    const t = buildModuleTestApp([createNotificationsModule]);
    t.m.notification.findMany.mockRejectedValue(new Error('db down'));
    const job = createNotificationDispatchJob(t.container, { intervalMs: 60_000 });
    job.start();
    job.start();
    const [a, b] = await Promise.all([job.tick(), job.tick()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(t.m.notification.findMany).toHaveBeenCalledTimes(1);
    job.stop();
    job.stop();
  });

  it('WP-O2: stops before claiming the next notification when the stop signal is raised', async () => {
    const t = buildModuleTestApp([createNotificationsModule]);
    const controller = new AbortController();
    t.m.setting.findMany.mockResolvedValue([]);
    t.m.notification.findMany.mockResolvedValue([
      { id: 'n1', attemptCount: 0 },
      { id: 'n2', attemptCount: 0 },
    ]);
    t.m.notification.updateMany.mockImplementation(() => {
      controller.abort(); // shutdown requested while n1 is being handled
      return Promise.resolve({ count: 0 }); // n1 lost to another runner: nothing sent
    });
    const summary = await runNotificationDispatch(t.container, { signal: controller.signal });
    expect(summary).toMatchObject({ picked: 2, lost: 1, sent: 0 });
    expect(t.m.notification.updateMany).toHaveBeenCalledTimes(1); // n2 never claimed: stays QUEUED
  });
});
