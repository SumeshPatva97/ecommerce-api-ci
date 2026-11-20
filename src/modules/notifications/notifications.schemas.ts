/**
 * Notification request schemas — API_DOCUMENTATION.md §3.2 (preferences), §4.16 (templates, logs,
 * resend). Admin bodies are strict (SECURITY_GUIDELINES.md §5). No I/O.
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import {
  NotificationChannel,
  NotificationEvent,
  NotificationStatus,
} from '../../generated/prisma/enums.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const channelPrefs = z.strictObject({
  transactional: z.boolean().optional(),
  marketing: z.boolean().optional(),
});

export const UpdatePreferencesBody = z.strictObject({
  channels: z
    .strictObject({ EMAIL: channelPrefs.optional(), WHATSAPP: channelPrefs.optional() })
    .refine((c) => c.EMAIL !== undefined || c.WHATSAPP !== undefined, {
      message: 'Provide at least one channel.',
    }),
  /** Version of the consent text shown to the customer (DPDP evidence, §5.2). */
  consentTextVersion: z.string().trim().min(1).max(20).optional(),
});
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesBody>;

export const TemplateIdParams = z.object({
  templateId: z.uuid({ message: 'Must be a valid id.' }),
});
export const NotificationIdParams = z.object({
  notificationId: z.uuid({ message: 'Must be a valid id.' }),
});

export const TemplateListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  event: z.enum(NotificationEvent).optional(),
  channel: z.enum(NotificationChannel).optional(),
});
export type TemplateListQueryInput = z.infer<typeof TemplateListQuery>;

const variantSchema = z.strictObject({
  subject: z.string().trim().min(1).max(255).optional(),
  body: z.string().trim().min(1).max(100_000).optional(),
  whatsappTemplateName: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,100}$/, 'Lowercase letters, digits and underscores only.')
    .optional(),
});

/** Channel-specific fields are checked in the service (email vs WhatsApp, §4.16). */
export const UpdateTemplateBody = z
  .strictObject({
    name: z.string().trim().min(2).max(120).optional(),
    subject: z.string().trim().min(1).max(255).optional(),
    bodyTemplate: z.string().trim().min(1).max(100_000).optional(),
    providerTemplateName: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,100}$/, 'Lowercase letters, digits and underscores only.')
      .optional(),
    whatsappLanguage: z
      .string()
      .trim()
      .regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'Use a language code such as en or en_US.')
      .optional(),
    /** PROVISIONAL (OQ-08): set by staff until a BSP sync exists. */
    approvalStatus: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAUSED']).optional(),
    variableOrder: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    variants: z
      .record(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use UPPER_SNAKE_CASE.'), variantSchema)
      .optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateBody>;

export const LogListQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  event: z.enum(NotificationEvent).optional(),
  channel: z.enum(NotificationChannel).optional(),
  status: z.enum(NotificationStatus).optional(),
  recipient: z.string().trim().min(3).max(254).optional(),
  orderNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^ORD-\d{6}-\d{5}$/, 'Invalid order number.')
    .optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type LogListQueryInput = z.infer<typeof LogListQuery>;

export const ResendBody = z.strictObject({
  channel: z.enum(['EMAIL', 'WHATSAPP']).optional(),
  reason: z.string().trim().min(3).max(500),
});
export type ResendInput = z.infer<typeof ResendBody>;
