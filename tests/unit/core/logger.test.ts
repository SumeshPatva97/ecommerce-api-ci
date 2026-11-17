import { describe, expect, it } from 'vitest';

import { runWithRequestContext } from '../../../src/core/logger/context.js';
import {
  HEADER_REDACT_PATHS,
  REDACT_PATHS,
  SENSITIVE_KEYS,
  createLogger,
} from '../../../src/core/logger/logger.js';

/** Captures pino output synchronously through the optional destination stream. */
function captureLogger(level: 'info' | 'debug' = 'info') {
  const lines: string[] = [];
  const logger = createLogger(
    { appName: 'test', nodeEnv: 'test', log: { level, pretty: false } },
    { write: (chunk: string) => lines.push(chunk) },
  );
  const records = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

const KEYS = [...SENSITIVE_KEYS];

function firstRecord(list: Record<string, unknown>[]): Record<string, unknown> {
  const [first] = list;
  if (first === undefined) throw new Error('no log record was written');
  return first;
}

describe('redaction policy definition', () => {
  it('lists exactly the documented sensitive keys (BACKEND_STRUCTURE §20, DEVELOPMENT_GUIDELINES §8.6)', () => {
    expect(KEYS).toEqual([
      'password',
      'newPassword',
      'currentPassword',
      'passwordHash',
      'token',
      'accessToken',
      'refreshToken',
      'otp',
      'signature',
      'cardNumber',
      'cvv',
      'apiKey',
      'secret',
    ]);
  });

  it('builds root, one-level and two-level paths for every key, plus the header paths', () => {
    expect(HEADER_REDACT_PATHS).toEqual([
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ]);
    for (const key of KEYS) {
      expect(REDACT_PATHS).toEqual(expect.arrayContaining([key, `*.${key}`, `*.*.${key}`]));
    }
    expect(REDACT_PATHS).toHaveLength(HEADER_REDACT_PATHS.length + KEYS.length * 3);
  });
});

describe('sensitive keys are redacted at every supported depth', () => {
  it.each(KEYS)('"%s" at root level', (key) => {
    const { logger, lines, records } = captureLogger();
    const secret = `SECRET-ROOT-${key}`;
    logger.info({ [key]: secret, safeRoot: 'keep-root' }, 'probe');
    const record = firstRecord(records());
    expect(record[key]).toBe('[REDACTED]');
    expect(record.safeRoot).toBe('keep-root');
    expect(lines.join('')).not.toContain(secret);
  });

  it.each(KEYS)('"%s" one level below root', (key) => {
    const { logger, lines, records } = captureLogger();
    const secret = `SECRET-L1-${key}`;
    logger.info({ payload: { [key]: secret, email: 'visible@example.test' } }, 'probe');
    const payload = records()[0]?.payload as Record<string, unknown>;
    expect(payload[key]).toBe('[REDACTED]');
    expect(payload.email).toBe('visible@example.test');
    expect(lines.join('')).not.toContain(secret);
  });

  it.each(KEYS)('"%s" two levels below root', (key) => {
    const { logger, lines, records } = captureLogger();
    const secret = `SECRET-L2-${key}`;
    logger.info(
      { outer: { inner: { [key]: secret, id: 'keep-id' }, label: 'keep-label' } },
      'probe',
    );
    const outer = records()[0]?.outer as { inner: Record<string, unknown>; label: string };
    expect(outer.inner[key]).toBe('[REDACTED]');
    expect(outer.inner.id).toBe('keep-id');
    expect(outer.label).toBe('keep-label');
    expect(lines.join('')).not.toContain(secret);
  });

  it('array elements count as one level: items[0].<key> is redacted (two levels below root)', () => {
    const { logger, lines, records } = captureLogger();
    logger.info({ items: [{ token: 'SECRET-ARRAY', sku: 'SKU-1' }] }, 'probe');
    const items = records()[0]?.items as Record<string, unknown>[];
    expect(items[0]?.token).toBe('[REDACTED]');
    expect(items[0]?.sku).toBe('SKU-1');
    expect(lines.join('')).not.toContain('SECRET-ARRAY');
  });
});

describe('header redaction (unchanged)', () => {
  it('redacts Authorization and Cookie request headers and Set-Cookie response headers', () => {
    const { logger, lines, records } = captureLogger();
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer SECRET-ACCESS-TOKEN',
            cookie: 'sf_rt=SECRET-REFRESH',
            'user-agent': 'vitest',
          },
        },
        res: { headers: { 'set-cookie': 'adm_rt=SECRET-ADMIN-REFRESH; HttpOnly' } },
      },
      'probe',
    );
    const record = records()[0] as {
      req: { headers: Record<string, unknown> };
      res: { headers: Record<string, unknown> };
    };
    expect(record.req.headers.authorization).toBe('[REDACTED]');
    expect(record.req.headers.cookie).toBe('[REDACTED]');
    expect(record.req.headers['user-agent']).toBe('vitest');
    expect(record.res.headers['set-cookie']).toBe('[REDACTED]');
    expect(lines.join('')).not.toMatch(/SECRET-/);
  });
});

