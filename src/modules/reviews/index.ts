/**
 * Reviews module (B8) — verified-purchaser text reviews with pre-moderation (OQ-31, PROVISIONAL).
 */
import type { ModuleFactory } from '../types.js';
import { createReviewsAdminRouter, createReviewsPublicRouter } from './reviews.routes.js';
import { createReviewsService } from './reviews.service.js';

export const createReviewsModule: ModuleFactory = (container) => {
  const service = createReviewsService(container);
  return {
    name: 'reviews',
    publicRouter: createReviewsPublicRouter(container, service),
    adminRouter: createReviewsAdminRouter(container, service),
  };
};

export {
  authorName,
  createReviewsService,
  recomputeProductRating,
  type AdminReviewDto,
  type ReviewsService,
} from './reviews.service.js';
export { toPlainText } from './reviews.text.js';
