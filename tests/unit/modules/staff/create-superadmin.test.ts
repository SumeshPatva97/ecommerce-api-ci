/**
 * Superadmin bootstrap CLI (AUTH §21.1) — MOCKED DB; the CLI is never run against MySQL here.
 */
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../../../src/core/logger/logger.js';
import { hashToken } from '../../../../src/core/security/tokens.js';
import {
  CliError,
  createSuperadmin,
  parseArgs,
  type CreateSuperadminDeps,
} from '../../../../scripts/create-superadmin.js';
import { createMockDb } from '../../../helpers/mockDb.js';
import { testConfig } from '../../../helpers/testApp.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const USER_ID = '7d9f3b1e-2c4a-4f5e-8a6b-1c2d3e4f5a6b';

function deps(): { d: CreateSuperadminDeps; m: ReturnType<typeof createMockDb>['m'] } {
  const { db, m } = createMockDb();
  m.auditLog.create.mockResolvedValue({});
  return {
    m,
    d: {
      db,
      logger: createLogger(testConfig()),
      clock: () => NOW,
      adminUrl: 'http://localhost:5174/',
      superadminMax: 2,
      tokenPepper: 'test-pepper',
      operator: { osUser: 'ops', host: 'build-01' },
    },
  };
}

describe('parseArgs', () => {
  it('parses flags in both forms and rejects unknown or incomplete ones', () => {
    expect(
      parseArgs([
        'superadmin:create',
        '--email',
        'owner@example.com',
        '--first-name=Asha',
        '--last-name',
        'Rao',
      ]),
    ).toEqual({
      email: 'owner@example.com',
      firstName: 'Asha',
      lastName: 'Rao',
      forceAdditional: false,
    });
    expect(() => parseArgs(['--password', 'x'])).toThrow(CliError);
    expect(() => parseArgs(['--email'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--email', 'nope', '--first-name', 'A'])).toThrow(/Invalid arguments/);
    expect(() =>
      parseArgs(['--email', 'a@b.co', '--first-name', 'A', '--force-additional']),
    ).toThrow(/requires --reason/);
  });
});

describe('createSuperadmin', () => {
  const input = { email: 'Owner@Example.com', firstName: 'Asha', forceAdditional: false };

  it('creates an invited Superadmin, a 24 h STAFF_INVITE token and a SYSTEM audit row', async () => {
    const { d, m } = deps();
    m.user.count.mockResolvedValue(0);
    m.user.findUnique.mockResolvedValue(null);
    m.role.findUnique.mockResolvedValue({ id: 'role-sa' });
    m.user.create.mockResolvedValue({ id: USER_ID });

    const result = await createSuperadmin(d, input);
    expect(result.userId).toBe(USER_ID);
    expect(result.inviteUrl).toMatch(/^http:\/\/localhost:5174\/accept-invite\?token=[\w-]{43}$/);
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 24 * 3600 * 1000));

    expect(m.user.create.mock.calls[0]?.[0].data).toMatchObject({
      accountType: 'STAFF',
      emailNormalized: 'owner@example.com',
      status: 'PENDING_VERIFICATION',
      isSuperadmin: true,
    });
    expect(m.userRole.create.mock.calls[0]?.[0].data).toMatchObject({
      userId: USER_ID,
      roleId: 'role-sa',
    });
    const token = new URL(result.inviteUrl).searchParams.get('token') ?? '';
    expect(m.verificationToken.create.mock.calls[0]?.[0].data).toMatchObject({
      purpose: 'STAFF_INVITE',
      tokenHash: hashToken(token, 'test-pepper'),
    });
    const audit = m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({
      actorType: 'SYSTEM',
      actorUserId: null,
      action: 'CREATE',
      module: 'admin_users',
      entityId: USER_ID,
    });
    expect(JSON.stringify(audit)).toContain('system:cli');
    expect(JSON.stringify(audit)).toContain('build-01');
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('refuses at SUPERADMIN_MAX unless --force-additional, and when the seed has not run', async () => {
    const { d, m } = deps();
    m.user.count.mockResolvedValue(2);
    await expect(createSuperadmin(d, input)).rejects.toThrow(/SUPERADMIN_MAX=2/);
    expect(m.user.create).not.toHaveBeenCalled();

    m.user.findUnique.mockResolvedValue(null);
    m.role.findUnique.mockResolvedValue(null);
    await expect(
      createSuperadmin(d, { ...input, forceAdditional: true, reason: 'second owner approved' }),
    ).rejects.toThrow(/run the seed first/);
  });

  it('refuses an email that already exists', async () => {
    const { d, m } = deps();
    m.user.count.mockResolvedValue(0);
    m.user.findUnique.mockResolvedValue({ id: 'x' });
    await expect(createSuperadmin(d, input)).rejects.toThrow(/already exists/);
  });
});
