/**
 * Zod schemas for the customer auth routes — API_DOCUMENTATION.md §3.1,
 * AUTHENTICATION_AUTHORIZATION.md §5–§11. All bodies are strict (unknown keys rejected).
 *
 * The password *policy* (context check, common list) runs in the service because it needs the
 * user's email / names; the schema only bounds the length so a huge body cannot reach Argon2.
 */
import { z } from 'zod';

import { normalizeEmail, normalizePhone } from '../../lib/normalize.js';
import { PASSWORD_MAX_LENGTH } from '../../core/security/password.js';

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address.' }))
  .transform(normalizeEmail);

/** Login/current-password input: presence + upper bound only (never policy-checked). */
export const passwordInput = z.string().min(1, 'Password is required.').max(PASSWORD_MAX_LENGTH);

/** New password input (policy checked in the service, §4.2). */
export const newPasswordInput = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_LENGTH * 4);

const NAME_PATTERN = /^[\p{L}\p{M} .'-]+$/u;

export const firstNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(NAME_PATTERN, "Use letters, spaces and . ' - only.");

export const lastNameSchema = z
  .string()
  .trim()
  .max(60)
  .regex(NAME_PATTERN, "Use letters, spaces and . ' - only.");

export const phoneSchema = z
  .string()
  .trim()
  .max(20)
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (normalized === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid Indian mobile number (+91).' });
      return z.NEVER;
    }
    return normalized;
  });

/** Opaque 32-byte base64url token (43 chars). */
export const opaqueTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{20,128}$/, 'The link is invalid or has expired.');

const captchaToken = z.string().max(4096).optional();

export const RegisterBody = z.strictObject({
  firstName: firstNameSchema,
  lastName: lastNameSchema.optional(),
  email: emailSchema,
  phone: phoneSchema.optional(),
  password: newPasswordInput,
  acceptTerms: z.literal(true, { message: 'You must accept the terms to continue.' }),
  marketingConsent: z
    .strictObject({ email: z.boolean().default(false), whatsapp: z.boolean().default(false) })
    .optional(),
  captchaToken,
});
export type RegisterInput = z.output<typeof RegisterBody>;

export const LoginBody = z.strictObject({
  email: emailSchema,
  password: passwordInput,
  /** OQ-92: unticked = session cookie, ticked = 30-day refresh cookie. */
  rememberMe: z.boolean().default(false),
  captchaToken,
});
export type LoginInput = z.output<typeof LoginBody>;

export const LogoutBody = z.strictObject({ allDevices: z.boolean().default(false) });

export const VerifyEmailBody = z.strictObject({ token: opaqueTokenSchema });

export const EmailOnlyBody = z.strictObject({ email: emailSchema, captchaToken });

export const OTP_PURPOSES = ['VERIFY_PHONE', 'VERIFY_EMAIL', 'LOGIN'] as const;
export const OTP_CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL'] as const;

export const OtpSendBody = z.strictObject({
  channel: z.enum(OTP_CHANNELS),
  destination: z.string().trim().min(3).max(254),
  purpose: z.enum(OTP_PURPOSES),
});
export type OtpSendInput = z.output<typeof OtpSendBody>;

export const OtpVerifyBody = z.strictObject({
  destination: z.string().trim().min(3).max(254),
  purpose: z.enum(OTP_PURPOSES),
  otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});
export type OtpVerifyInput = z.output<typeof OtpVerifyBody>;

export const ResetPasswordBody = z.strictObject({
  token: opaqueTokenSchema,
  newPassword: newPasswordInput,
});

export const ChangePasswordBody = z.strictObject({
  currentPassword: passwordInput,
  newPassword: newPasswordInput,
  signOutOtherDevices: z.boolean().default(true),
});
export type ChangePasswordInput = z.output<typeof ChangePasswordBody>;

export const SessionIdParams = z.strictObject({ sessionId: z.uuid() });
