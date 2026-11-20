/**
 * `422 COUPON_INVALID` builder — API_DOCUMENTATION.md §2.3 / §3.4: one reason per response in
 * `details[0].code` (R-05, no `reason` key), field `code`, customer-safe message. Pure.
 */
import { AppError } from '../../core/errors/AppError.js';
import { couponFailureText, type CouponFailure } from '../../lib/pricing/index.js';

export function couponInvalidError(failure: CouponFailure): AppError {
  const text = couponFailureText(failure);
  return new AppError('COUPON_INVALID', text.message, {
    details: [
      {
        field: 'code',
        code: failure.reason,
        message: text.detail,
        ...(text.meta === undefined ? {} : { meta: text.meta }),
      },
    ],
  });
}
