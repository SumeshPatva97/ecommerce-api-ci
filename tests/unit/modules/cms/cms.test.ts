/**
 * CMS helpers — link allow-list, block content sanitisation, banner scheduling. Pure.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../../src/core/errors/AppError.js';
import {
  bannerState,
  isAllowedHref,
  liveBannerWhere,
  prepareBlockContent,
} from '../../../../src/modules/cms/index.js';

const HOSTS = new Set(['www.example.com']);
const NOW = new Date('2026-11-19T06:30:00.000Z');

describe('isAllowedHref', () => {
  it('allows site paths and https on allow-listed hosts only', () => {
    expect(isAllowedHref('/collections/bridal?x=1', HOSTS)).toBe(true);
    expect(isAllowedHref('https://www.example.com/sale', HOSTS)).toBe(true);
    expect(isAllowedHref('//evil.example/x', HOSTS)).toBe(false);
    expect(isAllowedHref('https://evil.example/x', HOSTS)).toBe(false);
    expect(isAllowedHref('http://www.example.com/x', HOSTS)).toBe(false);
    expect(isAllowedHref('javascript:alert(1)', HOSTS)).toBe(false);
    expect(isAllowedHref('/\\evil.example', HOSTS)).toBe(false);
  });
});

describe('prepareBlockContent', () => {
  it('sanitises every *html string with the binding allow-list', () => {
    const out = prepareBlockContent(
      'RICH_TEXT',
      {
        title: 'About us',
        html: '<p onclick="x()">Hi<script>alert(1)</script><iframe src="x"></iframe></p><a href="https://a.example" target="_blank">a</a>',
        items: [{ captionHtml: '<em>ok</em><img src="https://evil.example/x.png">' }],
      },
      HOSTS,
    );
    expect(out.html).toBe('<p>Hi</p><a href="https://a.example" rel="noopener noreferrer">a</a>');
    expect(out.items).toEqual([{ captionHtml: '<em>ok</em>' }]);
    expect(out.title).toBe('About us');
  });

  it('rejects unsafe links/images with field paths and requires html for RICH_TEXT', () => {
    try {
      prepareBlockContent(
        'PROMO_BANNER',
        { items: [{ href: 'javascript:alert(1)', imageUrl: 'http://res.cloudinary.com/x.png' }] },
        HOSTS,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const fields = (error as AppError).details?.map((d) => d.field);
      expect(fields).toEqual(['content.items[0].href', 'content.items[0].imageUrl']);
    }
    expect(() => prepareBlockContent('RICH_TEXT', { title: 'x' }, HOSTS)).toThrow(AppError);
    expect(() => prepareBlockContent('PRODUCT_RAIL', { 'bad key': 1 }, HOSTS)).toThrow(AppError);
    expect(
      prepareBlockContent('PRODUCT_RAIL', { ctaHref: '/new-arrivals', limit: 12 }, HOSTS),
    ).toEqual({ ctaHref: '/new-arrivals', limit: 12 });
  });
});

describe('banner scheduling', () => {
  const at = (iso: string | null) => (iso === null ? null : new Date(iso));
  it('derives LIVE / SCHEDULED / EXPIRED / INACTIVE', () => {
    expect(bannerState({ isActive: true, startsAt: null, endsAt: null }, NOW)).toBe('LIVE');
    expect(
      bannerState({ isActive: true, startsAt: at('2026-11-20T00:00:00Z'), endsAt: null }, NOW),
    ).toBe('SCHEDULED');
    expect(
      bannerState({ isActive: true, startsAt: null, endsAt: at('2026-11-19T06:30:00Z') }, NOW),
    ).toBe('EXPIRED');
    expect(bannerState({ isActive: false, startsAt: null, endsAt: null }, NOW)).toBe('INACTIVE');
  });

  it('builds the public schedule window filter (start ≤ now < end)', () => {
    expect(liveBannerWhere(NOW)).toEqual({
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: NOW } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: NOW } }] },
      ],
    });
  });
});
