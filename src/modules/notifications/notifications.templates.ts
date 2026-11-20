/**
 * `notification_templates.variables` JSON layout and template DTO mapping — pure.
 *
 * The approved table has one row per (event, channel, locale). Template *variants* (OQ-82
 * `ALREADY_REGISTERED`, OQ-83 `ACCOUNT_SUSPENDED`, OQ-59 late-capture refund) are therefore stored
 * inside the `variables` JSON column, next to the allow-list and the WhatsApp parameter order:
 *
 *   { "allowed": ["firstName", …], "order": ["firstName", "orderNumber"],
 *     "variants": { "ALREADY_REGISTERED": { "subject": "…", "body": "…" } } }
 */
import type { NotificationTemplate } from '../../generated/prisma/client.js';
import type { NotificationChannel, NotificationEvent } from '../../generated/prisma/enums.js';
import { EVENT_SPECS } from './notifications.catalog.js';

export interface TemplateVariant {
  readonly subject?: string;
  readonly body?: string;
  readonly whatsappTemplateName?: string;
  /** WhatsApp only: parameter order of the variant's provider template (defaults to the base). */
  readonly order?: readonly string[];
}

export interface TemplateMeta {
  readonly allowed: readonly string[];
  readonly order: readonly string[];
  readonly variants: Readonly<Record<string, TemplateVariant>>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseTemplateMeta(event: NotificationEvent, raw: unknown): TemplateMeta {
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
  const record = obj as Record<string, unknown>;
  const variants: Record<string, TemplateVariant> = {};
  const rawVariants = record.variants;
  if (typeof rawVariants === 'object' && rawVariants !== null && !Array.isArray(rawVariants)) {
    for (const [key, value] of Object.entries(rawVariants as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const subject = optionalString(v.subject);
      const body = optionalString(v.body);
      const whatsappTemplateName = optionalString(v.whatsappTemplateName);
      const order = Array.isArray(v.order) ? stringArray(v.order) : undefined;
      variants[key] = {
        ...(subject === undefined ? {} : { subject }),
        ...(body === undefined ? {} : { body }),
        ...(whatsappTemplateName === undefined ? {} : { whatsappTemplateName }),
        ...(order === undefined ? {} : { order }),
      };
    }
  }
  const allowed = stringArray(record.allowed);
  return {
    allowed: allowed.length > 0 ? allowed : [...EVENT_SPECS[event].variables],
    order: stringArray(record.order),
    variants,
  };
}

export function serializeTemplateMeta(meta: TemplateMeta): Record<string, unknown> {
  return { allowed: [...meta.allowed], order: [...meta.order], variants: { ...meta.variants } };
}

export interface ResolvedTemplate {
  readonly subject: string | null;
  readonly body: string | null;
  readonly whatsappTemplateName: string | null;
  /** WhatsApp parameter order for the resolved template. */
  readonly order: readonly string[];
}

/** Base template content, overridden field-by-field by the requested variant (if defined). */
export function resolveVariant(
  template: Pick<NotificationTemplate, 'subject' | 'body' | 'whatsappTemplateName'>,
  meta: TemplateMeta,
  variant: string | undefined,
): ResolvedTemplate {
  const v = variant === undefined ? undefined : meta.variants[variant];
  return {
    subject: v?.subject ?? template.subject,
    body: v?.body ?? template.body,
    whatsappTemplateName: v?.whatsappTemplateName ?? template.whatsappTemplateName,
    order: v?.order ?? meta.order,
  };
}

export interface TemplateDto {
  readonly id: string;
  readonly event: NotificationEvent;
  readonly channel: NotificationChannel;
  readonly locale: string;
  readonly name: string;
  readonly subject: string | null;
  readonly bodyTemplate: string | null;
  readonly providerTemplateName: string | null;
  readonly whatsappLanguage: string | null;
  readonly approvalStatus: string | null;
  readonly variables: readonly string[];
  readonly variableOrder: readonly string[];
  readonly variants: Readonly<Record<string, TemplateVariant>>;
  readonly version: number;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly updatedAt: string;
}

export function toTemplateDto(row: NotificationTemplate): TemplateDto {
  const meta = parseTemplateMeta(row.event, row.variables);
  return {
    id: row.id,
    event: row.event,
    channel: row.channel,
    locale: row.locale,
    name: row.name,
    subject: row.subject,
    bodyTemplate: row.body,
    providerTemplateName: row.whatsappTemplateName,
    whatsappLanguage: row.whatsappLanguage,
    approvalStatus: row.whatsappApprovalStatus,
    variables: EVENT_SPECS[row.event].variables,
    variableOrder: meta.order,
    variants: meta.variants,
    version: row.version,
    status: row.isActive ? 'ACTIVE' : 'INACTIVE',
    updatedAt: row.updatedAt.toISOString(),
  };
}
