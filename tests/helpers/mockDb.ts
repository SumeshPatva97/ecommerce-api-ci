/**
 * DB-free Prisma stand-in for unit and HTTP tests (no MySQL connection — the baseline is not
 * applied yet, G7/G8). Every `db.<model>.<method>` is an auto-created `vi.fn()` resolving to
 * `undefined` unless configured; `$transaction(fn)` runs `fn` with the same mock (interactive)
 * or awaits an array (batch).
 *
 * These are MOCKED tests: they verify service/controller logic and HTTP contracts, not SQL.
 *
 * Usage:
 *   const { db, m } = createMockDb();
 *   m.user.findUnique.mockResolvedValue({ id: 'u1', ... });
 *   expect(m.auditLog.create).toHaveBeenCalled();
 */
import { vi, type Mock } from 'vitest';

import type { DbClient } from '../../src/core/db/transaction.js';

type ModelKey = {
  [K in keyof DbClient]: K extends `$${string}` ? never : K extends string ? K : never;
}[keyof DbClient];

/** Every Prisma delegate method of a model, as a mock. */
export type ModelMocks<K extends ModelKey = ModelKey> = { [M in keyof DbClient[K]]: Mock };
export type MockModels = { [K in ModelKey]: ModelMocks<K> } & {
  $transaction: Mock;
  $queryRaw: Mock;
  $queryRawUnsafe: Mock;
  $executeRaw: Mock;
  $executeRawUnsafe: Mock;
};

export interface MockDb {
  /** Pass to services/containers. */
  readonly db: DbClient;
  /** Same object, typed as mocks for configuration and assertions. */
  readonly m: MockModels;
}

export function createMockDb(): MockDb {
  const models = new Map<string, Record<string, Mock>>();
  const special = new Map<string, Mock>();

  const modelProxy = (name: string): Record<string, Mock> => {
    const existing = models.get(name);
    if (existing) return existing;
    const methods = new Map<string, Mock>();
    const target = new Proxy({} as Record<string, Mock>, {
      get(_t, method: string | symbol) {
        if (typeof method !== 'string') return undefined;
        let fn = methods.get(method);
        if (fn === undefined) {
          fn = vi.fn().mockResolvedValue(undefined);
          methods.set(method, fn);
        }
        return fn;
      },
    });
    models.set(name, target);
    return target;
  };

  const specialFn = (name: string): Mock => {
    let fn = special.get(name);
    if (fn !== undefined) return fn;
    if (name === '$transaction') {
      fn = vi.fn(async (arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(proxy);
        if (Array.isArray(arg)) return Promise.all(arg);
        return undefined;
      });
    } else {
      fn = vi.fn().mockResolvedValue([]);
    }
    special.set(name, fn);
    return fn;
  };

  const proxy: MockModels = new Proxy({} as MockModels, {
    get(_t, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined; // not a thenable
      if (prop.startsWith('$')) return specialFn(prop);
      return modelProxy(prop);
    },
  });

  return { db: proxy as unknown as DbClient, m: proxy };
}
