/**
 * Process start-up refusal (security control PW-08 / finding A9-F02): a configuration the
 * container refuses stops the API and the worker with exit code 1. MOCKED database client (no
 * connection); `process.exit` is intercepted. It does NOT prove behaviour of a real process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as LoggerModule from '../../src/core/logger/logger.js';
import { createMockDb } from '../helpers/mockDb.js';
import { PRODUCTION_SECRETS, testConfig } from '../helpers/testApp.js';

const fatalLines: Record<string, unknown>[] = [];

vi.mock('../../src/core/db/prisma.js', () => ({
  createDatabase: () => ({
    client: createMockDb().db,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    ping: () => Promise.resolve(),
  }),
}));

vi.mock('../../src/core/logger/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof LoggerModule>();
  return {
    ...original,
    // Same logger, but writing to memory at `fatal` level so the refusal line can be asserted.
    createLogger: (config: Parameters<typeof original.createLogger>[0]) =>
      original.createLogger(
        { ...config, log: { level: 'fatal', pretty: false } },
        {
          write: (line: string) => {
            fatalLines.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      ),
  };
});

const { createProcessRuntime } = await import('../../src/bootstrap.js');

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const STRICT_ENV: Readonly<Record<string, string>> = {
  ...PRODUCTION_SECRETS,
  API_BASE_URL: 'https://api.example.com',
  STOREFRONT_URL: 'https://www.example.com',
  ADMIN_URL: 'https://admin.example.com',
  CORS_ORIGINS: 'https://www.example.com,https://admin.example.com',
};

function interceptExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
}

describe('createProcessRuntime — start-up refusal (PW-08)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fatalLines.length = 0;
  });

  it.each(['api', 'worker'] as const)(
    '%s: production with the mock payment provider exits with code 1 and names the variable only',
    (role) => {
      const exit = interceptExit();
      const config = testConfig({ ...STRICT_ENV, NODE_ENV: 'production' });

      let thrown: unknown;
      try {
        createProcessRuntime(config, role);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExitCalled);
      expect((thrown as ExitCalled).code).toBe(1);
      expect(exit).toHaveBeenCalledTimes(1);

      expect(fatalLines).toHaveLength(1);
      expect(fatalLines[0]).toMatchObject({
        process: role,
        msg: 'start-up refused: invalid configuration',
        problems: ['PAYMENT_PROVIDER: the mock payment provider cannot run in production.'],
      });
      const line = JSON.stringify(fatalLines[0]);
      for (const secret of Object.values(PRODUCTION_SECRETS)) expect(line).not.toContain(secret);
      expect(line).not.toMatch(/https?:\/\/|mysql:\/\//);
    },
  );

  it.each([
    ['test', { NODE_ENV: 'test' }],
    ['development', { NODE_ENV: 'development' }],
    ['staging', { ...STRICT_ENV, NODE_ENV: 'staging' }],
  ])('%s: the runtime is created and the process is not stopped', (_nodeEnv, env) => {
    const exit = interceptExit();
    const runtime = createProcessRuntime(testConfig(env), 'api');
    expect(runtime.container.providers.payment.name).toBe('mock');
    expect(exit).not.toHaveBeenCalled();
    expect(fatalLines).toHaveLength(0);
  });
});
