import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../../../src/core/errors/AppError.js';
import { ERROR_HTTP_STATUS } from '../../../src/core/errors/errorCodes.js';
import {
  buildPageMeta,
  PAGE_LIMITS,
  paginationQuery,
  toSkipTake,
} from '../../../src/core/http/pagination.js';
import { truncateIp } from '../../../src/core/middleware/accessLog.js';
import { toAppError } from '../../../src/core/middleware/errorHandler.js';
import { INBOUND_REQUEST_ID, generateRequestId } from '../../../src/core/middleware/requestId.js';
import { formatIssuePath, zodIssuesToDetails } from '../../../src/core/middleware/validate.js';
import { ulid } from '../../../src/lib/ulid.js';

describe('AppError', () => {
  it('derives the HTTP status from the canonical code', () => {
    for (const [code, status] of Object.entries(ERROR_HTTP_STATUS)) {
      expect(new AppError(code as keyof typeof ERROR_HTTP_STATUS).httpStatus).toBe(status);
    }
  });

  it('uses a safe default message unless one is given', () => {
    expect(new AppError('NOT_FOUND').message).toBe('The requested resource was not found.');
    expect(new AppError('NOT_FOUND', 'Order not found.').message).toBe('Order not found.');
  });
});

describe('toAppError', () => {
  it('passes AppError through unchanged', () => {
    const error = new AppError('CONFLICT');
    expect(toAppError(error)).toBe(error);
  });

  it('maps ZodError to VALIDATION_ERROR with field details', () => {
    const result = z.object({ name: z.string() }).safeParse({});
    if (result.success) throw new Error('expected failure');
    const mapped = toAppError(result.error);
    expect(mapped.code).toBe('VALIDATION_ERROR');
    expect(mapped.details?.[0]?.field).toBe('name');
  });

  it.each([
    ['entity.too.large', 'PAYLOAD_TOO_LARGE'],
    ['entity.parse.failed', 'BAD_REQUEST'],
    ['charset.unsupported', 'BAD_REQUEST'],
    ['encoding.unsupported', 'BAD_REQUEST'],
    ['request.aborted', 'BAD_REQUEST'],
    ['request.size.invalid', 'BAD_REQUEST'],
    ['something.else', 'INTERNAL_ERROR'],
  ])('maps body-parser error %s to %s', (type, code) => {
    expect(toAppError(Object.assign(new Error('x'), { type })).code).toBe(code);
  });

  it('maps anything unknown to a generic INTERNAL_ERROR', () => {
    const mapped = toAppError(new Error('connection string mysql://user:pw@host'));
    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.message).toBe('An unexpected error occurred.');
    expect(toAppError('plain string').code).toBe('INTERNAL_ERROR');
  });
});

describe('validation helpers', () => {
  it('formats issue paths with dot/bracket notation', () => {
    expect(formatIssuePath(['variants', 2, 'sku'])).toBe('variants[2].sku');
    expect(formatIssuePath([0, 'name'])).toBe('[0].name');
    expect(formatIssuePath([])).toBe('');
  });

  it('omits field for root-level issues', () => {
    const result = z.string().safeParse(5);
    if (result.success) throw new Error('expected failure');
    const [detail] = zodIssuesToDetails(result.error.issues);
    expect(detail).toBeDefined();
    expect(detail).not.toHaveProperty('field');
  });
});

describe('pagination', () => {
  it('applies the documented defaults and maximum', () => {
    expect(paginationQuery(PAGE_LIMITS.productListing).parse({})).toEqual({ page: 1, limit: 30 });
    expect(paginationQuery(PAGE_LIMITS.adminList).parse({})).toEqual({ page: 1, limit: 25 });
    expect(paginationQuery(25).parse({ page: '3', limit: '100' })).toEqual({ page: 3, limit: 100 });
    expect(paginationQuery(25).safeParse({ limit: '101' }).success).toBe(false);
    expect(paginationQuery(25).safeParse({ page: '0' }).success).toBe(false);
    expect(paginationQuery(25).safeParse({ page: '1.5' }).success).toBe(false);
  });

  it('builds meta for first, middle, last, beyond-last and empty pages', () => {
    expect(buildPageMeta(1, 30, 412)).toEqual({
      page: 1,
      limit: 30,
      totalItems: 412,
      totalPages: 14,
      hasNextPage: true,
      hasPrevPage: false,
    });
    expect(buildPageMeta(14, 30, 412)).toMatchObject({ hasNextPage: false, hasPrevPage: true });
    expect(buildPageMeta(20, 30, 412)).toMatchObject({ totalPages: 14, hasNextPage: false });
    expect(buildPageMeta(1, 25, 0)).toMatchObject({ totalPages: 0, hasNextPage: false });
  });

  it('converts page/limit to skip/take', () => {
    expect(toSkipTake(1, 30)).toEqual({ skip: 0, take: 30 });
    expect(toSkipTake(3, 25)).toEqual({ skip: 50, take: 25 });
  });
});

describe('request ids', () => {
  it('generates req_<ULID> ids that pass the inbound format check', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(INBOUND_REQUEST_ID.test(id)).toBe(true);
  });

  it('encodes the timestamp so ids sort by time', () => {
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
    expect(ulid(1_700_000_000_000) < ulid(1_800_000_000_000)).toBe(true);
    expect(new Set(Array.from({ length: 100 }, () => ulid(1))).size).toBe(100);
  });
});

describe('truncateIp', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0'],
    ['::ffff:198.51.100.9', '198.51.100.0'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8:0::'],
    ['::1', '0:0:0::'],
    ['fe80::1%eth0', 'fe80:0:0::'],
    ['2001:db8::', '2001:db8:0::'],
    ['1:2:3:4:5:6:7:8', '1:2:3::'],
    ['1::2::3', undefined],
    [undefined, undefined],
    ['', undefined],
    ['not-an-ip', undefined],
  ])('%s → %s', (input, expected) => {
    expect(truncateIp(input)).toBe(expected);
  });
});
