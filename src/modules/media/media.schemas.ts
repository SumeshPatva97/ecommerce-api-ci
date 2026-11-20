import { z } from 'zod';

/** API_DOCUMENTATION.md §4.3 `POST /admin/media/upload-signature`. */
export const MEDIA_PURPOSES = [
  'PRODUCT_IMAGE',
  'BANNER',
  'CMS',
  'BRAND_LOGO',
  'CATEGORY_IMAGE',
] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export const UploadSignatureBody = z
  .strictObject({
    purpose: z.enum(MEDIA_PURPOSES),
    entityId: z.uuid().optional(),
    fileName: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.purpose === 'PRODUCT_IMAGE' && body.entityId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['entityId'],
        message: 'entityId (the product id) is required for PRODUCT_IMAGE.',
      });
    }
  });
export type UploadSignatureInput = z.output<typeof UploadSignatureBody>;
