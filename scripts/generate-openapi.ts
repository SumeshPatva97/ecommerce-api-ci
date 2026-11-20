/**
 * OpenAPI 3.1 generator (BACKEND_STRUCTURE.md §3 `scripts/generate-openapi.ts`, OQ-49 working
 * assumption "generated from Zod"). Builds every registered module with an inert container (no DB
 * connection, no network), walks the Express route tables and emits `docs/openapi/openapi.json`:
 *
 * - paths + methods exactly as mounted (`:id` → `{id}`),
 * - security per audience (storefront/admin bearer; optional auth noted),
 * - `x-permissions`, `x-reauth`, `x-idempotency`, `x-rate-class` from the route guards,
 * - request parameters and bodies from each route's `validate()` Zod schemas (`z.toJSONSchema`).
 *
 * Responses: the success status(es) each route declares with `respondsWith(...)` (default `200`,
 * RD-13 option B) with the canonical success envelope, plus the ERROR responses each route's
 * guards can actually produce (`errorResponsesFor`: validation 422/400, auth 401, permission or
 * re-auth 403, idempotency 409, rate limit 429, path resource 404, webhook signature 401), each
 * listing its canonical codes in `x-error-codes`. Service-specific errors (409 state/stock, 422
 * coupon, 503 gateway) remain under `default`. Per-route `data` shapes are documented in
 * API_DOCUMENTATION.md; typed `data` schemas are not modelled yet (OQ-49 publication contract).
 * File downloads (WP10-4): the operations listed in `FILE_DOWNLOADS` document the media type(s)
 * their handler actually sends on `200` instead of the JSON envelope (a queued report export keeps
 * its `202` JSON envelope).
 *
 * Usage: npx tsx scripts/generate-openapi.ts [--check]
 *   --check exits 1 when the committed file differs (CI drift guard).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Router } from 'express';
import { z } from 'zod';

import { createContainer } from '../src/container.js';
import { loadConfig } from '../src/core/config/index.js';
import type { DbClient } from '../src/core/db/transaction.js';
import { createLogger } from '../src/core/logger/logger.js';
import { AUTH_GUARD, PERMISSION_GUARD, REAUTH_GUARD } from '../src/core/middleware/auth.js';
import { IDEMPOTENCY_GUARD } from '../src/core/middleware/idempotency.js';
import { RATE_CLASS } from '../src/core/middleware/routeRateLimit.js';
import { VALIDATION_SCHEMAS, type ValidationSchemas } from '../src/core/middleware/validate.js';
import { SUCCESS_STATUS } from '../src/core/http/successStatus.js';
import { ERROR_HTTP_STATUS, type ErrorCode } from '../src/core/errors/errorCodes.js';
import { MODULE_FACTORIES } from '../src/modules/index.js';
import { buildModules } from '../src/routes/v1.js';

interface LayerLike {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: { stack?: LayerLike[] };
}

type Json = Record<string, unknown>;

interface Tags {
  [PERMISSION_GUARD]?: readonly string[];
  [REAUTH_GUARD]?: true;
  [AUTH_GUARD]?: { audience: 'storefront' | 'admin'; optional: boolean };
  [IDEMPOTENCY_GUARD]?: { required: boolean };
  [RATE_CLASS]?: string;
  [VALIDATION_SCHEMAS]?: ValidationSchemas;
  [SUCCESS_STATUS]?: readonly number[];
}

const ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_TIMEZONE: 'Asia/Kolkata',
  TZ: 'UTC',
  API_BASE_URL: 'https://api.example.com',
  STOREFRONT_URL: 'https://www.example.com',
  ADMIN_URL: 'https://admin.example.com',
  CORS_ORIGINS: 'https://www.example.com,https://admin.example.com',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'mysql://openapi:placeholder@localhost:3306/none',
};

/** Inert DB: any access throws, proving generation never queries. */
const inertDb = new Proxy({} as DbClient, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    throw new Error(`OpenAPI generation must not touch the database (db.${String(prop)}).`);
  },
});

function toSchema(schema: z.ZodType): Json {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { description: 'Schema not representable in JSON Schema.' };
  }
}

function toParameters(schema: z.ZodType | undefined, location: 'path' | 'query'): Json[] {
  if (schema === undefined) return [];
  const json = toSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, Json>;
  const required = new Set((json.required ?? []) as string[]);
  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: propSchema,
  }));
}

const envelope = {
  ok: { $ref: '#/components/schemas/SuccessEnvelope' },
  error: { $ref: '#/components/schemas/ErrorEnvelope' },
};

const csvFile: Json = { schema: { type: 'string' } };
const binaryFile: Json = { schema: { type: 'string', format: 'binary' } };

/**
 * WP10-4: operations whose `200` response is a file, keyed by `<method> <path>`, with the media
 * types the route handler sets (verified against the route code: `audit.routes.ts`,
 * `barcodes.routes.ts`, `orders.routes.ts` `sendPdf`, `reports.routes.ts` + `CONTENT_TYPES` in
 * `src/lib/export/types.ts`). Documentation only; runtime behaviour is unchanged.
 */
