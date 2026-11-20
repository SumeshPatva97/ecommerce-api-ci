/**
 * Review helpers — plain-text stripping, author display name, rating aggregates. MOCKED DB.
 */
import { describe, expect, it } from 'vitest';

import {
  authorName,
  recomputeProductRating,
  toPlainText,
} from '../../../../src/modules/reviews/index.js';
import { createMockDb } from '../../../helpers/mockDb.js';

describe('toPlainText', () => {
  it('strips tags and script content but keeps what the customer typed', () => {
    expect(toPlainText('<p>Lovely <b>earrings</b></p><script>alert(1)</script>')).toBe(
      'Lovely earrings',
    );
    expect(toPlainText('5 < 6 & "great"')).toBe('5 < 6 & "great"');
    expect(toPlainText('<img src=x onerror=alert(1)>Nice   ring\u0007')).toBe('Nice ring');
  });
});

describe('authorName', () => {
  it('shows first name + last initial only', () => {
    expect(authorName('Ananya', 'Rao')).toBe('Ananya R.');
    expect(authorName('Ananya', null)).toBe('Ananya');
    expect(authorName('Ananya', ' ')).toBe('Ananya');
  });
});

describe('recomputeProductRating', () => {
  it('averages APPROVED, non-deleted reviews to 2 decimals', async () => {
    const { db, m } = createMockDb();
    m.review.aggregate.mockResolvedValue({ _avg: { rating: 4.666_666 }, _count: { _all: 3 } });
    await expect(recomputeProductRating(db, 'p1')).resolves.toEqual({
      avgRating: '4.67',
      reviewCount: 3,
    });
    expect(m.review.aggregate.mock.calls[0]?.[0].where).toEqual({
      productId: 'p1',
      status: 'APPROVED',
      deletedAt: null,
    });
    expect(m.product.update.mock.calls[0]?.[0].data.reviewCount).toBe(3);
  });

  it('resets to 0 when no approved review remains', async () => {
    const { db, m } = createMockDb();
    m.review.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { _all: 0 } });
    await expect(recomputeProductRating(db, 'p1')).resolves.toEqual({
      avgRating: '0.00',
      reviewCount: 0,
    });
  });
});
