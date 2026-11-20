/**
 * Checkout pre-condition (API_DOCUMENTATION.md §3.9): the customer must be `ACTIVE` with a verified
 * email — otherwise 403 `FORBIDDEN` with `details[0].code = EMAIL_NOT_VERIFIED` (or the account
 * reason). Runs after `authenticate('storefront')` and BEFORE the idempotency middleware so a
 * refused request does not consume an Idempotency-Key.
 */
import type { RequestHandler } from 'express';

import { AppError } from '../../core/errors/AppError.js';

export function emailNotVerifiedError(): AppError {
  return new AppError('FORBIDDEN', 'Please verify your email address before checking out.', {
    details: [{ code: 'EMAIL_NOT_VERIFIED', message: 'Email address not verified.' }],
  });
}

export const requireVerifiedCustomer: RequestHandler = (req, _res, next) => {
  const ctx = req.authz;
  if (ctx === undefined) {
    next(new AppError('UNAUTHENTICATED', 'Please sign in to continue.'));
    return;
  }
  if (ctx.accountType !== 'CUSTOMER') {
    next(
      new AppError('FORBIDDEN', undefined, {
        details: [{ code: 'WRONG_AUDIENCE', message: 'Customer account required.' }],
      }),
    );
    return;
  }
  if (ctx.status === 'PENDING_VERIFICATION') {
    next(emailNotVerifiedError());
    return;
  }
  if (ctx.status !== 'ACTIVE') {
    next(
      new AppError('FORBIDDEN', undefined, {
        details: [
          {
            code: ctx.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DISABLED',
            message: 'This account cannot place orders.',
          },
        ],
      }),
    );
    return;
  }
  next();
};