export const FILE_DOWNLOADS: Readonly<Record<string, Readonly<Record<string, Json>>>> = {
  'post /api/v1/admin/audit-logs/export': { 'text/csv': csvFile },
  'post /api/v1/admin/barcodes/labels': { 'application/pdf': binaryFile },
  'get /api/v1/admin/orders/{orderId}/invoice': { 'application/pdf': binaryFile },
  'get /api/v1/me/orders/{orderNumber}/invoice': { 'application/pdf': binaryFile },
  'post /api/v1/admin/reports/{reportKey}/export': {
    'text/csv': csvFile,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': binaryFile,
    'application/pdf': binaryFile,
  },
};

const SUCCESS_DESCRIPTIONS: Readonly<Record<number, string>> = {
  200: 'Success',
  201: 'Created',
  202: 'Accepted',
};

const ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '400': 'Malformed request',
  '401': 'Not authenticated',
  '403': 'Not allowed',
  '404': 'Resource not found',
  '409': 'Conflict',
  '422': 'Validation failed',
  '429': 'Rate limited',
};

/**
 * Error responses a route's guards can produce, keyed by HTTP status (derived only from the guard
 * markers and path parameters, never guessed from the handler).
 */
export function errorResponsesFor(
  family: 'public' | 'admin' | 'webhook',
  merged: Tags,
  hasPathParams: boolean,
  authRequired: boolean,
): Json {
  const codes = new Map<string, Set<ErrorCode>>();
  const add = (...list: ErrorCode[]): void => {
    for (const code of list) {
      const status = String(ERROR_HTTP_STATUS[code]);
      const set = codes.get(status) ?? new Set<ErrorCode>();
      set.add(code);
      codes.set(status, set);
    }
  };
  const schemas = merged[VALIDATION_SCHEMAS];
  if (family === 'webhook') add('UNAUTHENTICATED', 'BAD_REQUEST');
  if (schemas !== undefined) add('VALIDATION_ERROR');
  if (schemas?.body !== undefined) add('BAD_REQUEST');
  if (authRequired) add('UNAUTHENTICATED', 'TOKEN_EXPIRED');
  if ((merged[PERMISSION_GUARD]?.length ?? 0) > 0) add('PERMISSION_DENIED');
  if (merged[REAUTH_GUARD] === true) add('REAUTH_REQUIRED');
  const idempotency = merged[IDEMPOTENCY_GUARD];
  if (idempotency !== undefined) {
    add('IDEMPOTENCY_CONFLICT', 'VALIDATION_ERROR');
    if (idempotency.required) add('BAD_REQUEST');
  }
  if (merged[RATE_CLASS] !== undefined) add('RATE_LIMITED');
  if (hasPathParams) add('NOT_FOUND');
  return Object.fromEntries(
    [...codes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, set]) => [
        status,
        {
          description: `${ERROR_DESCRIPTIONS[status] ?? 'Error'} (${[...set].sort().join(', ')})`,
          'x-error-codes': [...set].sort(),
          content: { 'application/json': { schema: envelope.error } },
        },
      ]),
  );
}

function operationFor(
  method: string,
  fullPath: string,
  family: 'public' | 'admin' | 'webhook',
  module: string,
  handles: Tags[],
  /** Admin routes mounted before authentication (login, refresh, invite, MFA challenge). */
  adminPublic = false,
): Json {
  const merged: Tags = Object.assign({}, ...handles) as Tags;
  const permissions = handles.flatMap((h) => h[PERMISSION_GUARD] ?? []);
  const auth =
    family === 'admin'
      ? adminPublic
        ? undefined
        : { audience: 'admin' as const, optional: false }
      : merged[AUTH_GUARD];
  const schemas = merged[VALIDATION_SCHEMAS] ?? {};
  const pathParams = [...fullPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '');
  const params = [...toParameters(schemas.params, 'path'), ...toParameters(schemas.query, 'query')];
  for (const name of pathParams) {
    if (!params.some((p) => p.name === name && p.in === 'path')) {
      params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
  }
  const idempotency = merged[IDEMPOTENCY_GUARD];
  if (idempotency !== undefined) {
    params.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: idempotency.required,
      schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$|^[0-9a-fA-F-]{36}$' },
    });
  }
  const download = FILE_DOWNLOADS[`${method} ${fullPath}`];
  const op: Json = {
    operationId: `${method}${fullPath.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ?? '').toUpperCase())}`,
    tags: [module],
    ...(params.length > 0 ? { parameters: params } : {}),
    responses: {
      // RD-13 option B: exactly the statuses declared with respondsWith(...) (default 200).
      ...Object.fromEntries(
        (merged[SUCCESS_STATUS] ?? [200]).map((code) => [
          String(code),
          code === 200 && download !== undefined
            ? {
                description: 'Success (file download, `Content-Disposition: attachment`)',
                content: download,
              }
            : {
                description: SUCCESS_DESCRIPTIONS[code] ?? 'Success',
                content: { 'application/json': { schema: envelope.ok } },
              },
        ]),
      ),
      ...errorResponsesFor(
        family,
        merged,
        pathParams.length > 0,
        auth !== undefined && !auth.optional,
      ),
      default: {
        description: 'Error',
        content: { 'application/json': { schema: envelope.error } },
      },
    },
  };
  if (schemas.body !== undefined) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: toSchema(schemas.body) } },
    };
  }
  if (family === 'webhook') {
    op.security = [];
    op['x-signature-verified'] = true;
  } else if (auth !== undefined) {
    const scheme = auth.audience === 'admin' ? 'adminBearer' : 'storefrontBearer';
    op.security = auth.optional ? [{}, { [scheme]: [] }] : [{ [scheme]: [] }];
  } else {
    op.security = [];
  }
  if (permissions.length > 0) op['x-permissions'] = permissions;
  if (merged[REAUTH_GUARD] === true) op['x-reauth'] = true;
  if (merged[RATE_CLASS] !== undefined) op['x-rate-class'] = merged[RATE_CLASS];
  return op;
}

