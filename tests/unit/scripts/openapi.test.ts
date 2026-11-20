/**
 * OpenAPI generator: guard-derived error responses. Builds the route tables with an inert container
 * (no DB, no network).
 */
import { describe, expect, it } from 'vitest';

import {
  FILE_DOWNLOADS,
  errorResponsesFor,
  generateOpenApi,
} from '../../../scripts/generate-openapi.js';
import { ERROR_HTTP_STATUS } from '../../../src/core/errors/errorCodes.js';
import { AUTH_GUARD, PERMISSION_GUARD, REAUTH_GUARD } from '../../../src/core/middleware/auth.js';
import { IDEMPOTENCY_GUARD } from '../../../src/core/middleware/idempotency.js';
import { RATE_CLASS } from '../../../src/core/middleware/routeRateLimit.js';

type Responses = Record<
  string,
  { 'x-error-codes'?: string[]; content?: Record<string, { schema?: unknown }> }
>;
interface Op {
  responses: Responses;
  security: Record<string, unknown>[];
  'x-permissions'?: string[];
  'x-reauth'?: boolean;
}

const codesOf = (responses: Responses, status: string) => responses[status]?.['x-error-codes'];

describe('errorResponsesFor', () => {
  it('maps each guard to its canonical status and codes, and nothing else', () => {
    const responses = errorResponsesFor(
      'admin',
      {
        [PERMISSION_GUARD]: ['refunds.approve'],
        [REAUTH_GUARD]: true,
        [IDEMPOTENCY_GUARD]: { required: true },
        [RATE_CLASS]: 'admin-write',
      },
      true,
      true,
    ) as Responses;
    expect(Object.keys(responses)).toEqual(['400', '401', '403', '404', '409', '422', '429']);
    expect(codesOf(responses, '401')).toEqual(['TOKEN_EXPIRED', 'UNAUTHENTICATED']);
    expect(codesOf(responses, '403')).toEqual(['PERMISSION_DENIED', 'REAUTH_REQUIRED']);
    expect(codesOf(responses, '409')).toEqual(['IDEMPOTENCY_CONFLICT']);
  });

  it('lists no error responses for an unguarded public route without parameters', () => {
    expect(errorResponsesFor('public', {}, false, false)).toEqual({});
    expect(
      errorResponsesFor(
        'public',
        { [AUTH_GUARD]: { audience: 'storefront', optional: true } },
        false,
        false,
      ),
    ).toEqual({});
  });
});

