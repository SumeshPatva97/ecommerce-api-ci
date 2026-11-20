/**
 * Idempotency-Key middleware — BACKEND_STRUCTURE.md §11, PROJECT_CONTEXT §15 R-18.
 *
 * Storage: `idempotency_keys` (unique `(owner_key, scope, idem_key)` — SQL-only generated
 * `owner_key = COALESCE(user_id,'ANONYMOUS')`). `response_ref` holds `{ status, body }`.
 *
 * | Case                                   | Result |
 * | first request                          | row IN_PROGRESS → handler → COMPLETED with stored response |
 * | replay, same hash, COMPLETED           | stored status/body + `Idempotent-Replayed: true` |
 * | replay, same hash, IN_PROGRESS         | 409 IDEMPOTENCY_CONFLICT (`IN_PROGRESS`), `Retry-After: 2` |
 * | same key, different hash               | 409 IDEMPOTENCY_CONFLICT (`PAYLOAD_MISMATCH`) |
 * | handler 5xx                            | row deleted (client may retry with same key) |
 * | 4xx                                    | stored (deterministic) |
 * | header missing on a required route     | 400 BAD_REQUEST |
 */
import { createHash } from 'node:crypto';

import type { RequestHandler, Response } from 'express';

import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../errors/AppError.js';
import { isPrismaKnownError } from '../errors/prismaErrorMapper.js';
import type { DbClient } from '../db/transaction.js';
import type { Logger } from '../logger/logger.js';

const KEY_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{16,64})$/i;
const TTL_MS = 24 * 60 * 60 * 1000;

/** Marker read by the OpenAPI generator. */
export const IDEMPOTENCY_GUARD = Symbol.for('ecommerce.idempotencyGuard');

/** Canonical JSON (sorted keys) so semantically equal bodies hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return value === undefined ? 'null' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${path}\n${canonicalJson(body ?? {})}`)
    .digest('hex');
}

interface StoredResponse {
  status: number;
  body: unknown;
}

function isStoredResponse(value: unknown): value is StoredResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof value.status === 'number'
  );
}

export interface IdempotencyOptions {
  readonly required: boolean;
  /** Logical operation name; defaults to `METHOD baseUrl+route.path`. */
  readonly scope?: string;
}

export type IdempotencyFactory = (options: IdempotencyOptions) => RequestHandler;

export function createIdempotency(deps: {
  db: DbClient;
  logger: Logger;
  clock: () => Date;
}): IdempotencyFactory {
  const { db, logger, clock } = deps;

  const build =
    (options: IdempotencyOptions): RequestHandler =>
    (req, res, next) => {
      const key = req.get('idempotency-key');
      if (key === undefined || key.trim() === '') {
        if (options.required) {
          next(new AppError('BAD_REQUEST', 'Idempotency-Key header is required.'));
          return;
        }
        next();
        return;
      }
      if (!KEY_PATTERN.test(key)) {
        next(
          new AppError('VALIDATION_ERROR', undefined, {
            details: [
              {
                field: 'Idempotency-Key',
                message: 'Must be a UUID v4 or 16–64 characters [A-Za-z0-9_-].',
              },
            ],
          }),
        );
        return;
      }
      const userId = req.authz?.userId ?? null;
      const route: unknown = req.route;
      const routePath =
        typeof route === 'object' &&
        route !== null &&
        'path' in route &&
        typeof route.path === 'string'
          ? route.path
          : req.path;
      const scope = (options.scope ?? `${req.method} ${req.baseUrl}${routePath}`).slice(0, 80);
      const hash = requestHash(req.method, req.originalUrl.split('?')[0] ?? '', req.body);

      const start = async (): Promise<'proceed' | 'handled'> => {
        try {
          const created = await db.idempotencyKey.create({
            data: {
              scope,
              idemKey: key,
              userId,
              requestHash: hash,
              status: 'IN_PROGRESS',
              expiresAt: new Date(clock().getTime() + TTL_MS),
            },
            select: { id: true },
          });
          attachCompletion(res, created.id);
          return 'proceed';
        } catch (error) {
          if (!(isPrismaKnownError(error) && error.code === 'P2002')) throw error;
        }
        const existing = await db.idempotencyKey.findFirst({
          where: { scope, idemKey: key, userId },
          select: { requestHash: true, status: true, responseRef: true },
        });
        if (existing === null) {
          throw new AppError('IDEMPOTENCY_CONFLICT', undefined, {
            details: [{ code: 'IN_PROGRESS', message: 'Retry shortly.' }],
            headers: { 'Retry-After': '2' },
          });
        }
        if (existing.requestHash !== hash) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key was used with a different request.',
            {
              details: [
                {
                  code: 'PAYLOAD_MISMATCH',
                  message: 'Use a new Idempotency-Key for a different request.',
                },
              ],
            },
          );
        }
        if (existing.status === 'COMPLETED' && isStoredResponse(existing.responseRef)) {
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(existing.responseRef.status).json(existing.responseRef.body);
          return 'handled';
        }
        throw new AppError('IDEMPOTENCY_CONFLICT', undefined, {
          details: [
            { code: 'IN_PROGRESS', message: 'The original request is still being processed.' },
          ],
          headers: { 'Retry-After': '2' },
        });
      };

      const attachCompletion = (response: Response, rowId: string): void => {
        const originalJson = response.json.bind(response);
        response.json = (body: unknown) => {
          const status = response.statusCode;
          const persist =
            status >= 500
              ? db.idempotencyKey.delete({ where: { id: rowId } })
              : db.idempotencyKey.update({
                  where: { id: rowId },
                  data: {
                    status: 'COMPLETED',
                    responseRef: { status, body } as Prisma.InputJsonValue,
                  },
                });
          persist.catch((error: unknown) => {
            logger.error({ err: error }, 'idempotency record update failed');
          });
          return originalJson(body);
        };
      };

      start().then((outcome) => {
        if (outcome === 'proceed') next();
      }, next);
    };

  return (options) =>
    Object.assign(build(options), { [IDEMPOTENCY_GUARD]: { required: options.required } });
}