function walk(
  router: Router,
  visit: (method: string, path: string, handles: Tags[]) => void,
): void {
  const go = (stack: LayerLike[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        const handles = layer.route.stack.map((l) => l.handle as Tags);
        for (const method of Object.keys(layer.route.methods))
          visit(method, layer.route.path, handles);
      } else if (layer.handle?.stack) {
        go(layer.handle.stack);
      }
    }
  };
  go((router as unknown as { stack: LayerLike[] }).stack);
}

export function generateOpenApi(): Json {
  const config = loadConfig(ENV);
  const container = createContainer(config, createLogger(config), inertDb);
  const modules = buildModules(container, MODULE_FACTORIES);
  const paths: Record<string, Record<string, Json>> = {};
  let count = 0;

  for (const module of modules) {
    const families = [
      ['admin', '/api/v1/admin', module.adminPublicRouter, true],
      ['admin', '/api/v1/admin', module.adminRouter, false],
      ['public', '/api/v1', module.publicRouter, false],
      ['webhook', '/api/v1/webhooks', module.webhookRouter, false],
    ] as const;
    for (const [family, prefix, router, adminPublic] of families) {
      if (router === undefined) continue;
      walk(router, (method, path, handles) => {
        const fullPath = `${prefix}${path}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        const op = operationFor(method, fullPath, family, module.name, handles, adminPublic);
        paths[fullPath] ??= {};
        paths[fullPath][method] = op;
        count += 1;
      });
    }
  }

  // Health probes live outside /api/v1 and outside the module system (B0-a).
  for (const [path, summary] of [
    ['/health/live', 'Liveness probe'],
    ['/health/ready', 'Readiness probe (database check)'],
  ] as const) {
    paths[path] = {
      get: {
        operationId: path === '/health/live' ? 'getHealthLive' : 'getHealthReady',
        tags: ['health'],
        summary,
        security: [],
        responses: {
          '200': {
            description: 'Healthy',
            content: { 'application/json': { schema: envelope.ok } },
          },
          '503': {
            description: 'Not ready',
            content: { 'application/json': { schema: envelope.error } },
          },
        },
      },
    };
    count += 1;
  }

  const sortedPaths = Object.fromEntries(
    Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    openapi: '3.1.0',
    info: {
      title: '[BRAND_NAME] E-commerce API',
      version: '0.2.0',
      description:
        'GENERATED by scripts/generate-openapi.ts from the mounted route tables and Zod request schemas. ' +
        'Do not edit by hand. Response `data` shapes: see project-documentation/04-backend/API_DOCUMENTATION.md. ' +
        `Operations: ${String(count)}.`,
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    components: {
      securitySchemes: {
        storefrontBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT (EdDSA, aud=storefront)',
        },
        adminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT (EdDSA, aud=admin)' },
      },
      schemas: {
        SuccessEnvelope: {
          type: 'object',
          required: ['success', 'data', 'requestId'],
          properties: {
            success: { const: true },
            data: {},
            meta: { type: 'object' },
            requestId: { type: 'string' },
          },
        },
        ErrorEnvelope: {
          type: 'object',
          required: ['success', 'error', 'requestId'],
          properties: {
            success: { const: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: Object.keys(ERROR_HTTP_STATUS) },
                message: { type: 'string' },
                details: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string' },
                      code: { type: 'string' },
                      message: { type: 'string' },
                      meta: { type: 'object' },
                    },
                  },
                },
              },
            },
            requestId: { type: 'string' },
          },
        },
      },
    },
    paths: sortedPaths,
  };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]).endsWith('generate-openapi.ts');
if (isMain) {
  const target = resolve(process.cwd(), 'docs/openapi/openapi.json');
  const output = `${JSON.stringify(generateOpenApi(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8');
    if (current !== output) {
      process.stderr.write(
        'docs/openapi/openapi.json is out of date — run: npx tsx scripts/generate-openapi.ts\n',
      );
      process.exit(1);
    }
    process.stdout.write('openapi.json is up to date\n');
  } else {
    writeFileSync(target, output);
    process.stdout.write(`wrote ${target}\n`);
  }
}
