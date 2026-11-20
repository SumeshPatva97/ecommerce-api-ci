/**
 * Zod schemas for staff auth routes — API_DOCUMENTATION.md §4.1. Strict bodies.
 */
import { z } from 'zod';

import {
  emailSchema,
  firstNameSchema,
  lastNameSchema,
  newPasswordInput,
  opaqueTokenSchema,
  passwordInput,
} from '../auth/auth.schemas.js';

export {
  ChangePasswordBody,
  EmailOnlyBody,
  LogoutBody,
  ResetPasswordBody,
  SessionIdParams,
} from '../auth/auth.schemas.js';

const totpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.');

export const AdminLoginBody = z.strictObject({
  email: emailSchema,
  password: passwordInput,
  captchaToken: z.string().max(4096).optional(),
});
export type AdminLoginInput = z.output<typeof AdminLoginBody>;

export const MfaVerifyBody = z
  .strictObject({
    mfaChallengeId: z.uuid(),
    totpCode: totpCode.optional(),
    recoveryCode: z.string().trim().min(1).max(64).optional(),
  })
  .refine((body) => (body.totpCode === undefined) !== (body.recoveryCode === undefined), {
    message: 'Provide either totpCode or recoveryCode.',
    path: ['totpCode'],
  });
export type MfaVerifyInput = z.output<typeof MfaVerifyBody>;

/**
 * MFA enrolment (owner decision 2026-11-19). `enrollmentToken` is required for the login /
 * accept-invite flow (no session yet); a signed-in staff member enrolling voluntarily omits it and
 * authenticates with the Bearer token instead.
 */
export const MfaEnrollBody = z.strictObject({
  enrollmentToken: opaqueTokenSchema.optional(),
});
export type MfaEnrollInput = z.output<typeof MfaEnrollBody>;

export const MfaConfirmBody = z.strictObject({
  enrollmentToken: opaqueTokenSchema.optional(),
  totpCode,
});
export type MfaConfirmInput = z.output<typeof MfaConfirmBody>;

export const ReauthBody = z.strictObject({
  password: passwordInput,
  totpCode: totpCode.optional(),
});
export type ReauthInput = z.output<typeof ReauthBody>;

export const AcceptInviteBody = z.strictObject({
  token: opaqueTokenSchema,
  password: newPasswordInput,
  firstName: firstNameSchema.optional(),
  lastName: lastNameSchema.optional(),
});
export type AcceptInviteInput = z.output<typeof AcceptInviteBody>;