describe('generated document', () => {
  const doc = generateOpenApi() as {
    paths: Record<string, Record<string, Op>>;
    components: {
      schemas: {
        ErrorEnvelope: { properties: { error: { properties: { code: { enum: string[] } } } } };
      };
    };
  };
  const ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method, op })),
  );

  it('documents the error responses implied by every guard', () => {
    expect(ops).toHaveLength(248);
    for (const { path, method, op } of ops) {
      const where = `${method.toUpperCase()} ${path}`;
      if ((op['x-permissions']?.length ?? 0) > 0) {
        expect(codesOf(op.responses, '403'), where).toContain('PERMISSION_DENIED');
      }
      if (op['x-reauth'] === true) {
        expect(codesOf(op.responses, '403'), where).toContain('REAUTH_REQUIRED');
      }
      const bearerRequired =
        op.security.length > 0 && !op.security.some((s) => Object.keys(s).length === 0);
      if (bearerRequired) expect(codesOf(op.responses, '401'), where).toContain('UNAUTHENTICATED');
      if (path.startsWith('/api/v1/webhooks')) {
        expect(codesOf(op.responses, '401'), where).toContain('UNAUTHENTICATED');
      }
      if (path.includes('{')) expect(codesOf(op.responses, '404'), where).toEqual(['NOT_FOUND']);
      // Health probes document 200/503 only; every API operation keeps the generic `default`.
      if (path.startsWith('/api/v1')) expect(op.responses.default, where).toBeDefined();
    }
  });

  it('never documents a bearer 401 on admin routes that are mounted before authentication', () => {
    const login = doc.paths['/api/v1/admin/auth/login']?.post;
    expect(login?.security).toEqual([]);
    expect(login?.responses['401']).toBeUndefined();
  });

  it('documents the success statuses each route declares with respondsWith (RD-13 B)', () => {
    const success = (path: string, method: string) =>
      Object.keys(doc.paths[path]?.[method]?.responses ?? {}).filter((code) =>
        code.startsWith('2'),
      );
    expect(success('/api/v1/checkout/orders', 'post')).toEqual(['201']);
    expect(success('/api/v1/auth/register', 'post')).toEqual(['202']);
    expect(success('/api/v1/admin/reports/{reportKey}/export', 'post')).toEqual(['200', '202']);
    expect(success('/api/v1/admin/products/{productId}/variants/generate', 'post')).toEqual([
      '200',
      '201',
    ]);
    expect(success('/api/v1/admin/notifications/{notificationId}/resend', 'post')).toEqual([
      '200',
      '201',
    ]);
    expect(success('/api/v1/cart', 'get')).toEqual(['200']);
    const nonDefault = ops.filter(({ op }) =>
      Object.keys(op.responses).some((c) => /^20[12]$/.test(c)),
    );
    expect(nonDefault).toHaveLength(36);
  });

  it('WP10-4: documents the real 200 media types of the five file downloads', () => {
    const mediaTypes = (path: string, method: string, status: string) =>
      Object.keys(doc.paths[path]?.[method]?.responses[status]?.content ?? {});
    expect(mediaTypes('/api/v1/admin/audit-logs/export', 'post', '200')).toEqual(['text/csv']);
    expect(mediaTypes('/api/v1/admin/barcodes/labels', 'post', '200')).toEqual(['application/pdf']);
    expect(mediaTypes('/api/v1/admin/orders/{orderId}/invoice', 'get', '200')).toEqual([
      'application/pdf',
    ]);
    expect(mediaTypes('/api/v1/me/orders/{orderNumber}/invoice', 'get', '200')).toEqual([
      'application/pdf',
    ]);
    expect(mediaTypes('/api/v1/admin/reports/{reportKey}/export', 'post', '200')).toEqual([
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/pdf',
    ]);
    // A queued report export still answers 202 with the JSON success envelope.
    const queued = doc.paths['/api/v1/admin/reports/{reportKey}/export']?.post?.responses['202'];
    expect(queued?.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/SuccessEnvelope' } },
    });
    // Binary bodies are typed as binary strings; CSV as text.
    expect(
      doc.paths['/api/v1/admin/barcodes/labels']?.post?.responses['200']?.content?.[
        'application/pdf'
      ]?.schema,
    ).toEqual({ type: 'string', format: 'binary' });
    expect(
      doc.paths['/api/v1/admin/audit-logs/export']?.post?.responses['200']?.content?.['text/csv']
        ?.schema,
    ).toEqual({ type: 'string' });
  });

  it('WP10-4: every FILE_DOWNLOADS key is a real operation; all other 200s stay JSON', () => {
    expect(Object.keys(FILE_DOWNLOADS)).toHaveLength(5);
    for (const key of Object.keys(FILE_DOWNLOADS)) {
      const [method = '', path = ''] = key.split(' ');
      expect(doc.paths[path]?.[method], key).toBeDefined();
    }
    // The report-export status poll returns JSON (not a file).
    expect(
      Object.keys(
        doc.paths['/api/v1/admin/report-exports/{exportId}']?.get?.responses['200']?.content ?? {},
      ),
    ).toEqual(['application/json']);
    // Known, outside the WP10-4 list of five: the barcode image (image/png | image/svg+xml) is
    // still documented as JSON. Excluded here so this guard does not pin that inaccuracy.
    const outOfScope = new Set(['get /api/v1/admin/product-variants/{variantId}/barcode']);
    const others = ops.filter(
      ({ path, method, op }) =>
        path.startsWith('/api/v1') &&
        op.responses['200'] !== undefined &&
        FILE_DOWNLOADS[`${method} ${path}`] === undefined &&
        !outOfScope.has(`${method} ${path}`),
    );
    for (const { path, method, op } of others) {
      expect(Object.keys(op.responses['200']?.content ?? {}), `${method} ${path}`).toEqual([
        'application/json',
      ]);
    }
  });

  it('constrains the error code to the canonical list', () => {
    expect(doc.components.schemas.ErrorEnvelope.properties.error.properties.code.enum).toEqual(
      Object.keys(ERROR_HTTP_STATUS),
    );
  });
});
