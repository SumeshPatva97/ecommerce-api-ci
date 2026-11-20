/**
 * Superadmin bootstrap CLI — AUTHENTICATION_AUTHORIZATION.md §21.1, DATABASE_DESIGN.md §25.4,
 * decision OQ-46 (1–2 Superadmins, `SUPERADMIN_MAX`). Never exposed over HTTP.
 *
 *   npx tsx scripts/create-superadmin.ts --email owner@example.com --first-name Asha [--last-name Rao]
 *   npx tsx scripts/create-superadmin.ts ... --force-additional --reason "second owner (ticket 42)"
 *
 * - Creates a STAFF user with `is_superadmin = true`, status PENDING_VERIFICATION, no password, and
 *   assigns the system role SUPERADMIN (run the seed first).
 * - Issues a STAFF_INVITE token (24 h) and prints the accept-invite URL ONCE to stdout. No password
 *   is accepted on the command line (shell history).
 * - Refuses when ≥ SUPERADMIN_MAX Superadmins are live (ACTIVE or invited), unless
 *   `--force-additional` with a recorded `--reason`.
 * - Writes audit `CREATE` with a SYSTEM actor (operator OS user + host in metadata), in the same
 *   transaction as the user.
 */
import { hostname, userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { loadConfigFromProcess } from '../src/core/config/index.js';
import { createDatabase } from '../src/core/db/prisma.js';
import { withTransaction, type DbClient } from '../src/core/db/transaction.js';
import { createLogger, type Logger } from '../src/core/logger/logger.js';
import { generateOpaqueToken, hashToken } from '../src/core/security/tokens.js';
import { normalizeEmail } from '../src/lib/normalize.js';
import { addHours } from '../src/lib/time.js';
import { createAuditService, SYSTEM_ACTOR } from '../src/modules/audit/audit.service.js';

export const CLI_INVITE_TTL_HOURS = 24;

export class CliError extends Error {
  override readonly name = 'CliError';
}

const InputSchema = z.strictObject({
  email: z.email().max(254),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  forceAdditional: z.boolean(),
  reason: z.string().trim().min(5).max(500).optional(),
});
export type CreateSuperadminInput = z.output<typeof InputSchema>;

const FLAGS: Readonly<Record<string, keyof CreateSuperadminInput>> = {
  '--email': 'email',
  '--first-name': 'firstName',
  '--last-name': 'lastName',
  '--reason': 'reason',
};

/** Parses `--flag value` / `--flag=value` arguments. Unknown flags are rejected. */
export function parseArgs(argv: readonly string[]): CreateSuperadminInput {
  const raw: Record<string, unknown> = { forceAdditional: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === 'superadmin:create') continue;
    if (arg === '--force-additional') {
      raw.forceAdditional = true;
      continue;
    }
    const [flag = '', inline] = arg.split(/=(.*)/s, 2);
    const field = FLAGS[flag];
    if (field === undefined) throw new CliError(`Unknown argument: ${arg}`);
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} needs a value.`);
    raw[field] = value;
  }
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
    throw new CliError(`Invalid arguments:\n  ${problems.join('\n  ')}`);
  }
  if (parsed.data.forceAdditional && parsed.data.reason === undefined) {
    throw new CliError('--force-additional requires --reason "…".');
  }
  return parsed.data;
}

export interface CreateSuperadminDeps {
  readonly db: DbClient;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly adminUrl: string;
  readonly superadminMax: number;
  /** Must equal the API's REFRESH_TOKEN_PEPPER so admin-auth accept-invite can find the token. */
  readonly tokenPepper: string | undefined;
  readonly operator: { readonly osUser: string; readonly host: string };
}

export interface CreateSuperadminResult {
  readonly userId: string;
  readonly inviteUrl: string;
  readonly expiresAt: Date;
}

export async function createSuperadmin(
  deps: CreateSuperadminDeps,
  input: CreateSuperadminInput,
): Promise<CreateSuperadminResult> {
  const { db, clock } = deps;
  const live = await db.user.count({
    where: {
      isSuperadmin: true,
      accountType: 'STAFF',
      deletedAt: null,
      status: { in: ['ACTIVE', 'PENDING_VERIFICATION'] },
    },
  });
  if (live >= deps.superadminMax && !input.forceAdditional) {
    throw new CliError(
      `Refusing: ${live} Superadmin(s) already exist (SUPERADMIN_MAX=${deps.superadminMax}). ` +
        'Use --force-additional --reason "…" only with documented approval.',
    );
  }
  const emailNormalized = normalizeEmail(input.email);
  const existing = await db.user.findUnique({ where: { emailNormalized }, select: { id: true } });
  if (existing !== null) throw new CliError('An account with this email already exists.');
  const role = await db.role.findUnique({ where: { code: 'SUPERADMIN' }, select: { id: true } });
  if (role === null) throw new CliError('System role SUPERADMIN not found — run the seed first.');

  const now = clock();
  const token = generateOpaqueToken();
  const expiresAt = addHours(now, CLI_INVITE_TTL_HOURS);
  const audit = createAuditService(deps.logger, clock);

  const userId = await withTransaction(db, async ({ tx }) => {
    const user = await tx.user.create({
      data: {
        accountType: 'STAFF',
        email: input.email.trim(),
        emailNormalized,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        status: 'PENDING_VERIFICATION',
        isSuperadmin: true,
      },
      select: { id: true },
    });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id, assignedAt: now } });
    await tx.verificationToken.create({
      data: {
        userId: user.id,
        purpose: 'STAFF_INVITE',
        channel: 'EMAIL',
        target: emailNormalized,
        tokenHash: hashToken(token, deps.tokenPepper),
        expiresAt,
      },
    });
    await audit.record(tx, SYSTEM_ACTOR, {
      action: 'CREATE',
      module: 'admin_users',
      entityType: 'User',
      entityId: user.id,
      after: {
        id: user.id,
        email: emailNormalized,
        firstName: input.firstName,
        status: 'PENDING_VERIFICATION',
        isSuperadmin: true,
        roles: ['SUPERADMIN'],
      },
      reason: input.reason,
      eventKey: 'auth.superadmin_bootstrap',
      metadata: {
        actor: 'system:cli',
        command: 'superadmin:create',
        osUser: deps.operator.osUser,
        host: deps.operator.host,
        forceAdditional: input.forceAdditional,
        liveSuperadminsBefore: live,
        inviteExpiresAt: expiresAt.toISOString(),
      },
    });
    return user.id;
  });

  const inviteUrl = `${deps.adminUrl.replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;
  return { userId, inviteUrl, expiresAt };
}

function operator(): { osUser: string; host: string } {
  let osUser = 'unknown';
  try {
    osUser = userInfo().username;
  } catch {
    // Containers without a passwd entry.
  }
  return { osUser, host: hostname() };
}

async function main(argv: readonly string[]): Promise<void> {
  const input = parseArgs(argv);
  const config = loadConfigFromProcess();
  const logger = createLogger(config);
  const database = createDatabase(config, logger);
  try {
    await database.connect();
    const result = await createSuperadmin(
      {
        db: database.client,
        logger,
        clock: () => new Date(),
        adminUrl: config.adminUrl,
        superadminMax: config.auth.superadminMax,
        tokenPepper: config.auth.refresh.pepper,
        operator: operator(),
      },
      input,
    );
    // Printed ONCE, to the operator's terminal only (never logged).
    process.stdout.write(
      `Superadmin invited (user ${result.userId}).\n` +
        `Accept-invite URL (valid until ${result.expiresAt.toISOString()}, shown once):\n` +
        `${result.inviteUrl}\n`,
    );
  } finally {
    await database.disconnect();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