describe('mixed records', () => {
  it('redacts secrets at all three depths in one record and keeps every safe sibling', () => {
    const { logger, lines, records } = captureLogger();
    logger.info(
      {
        otp: '123456',
        userId: 'user-1',
        body: { email: 'a@example.test', password: 'SECRET-PW', newPassword: 'SECRET-NEW' },
        tokens: { accessToken: 'SECRET-AT', refreshToken: 'SECRET-RT', type: 'Bearer' },
        provider: {
          name: 'fake',
          credentials: { apiKey: 'SECRET-KEY', secret: 'SECRET-S', region: 'ap-south-1' },
        },
        payment: { card: { cardNumber: '4111111111111111', cvv: '987', brand: 'VISA' } },
        webhook: { signature: 'SECRET-SIG', eventId: 'evt_1' },
      },
      'probe',
    );
    const out = lines.join('');
    for (const leaked of ['SECRET-', '123456', '4111111111111111', '"987"']) {
      expect(out).not.toContain(leaked);
    }
    const r = records()[0] as {
      userId: string;
      body: { email: string };
      tokens: { type: string };
      provider: { name: string; credentials: { region: string } };
      payment: { card: { brand: string } };
      webhook: { eventId: string };
    };
    expect(r.userId).toBe('user-1');
    expect(r.body.email).toBe('a@example.test');
    expect(r.tokens.type).toBe('Bearer');
    expect(r.provider.name).toBe('fake');
    expect(r.provider.credentials.region).toBe('ap-south-1');
    expect(r.payment.card.brand).toBe('VISA');
    expect(r.webhook.eventId).toBe('evt_1');
  });

  it('does not mutate the object passed to the logger', () => {
    const { logger } = captureLogger();
    const original = { a: { b: { password: 'ORIGINAL' } }, password: 'ROOT-ORIGINAL' };
    logger.info(original, 'probe');
    expect(original.a.b.password).toBe('ORIGINAL');
    expect(original.password).toBe('ROOT-ORIGINAL');
  });

  it('handles non-object parents and null values safely', () => {
    const { logger, records } = captureLogger();
    logger.info({ a: 'plain', b: null, c: 5, password: null }, 'probe');
    const r = firstRecord(records());
    expect(r).toMatchObject({ a: 'plain', b: null, c: 5, password: '[REDACTED]' });
  });
});

describe('documented limitation — depth three and deeper is NOT protected', () => {
  it.each(KEYS)('"%s" three levels below root is not redacted', (key) => {
    const { logger, records } = captureLogger();
    logger.info({ l1: { l2: { l3: { [key]: 'DEPTH-3-VALUE' } } } }, 'probe');
    const record = records()[0] as { l1: { l2: { l3: Record<string, unknown> } } };
    expect(record.l1.l2.l3[key]).toBe('DEPTH-3-VALUE');
  });

  it('array nesting counts as a level: a.items[0].<key> (three levels) is not redacted', () => {
    const { logger, records } = captureLogger();
    logger.info({ a: { items: [{ password: 'DEPTH-3-ARRAY' }] } }, 'probe');
    const record = records()[0] as { a: { items: { password: string }[] } };
    expect(record.a.items[0]?.password).toBe('DEPTH-3-ARRAY');
  });

  it('key matching is exact and case-sensitive (e.g. "Password" is not redacted)', () => {
    const { logger, records } = captureLogger();
    logger.info({ Password: 'CASE-VALUE', user_password: 'SNAKE-VALUE' }, 'probe');
    const record = firstRecord(records());
    expect(record.Password).toBe('CASE-VALUE');
    expect(record.user_password).toBe('SNAKE-VALUE');
  });
});

describe('logger context and level', () => {
  it('adds the requestId inside a request context and omits it outside', () => {
    const { logger, records } = captureLogger();
    runWithRequestContext({ requestId: 'req_TESTCONTEXT01' }, () => {
      logger.info('inside');
    });
    logger.info('outside');
    expect(records()[0]?.requestId).toBe('req_TESTCONTEXT01');
    expect(records()[1]).not.toHaveProperty('requestId');
  });

  it('respects the configured level', () => {
    const { logger, lines } = captureLogger('info');
    logger.debug('hidden');
    logger.info('shown');
    expect(lines).toHaveLength(1);
  });
});
