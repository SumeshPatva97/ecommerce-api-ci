import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context (BACKEND_STRUCTURE.md §3 `core/logger/context.ts`). Later increments add
 * `actorId`, `accountType` and `ip` once authentication exists.
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
