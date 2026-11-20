/**
 * Signed direct-upload parameters — BACKEND_STRUCTURE.md §17 steps 1–2, API_DOCUMENTATION.md §4.3.
 *
 * - The signature is computed LOCALLY (`cloudinary.ts`); this service never calls Cloudinary.
 * - The API secret never leaves the server: it is used only as the SHA-1 suffix and is never part
 *   of the response or any log line.
 * - MEDIA_PROVIDER=mock or missing credentials → a clearly-marked mock signature (`mock: true`,
 *   `example.invalid` upload URL) so local development works without an account.
 * - Signed params: `allowed_formats`, `folder`, `public_id`, `timestamp`. The browser must post
 *   exactly `uploadParams` (+ `file`). Validity: 10 minutes advisory (`expiresAt`, §17 step 2);
 *   Cloudinary itself rejects signatures older than 1 hour.
 */
import { createHash } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { ulid } from '../../lib/ulid.js';
import { hasPermission, type AuthContext } from '../rbac/permission.service.js';
import { isCloudinaryConfigured, signParams } from './cloudinary.js';
import type { MediaPurpose, UploadSignatureInput } from './media.schemas.js';

export const SIGNATURE_TTL_SECONDS = 600;
const MOCK_SECRET_LABEL = 'mock-signature-not-valid-at-cloudinary';

/** Purpose → folder segment and the permissions that may request it (anyOf). */
export const PURPOSE_RULES: Readonly<
  Record<MediaPurpose, { readonly folder: string; readonly anyOf: readonly string[] }>
> = {
  PRODUCT_IMAGE: { folder: 'products', anyOf: ['products.create', 'products.update'] },
  BANNER: { folder: 'banners', anyOf: ['banners.create', 'banners.update'] },
  CMS: { folder: 'cms', anyOf: ['cms.update'] },
  BRAND_LOGO: { folder: 'brands', anyOf: ['brands.update'] },
  CATEGORY_IMAGE: { folder: 'categories', anyOf: ['categories.update'] },
};

/** Union of every purpose permission — the route-level `requireAnyPermission` guard. */
export const UPLOAD_SIGNATURE_PERMISSIONS: readonly string[] = [
  ...new Set(Object.values(PURPOSE_RULES).flatMap((rule) => rule.anyOf)),
];

export interface UploadSignatureDto {
  readonly mock: boolean;
  readonly cloudName: string;
  readonly apiKey: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly folder: string;
  readonly publicId: string;
  readonly uploadParams: {
    readonly api_key: string;
    readonly timestamp: number;
    readonly signature: string;
    readonly folder: string;
    readonly public_id: string;
    readonly allowed_formats: string;
  };
  readonly allowedFormats: readonly string[];
  readonly maxFileSizeBytes: number;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export interface MediaService {
  createUploadSignature(
    ctx: Pick<AuthContext, 'permissions' | 'isSuperadmin'>,
    input: UploadSignatureInput,
  ): Promise<UploadSignatureDto>;
}

export function createMediaService(c: Pick<AppContainer, 'config' | 'clock' | 'db'>): MediaService {
  const media = c.config.integrations.media;

  return {
    async createUploadSignature(ctx, input) {
      const rule = PURPOSE_RULES[input.purpose];
      if (!rule.anyOf.some((key) => hasPermission(ctx, key))) {
        throw new AppError(
          'PERMISSION_DENIED',
          'You do not have permission to upload media for this purpose.',
          {
            details: [{ field: 'purpose', code: 'PURPOSE_NOT_ALLOWED', message: input.purpose }],
          },
        );
      }
      if (input.purpose === 'PRODUCT_IMAGE' && input.entityId !== undefined) {
        const product = await c.db.product.findFirst({
          where: { id: input.entityId, deletedAt: null },
          select: { id: true },
        });
        if (product === null) throw new AppError('NOT_FOUND', 'Product not found.');
      }

      const folder = [media.uploadFolder, rule.folder, input.entityId]
        .filter((part): part is string => part !== undefined)
        .join('/');
      const leaf = ulid(c.clock().getTime()).toLowerCase();
      const timestamp = Math.floor(c.clock().getTime() / 1000);
      const allowedFormats = [...media.allowedFormats];
      const signed = {
        allowed_formats: allowedFormats.join(','),
        folder,
        public_id: leaf,
        timestamp,
      };

      const live = isCloudinaryConfigured(media);
      let signature: string;
      let cloudName: string;
      let apiKey: string;
      if (live && media.apiSecret !== undefined && media.cloudName !== undefined) {
        signature = signParams(signed, media.apiSecret);
        cloudName = media.cloudName;
        apiKey = media.apiKey ?? '';
      } else {
        // Clearly-marked mock: deterministic, never accepted by Cloudinary, no secret involved.
        signature = `mock_${createHash('sha1')
          .update(`${MOCK_SECRET_LABEL}|${JSON.stringify(signed)}`)
          .digest('hex')}`;
        cloudName = 'mock';
        apiKey = 'mock';
      }

      return {
        mock: !live,
        cloudName,
        apiKey,
        timestamp,
        signature,
        folder,
        publicId: `${folder}/${leaf}`,
        uploadParams: {
          api_key: apiKey,
          timestamp,
          signature,
          folder,
          public_id: leaf,
          allowed_formats: signed.allowed_formats,
        },
        allowedFormats,
        maxFileSizeBytes: media.maxUploadMb * 1024 * 1024,
        uploadUrl: live
          ? `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`
          : 'https://example.invalid/mock-cloudinary/image/upload',
        expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
      };
    },
  };
}
