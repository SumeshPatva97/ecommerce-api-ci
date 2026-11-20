/**
 * Cloudinary helpers — BACKEND_STRUCTURE.md §17. PURE: no network call is ever made from here.
 *
 * - `signParams` computes the Cloudinary API signature LOCALLY:
 *   SHA-1 hex of the alphabetically sorted `key=value` pairs joined with `&`, followed by the API
 *   secret (Cloudinary "authentication signatures"). `file`, `cloud_name`, `resource_type` and
 *   `api_key` are never part of the signed string.
 * - Delivery URLs (`f_auto,q_auto,w_…`) are built here so both front-ends receive ready URLs plus
 *   the `publicId` (§17 step 7). Without a configured cloud (MEDIA_PROVIDER=mock or missing
 *   credentials) clearly-marked mock URLs on `example.invalid` are returned.
 *
 * NOTE for a later shared-lib move: this is pure and used by products + catalog mappers.
 */
import { createHash } from 'node:crypto';

import type { AppConfig } from '../../core/config/index.js';

/** Public IDs we issue/accept: path segments of `[A-Za-z0-9_-]`, no `..`, no leading slash. */
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

const UNSIGNED_KEYS = new Set(['file', 'cloud_name', 'resource_type', 'api_key', 'signature']);

export function stringToSign(params: Readonly<Record<string, string | number>>): string {
  return Object.keys(params)
    .filter((key) => !UNSIGNED_KEYS.has(key) && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
}

export function signParams(
  params: Readonly<Record<string, string | number>>,
  apiSecret: string,
): string {
  return createHash('sha1')
    .update(stringToSign(params) + apiSecret)
    .digest('hex');
}

export interface MediaDelivery {
  /** Undefined → mock mode (no Cloudinary cloud configured). */
  readonly cloudName: string | undefined;
}

export type MediaConfig = AppConfig['integrations']['media'];

/** True only when MEDIA_PROVIDER=cloudinary and all three credentials are present. */
export function isCloudinaryConfigured(media: MediaConfig): boolean {
  return (
    media.provider === 'cloudinary' &&
    media.cloudName !== undefined &&
    media.apiKey !== undefined &&
    media.apiSecret !== undefined
  );
}

export function deliveryFromConfig(media: MediaConfig): MediaDelivery {
  return { cloudName: isCloudinaryConfigured(media) ? media.cloudName : undefined };
}

export const IMAGE_WIDTHS = { thumb: 160, card: 600, detail: 1000, zoom: 2000 } as const;

export function deliveryUrl(delivery: MediaDelivery, publicId: string, width?: number): string {
  const transform = width === undefined ? 'f_auto,q_auto' : `f_auto,q_auto,w_${String(width)}`;
  if (delivery.cloudName === undefined) {
    return `https://example.invalid/mock-cloudinary/image/upload/${transform}/${publicId}`;
  }
  return `https://res.cloudinary.com/${encodeURIComponent(delivery.cloudName)}/image/upload/${transform}/${publicId}`;
}

export interface ImageUrls {
  readonly url: string;
  readonly thumbUrl: string;
  readonly zoomUrl: string;
}

export function imageUrls(
  delivery: MediaDelivery,
  publicId: string,
  mainWidth: number = IMAGE_WIDTHS.detail,
): ImageUrls {
  return {
    url: deliveryUrl(delivery, publicId, mainWidth),
    thumbUrl: deliveryUrl(delivery, publicId, IMAGE_WIDTHS.thumb),
    zoomUrl: deliveryUrl(delivery, publicId, IMAGE_WIDTHS.zoom),
  };
}

/** Folder (relative to CLOUDINARY_UPLOAD_FOLDER) that product images must live in. */
export function productImageFolder(uploadFolder: string, productId: string): string {
  return `${uploadFolder}/products/${productId}`;
}
