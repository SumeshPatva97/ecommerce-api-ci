/**
 * Product images — API_DOCUMENTATION.md §4.3 "Images", workflow §11, BACKEND_STRUCTURE §17.
 *
 * GAP (reported): §17 step 5 asks to verify the asset via the Cloudinary Admin API (exists, format,
 * ≤ 10 MB, ≥ 800 px). This increment makes no Cloudinary network calls, so only the public ID is
 * checked: allowed characters and the signed folder prefix `<upload folder>/products/<productId>/`.
 * Deleting an image removes the row only; the Cloudinary asset is NOT destroyed here (order
 * snapshots may still reference the URL; deferred cleanup job, workflow §11 PROPOSED).
 */
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import type { AuditActor } from '../audit/audit.service.js';
import { deliveryUrl, productImageFolder } from '../media/cloudinary.js';
import { mapImage } from './products.mapper.js';
import { imageSelect, type ImageRow } from './products.repository.js';
import { MAX_IMAGES_PER_PRODUCT } from './products.rules.js';
import type { ImageItemInput, UpdateImageInput } from './products.schemas.js';
import { conflict, invalid, MODULE, notFound, type ProductsDeps } from './products.support.js';

export function createImagesService(deps: ProductsDeps) {
  const { db, repo, audit } = deps;

  async function variantIdsOf(productId: string): Promise<Set<string>> {
    const variants = await repo.variantsWithValues(db, productId);
    return new Set(variants.map((v) => v.id));
  }

  async function findImage(productId: string, imageId: string): Promise<ImageRow> {
    const image = await db.productImage.findFirst({
      where: { id: imageId, productId, product: { deletedAt: null } },
      select: imageSelect,
    });
    if (image === null) throw notFound('Image');
    return image;
  }

  return {
    async add(actor: AuditActor, productId: string, items: readonly ImageItemInput[]) {
      const product = await repo.findCore(db, productId);
      if (product === null) throw notFound('Product');
      const existing = await repo.images(db, productId);
      if (existing.length + items.length > MAX_IMAGES_PER_PRODUCT) {
        throw invalid([
          {
            field: 'images',
            code: 'TOO_MANY_IMAGES',
            message: `A product can have at most ${String(MAX_IMAGES_PER_PRODUCT)} images.`,
            meta: { current: existing.length, adding: items.length },
          },
        ]);
      }
      const prefix = `${productImageFolder(deps.uploadFolder, productId)}/`;
      const variantIds = items.some((i) => i.variantId !== undefined && i.variantId !== null)
        ? await variantIdsOf(productId)
        : new Set<string>();
      const details: ErrorDetail[] = [];
      items.forEach((item, i) => {
        const field = `images[${String(i)}]`;
        if (!item.publicId.startsWith(prefix)) {
          details.push({
            field: `${field}.publicId`,
            code: 'PUBLIC_ID_OUTSIDE_FOLDER',
            message: `publicId must be inside "${prefix}" (use POST /admin/media/upload-signature).`,
          });
        }
        if (
          item.variantId !== undefined &&
          item.variantId !== null &&
          !variantIds.has(item.variantId)
        ) {
          details.push({
            field: `${field}.variantId`,
            code: 'VARIANT_NOT_IN_PRODUCT',
            message: 'The variant does not belong to this product.',
          });
        }
      });
      if (details.length > 0) throw invalid(details);
      const duplicates = items.filter((i) =>
        existing.some((e) => e.cloudinaryPublicId === i.publicId),
      );
      if (duplicates.length > 0) {
        throw new AppError('DUPLICATE_RESOURCE', 'This image is already attached to the product.', {
          details: duplicates.map((d) => ({
            field: 'publicId',
            code: 'DUPLICATE_RESOURCE',
            message: `${d.publicId} is already attached.`,
          })),
        });
      }

      const hasPrimary = existing.some((e) => e.isPrimary);
      const flagged = items.findIndex((i) => i.isPrimary === true);
      const primaryIndex = flagged >= 0 ? flagged : hasPrimary ? -1 : 0;
      const nextSort = existing.reduce((max, e) => Math.max(max, e.sortOrder + 1), 0);

      const created = await withTransaction(db, async ({ tx }) => {
        if (flagged >= 0 && hasPrimary) {
          await tx.productImage.updateMany({
            where: { productId, isPrimary: true },
            data: { isPrimary: false },
          });
        }
        const rows: ImageRow[] = [];
        for (const [i, item] of items.entries()) {
          const row = await tx.productImage.create({
            data: {
              productId,
              variantId: item.variantId ?? null,
              cloudinaryPublicId: item.publicId,
              url: deliveryUrl(deps.delivery, item.publicId),
              altText: item.altText,
              sortOrder: item.sortOrder ?? nextSort + i,
              isPrimary: i === primaryIndex,
              mediaType: 'IMAGE',
              createdById: actor.userId ?? null,
              updatedById: actor.userId ?? null,
            },
            select: imageSelect,
          });
          rows.push(row);
          await audit.record(tx, actor, {
            action: 'CREATE',
            module: MODULE,
            entityType: 'ProductImage',
            entityId: row.id,
            after: {
              id: row.id,
              productId,
              variantId: row.variantId,
              publicId: row.cloudinaryPublicId,
              altText: row.altText,
              sortOrder: row.sortOrder,
              isPrimary: row.isPrimary,
            },
            metadata: { entityLabel: product.name },
          });
        }
        return rows;
      });
      return { images: created.map((row) => mapImage(row, deps.delivery)) };
    },

    async update(actor: AuditActor, productId: string, imageId: string, input: UpdateImageInput) {
      const image = await findImage(productId, imageId);
      if (input.variantId !== undefined && input.variantId !== null) {
        if (!(await variantIdsOf(productId)).has(input.variantId)) {
          throw invalid([
            {
              field: 'variantId',
              code: 'VARIANT_NOT_IN_PRODUCT',
              message: 'The variant does not belong to this product.',
            },
          ]);
        }
      }
      const data = {
        ...(input.altText === undefined ? {} : { altText: input.altText }),
        ...(input.variantId === undefined ? {} : { variantId: input.variantId }),
        ...(input.isPrimary === true ? { isPrimary: true } : {}),
      };
      const updated = await withTransaction(db, async ({ tx }) => {
        if (input.isPrimary === true && !image.isPrimary) {
          await tx.productImage.updateMany({
            where: { productId, isPrimary: true },
            data: { isPrimary: false },
          });
        }
        const row = await tx.productImage.update({
          where: { id: imageId },
          data: { ...data, updatedById: actor.userId ?? null },
          select: imageSelect,
        });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ProductImage',
          entityId: imageId,
          before: {
            id: imageId,
            altText: image.altText,
            variantId: image.variantId,
            isPrimary: image.isPrimary,
          },
          after: {
            id: imageId,
            altText: row.altText,
            variantId: row.variantId,
            isPrimary: row.isPrimary,
          },
          metadata: { productId },
        });
        return row;
      });
      return mapImage(updated, deps.delivery);
    },

    async remove(actor: AuditActor, productId: string, imageId: string) {
      const image = await findImage(productId, imageId);
      const product = await repo.findCore(db, productId);
      if (product === null) throw notFound('Product');
      const count = await repo.imageCount(db, productId);
      if (product.status === 'ACTIVE' && count <= 1) {
        throw conflict(
          'LAST_IMAGE_OF_ACTIVE_PRODUCT',
          'An ACTIVE product needs at least one image; add another image or unpublish first.',
        );
      }
      await withTransaction(db, async ({ tx }) => {
        await tx.productImage.delete({ where: { id: imageId } });
        if (image.isPrimary) {
          const next = await tx.productImage.findFirst({
            where: { productId },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: { id: true },
          });
          if (next !== null) {
            await tx.productImage.update({ where: { id: next.id }, data: { isPrimary: true } });
          }
        }
        await audit.record(tx, actor, {
          action: 'DELETE',
          module: MODULE,
          entityType: 'ProductImage',
          entityId: imageId,
          before: {
            id: imageId,
            publicId: image.cloudinaryPublicId,
            variantId: image.variantId,
            isPrimary: image.isPrimary,
          },
          after: null,
          metadata: { productId, assetDestroyed: false },
        });
      });
      return { id: imageId, deleted: true };
    },

    async reorder(actor: AuditActor, productId: string, imageIds: readonly string[]) {
      const product = await repo.findCore(db, productId);
      if (product === null) throw notFound('Product');
      const images = await repo.images(db, productId);
      const current = new Set(images.map((i) => i.id));
      const same = imageIds.length === current.size && imageIds.every((id) => current.has(id));
      if (!same) {
        throw invalid([
          {
            field: 'imageIds',
            code: 'IMAGE_SET_MISMATCH',
            message: "imageIds must contain exactly the product's image IDs.",
            meta: { expected: images.length, received: imageIds.length },
          },
        ]);
      }
      await withTransaction(db, async ({ tx }) => {
        for (const [index, id] of imageIds.entries()) {
          await tx.productImage.update({ where: { id }, data: { sortOrder: index } });
        }
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Product',
          entityId: productId,
          diff: false,
          eventKey: 'products.images.reordered',
          before: { imageIds: images.map((i) => i.id) },
          after: { imageIds: [...imageIds] },
          metadata: { entityLabel: product.name },
        });
      });
      const byId = new Map(images.map((i) => [i.id, i]));
      return {
        images: imageIds.flatMap((id, index) => {
          const row = byId.get(id);
          return row === undefined ? [] : [mapImage({ ...row, sortOrder: index }, deps.delivery)];
        }),
      };
    },
  };
}

export type ImagesService = ReturnType<typeof createImagesService>;
