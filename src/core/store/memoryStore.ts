/**
 * Small TTL key-value store standing in for Redis while Redis is deferred (D-38 / OQ-35).
 * Used for re-auth markers (`reauth:{sid}`), MFA challenges, OTP cooldowns and the
 * effective-permission cache.
 *
 * LIMITATION — in-memory: valid for ONE local instance only. Not suitable for multi-instance
 * production (state is per process and lost on restart). Must be replaced by Redis before any
 * multi-instance deployment (same interface).
 */
export interface KeyValueStore {
  /** Callers narrow the value (stored values are written by the same module). */
  get(key: string): unknown;
  set(key: string, value: unknown, ttlSeconds: number): void;
  delete(key: string): void;
  deleteByPrefix(prefix: string): void;
  /** Atomically increments a counter that expires `ttlSeconds` after first creation. */
  increment(key: string, ttlSeconds: number): number;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export function createMemoryStore(
  now: () => number = Date.now,
  maxEntries = 50_000,
): KeyValueStore {
  const map = new Map<string, Entry>();

  const live = (key: string): Entry | undefined => {
    const entry = map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  };

  const evictIfFull = (): void => {
    if (map.size < maxEntries) return;
    const t = now();
    for (const [key, entry] of map) if (entry.expiresAt <= t) map.delete(key);
    // Still full: drop the oldest insertion (Map preserves insertion order).
    while (map.size >= maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done === true) break;
      map.delete(oldest.value);
    }
  };

  return {
    get(key: string): unknown {
      return live(key)?.value;
    },
    set(key, value, ttlSeconds) {
      evictIfFull();
      map.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    delete(key) {
      map.delete(key);
    },
    deleteByPrefix(prefix) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    },
    increment(key, ttlSeconds) {
      const entry = live(key);
      if (entry === undefined) {
        evictIfFull();
        map.set(key, { value: 1, expiresAt: now() + ttlSeconds * 1000 });
        return 1;
      }
      const next = (typeof entry.value === 'number' ? entry.value : 0) + 1;
      entry.value = next;
      return next;
    },
  };
}
