/**
 * Local Cloudinary signing + delivery URLs (pure; no network).
 */
import { describe, expect, it } from 'vitest';

import {
  deliveryUrl,
  imageUrls,
  isCloudinaryConfigured,
  signParams,
  stringToSign,
} from '../../../../src/modules/media/cloudinary.js';

describe('Cloudinary signature', () => {
  it('matches the documented example (sorted params, & joined, secret appended, SHA-1 hex)', () => {
    // Example from Cloudinary's "Generating authentication signatures" documentation.
    const params = {
      timestamp: 1315060510,
      public_id: 'sample_image',
      eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop',
    };
    expect(stringToSign(params)).toBe(
      'eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample_image&timestamp=1315060510',
    );
    expect(signParams(params, 'abcd')).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('never signs file, cloud_name, resource_type, api_key or empty values', () => {
    expect(
      stringToSign({
        timestamp: 1,
        api_key: 'k',
        file: 'f',
        cloud_name: 'c',
        resource_type: 'image',
        folder: '',
      }),
    ).toBe('timestamp=1');
  });
});

describe('delivery URLs', () => {
  it('builds f_auto,q_auto,w_… transformation URLs for a configured cloud', () => {
    expect(deliveryUrl({ cloudName: 'demo' }, 'ecom/dev/products/p1/main', 800)).toBe(
      'https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_800/ecom/dev/products/p1/main',
    );
    const urls = imageUrls({ cloudName: 'demo' }, 'a/b');
    expect(urls.thumbUrl).toContain('w_160');
    expect(urls.zoomUrl).toContain('w_2000');
  });

  it('returns clearly-marked mock URLs without a cloud', () => {
    expect(deliveryUrl({ cloudName: undefined }, 'a/b', 600)).toMatch(
      /^https:\/\/example\.invalid\/mock-cloudinary\//,
    );
  });

  it('treats cloudinary as configured only with all credentials', () => {
    const base = {
      provider: 'cloudinary' as const,
      cloudName: 'c',
      apiKey: 'k',
      apiSecret: 's',
      uploadFolder: 'ecom/dev',
      maxUploadMb: 10,
      allowedFormats: ['jpg'],
    };
    expect(isCloudinaryConfigured(base)).toBe(true);
    expect(isCloudinaryConfigured({ ...base, apiSecret: undefined })).toBe(false);
    expect(isCloudinaryConfigured({ ...base, provider: 'mock' })).toBe(false);
  });
});
