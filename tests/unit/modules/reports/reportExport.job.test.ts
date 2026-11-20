/**
 * Async report export worker — MOCKED DB (Prisma stand-in, no MySQL). Not scheduled anywhere.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  processReportExport,
  type ReportExportStorage,
} from '../../../../src/jobs/reportExport.js';
import type { AuditService } from '../../../../src/modules/audit/audit.service.js';
import type { Logger } from '../../../../src/core/logger/logger.js';
import { createMockDb } from '../../../helpers/mockDb.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const EXPORT_ID = '3f2a0000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000009';

function setup(permissions: 'ALL' | string[], storage?: ReportExportStorage) {
  const { db, m } = createMockDb();
  const audit = { record: vi.fn(), recordSafe: vi.fn().mockResolvedValue(undefined) };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  m.reportExport.updateMany.mockResolvedValue({ count: 1 });
  m.reportExport.update.mockResolvedValue({});
  m.reportExport.findUnique.mockResolvedValue({
    id: EXPORT_ID,
    reportKey: 'sales',
    format: 'CSV',
    filters: { filters: { from: '2026-11-01', to: '2026-11-02' }, includeHeader: true },
    status: 'PROCESSING',
    requestedById: USER_ID,
  });
  m.user.findUnique.mockResolvedValue({
    id: USER_ID,
    email: 'priya@example.com',
    firstName: 'Priya',
    isSuperadmin: false,
    status: 'ACTIVE',
  });
  const deps = {
    db,
    logger,
    audit: audit as unknown as AuditService,
    permissions: { effectivePermissions: vi.fn().mockResolvedValue(permissions) },
    clock: () => NOW,
    ...(storage === undefined ? {} : { storage }),
  };
  return { m, audit, deps };
}

describe('processReportExport', () => {
  it('skips exports that are not QUEUED (idempotent claim)', async () => {
    const { m, deps } = setup(['reports.view', 'reports.export']);
    m.reportExport.updateMany.mockResolvedValue({ count: 0 });
    await expect(processReportExport(EXPORT_ID, deps)).resolves.toEqual({ status: 'SKIPPED' });
    expect(m.reportExport.updateMany).toHaveBeenCalledWith({
      where: { id: EXPORT_ID, status: 'QUEUED' },
      data: { status: 'PROCESSING' },
    });
    expect(m.reportExport.findUnique).not.toHaveBeenCalled();
  });

  it('fails (audited) when the requester lost the permission (R11)', async () => {
    const { m, audit, deps } = setup(['reports.view']);
    const result = await processReportExport(EXPORT_ID, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'PERMISSION_REVOKED' });
    expect(m.reportExport.update).toHaveBeenCalledWith({
      where: { id: EXPORT_ID },
      data: { status: 'FAILED' },
    });
    expect(audit.recordSafe.mock.calls.map((c) => (c[2] as { action: string }).action)).toEqual([
      'PERMISSION_DENIED',
      'EXPORT',
    ]);
  });

  it('fails with STORAGE_UNAVAILABLE when no private storage is configured', async () => {
    const { m, deps } = setup(['reports.view', 'reports.export']);
    const result = await processReportExport(EXPORT_ID, deps);
    expect(result).toEqual({ status: 'FAILED', reason: 'STORAGE_UNAVAILABLE' });
    expect(m.$queryRaw).not.toHaveBeenCalled();
  });

  it('renders, stores and marks READY with hash, row count and a 7-day expiry', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const { m, audit, deps } = setup('ALL', { put });
    m.$queryRaw.mockResolvedValue([]);
    const result = await processReportExport(EXPORT_ID, deps);
    expect(result).toEqual({
      status: 'READY',
      rowCount: 2,
      storageKey: `report-exports/${EXPORT_ID}.csv`,
    });
    expect(put).toHaveBeenCalledWith(
      `report-exports/${EXPORT_ID}.csv`,
      expect.any(Buffer),
      'text/csv; charset=utf-8',
    );
    const csv = (put.mock.calls[0]?.[1] as Buffer).toString('utf8');
    expect(csv).toContain(`# Export ID: ${EXPORT_ID}`);
    const update = m.reportExport.update.mock.calls.at(-1)?.[0] as {
      data: { status: string; fileHash: string; expiresAt: Date };
    };
    expect(update.data.status).toBe('READY');
    expect(update.data.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(update.data.expiresAt.toISOString()).toBe('2026-11-26T06:30:00.000Z');
    expect(audit.recordSafe.mock.calls.at(-1)?.[2]).toMatchObject({
      action: 'EXPORT',
      eventKey: 'reports.export_generated',
    });
  });
});
