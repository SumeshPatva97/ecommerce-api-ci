/**
 * Default notification templates — NOTIFICATION_WORKFLOWS.md §4 (per-event content, DRAFT wording),
 * §10 (template management). Code only: not wired into `prisma/seed/index.ts` and never run by the
 * B8 increment; call `seedNotificationTemplates(db)` when the owner approves the wording.
 *
 * - One row per (event, channel, locale `en-IN`). WhatsApp rows reference DRAFT template names
 *   (`<event>_v1`) with `whatsapp_approval_status = DRAFT` — they are skipped at send time until a
 *   BSP approves them (OQ-08). Bodies are the approved-text placeholders from §4, not final copy.
 * - Variants (OQ-82 `ALREADY_REGISTERED`, OQ-83 `ACCOUNT_SUSPENDED`, OQ-59 `LATE_CAPTURE`, §4.11
 *   `COD` out-for-delivery → WhatsApp `order_out_for_delivery_cod_v1`, DRAFT) live in the
 *   `variables` JSON (see notifications.templates.ts).
 * - Token-bearing events (verification, reset, staff invite) are seeded for completeness but are
 *   currently sent by the auth module directly (not through the outbox).
 * - Idempotent: upsert by (event, channel, locale); existing rows are NEVER overwritten (staff edits
 *   win) — only missing rows are created.
 */
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { NotificationChannel, NotificationEvent } from '../../src/generated/prisma/enums.js';
import type { Queryable } from '../../src/core/db/transaction.js';
import { EVENT_SPECS } from '../../src/modules/notifications/notifications.catalog.js';

export const TEMPLATE_LOCALE = 'en-IN';

export interface NotificationTemplateSeedRow {
  readonly event: NotificationEvent;
  readonly channel: NotificationChannel;
  readonly locale: string;
  readonly name: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly whatsappTemplateName: string | null;
  readonly whatsappLanguage: string | null;
  readonly whatsappApprovalStatus: string | null;
  readonly variables: Prisma.InputJsonValue;
}

interface EmailSpec {
  readonly subject: string;
  readonly body: string;
  readonly variants?: Readonly<Record<string, { subject: string; body: string }>>;
}

interface Spec {
  readonly email: EmailSpec;
  /** WhatsApp parameter order ({{1}}, {{2}}, …); absent = email only. */
  readonly whatsapp?: readonly string[];
  /** WhatsApp variants: own DRAFT provider template name + parameter order. */
  readonly whatsappVariants?: Readonly<
    Record<string, { whatsappTemplateName: string; order: readonly string[] }>
  >;
}

const FOOTER = '<p>Need help? Write to {{supportEmail}}.</p><p>— {{brandName}}</p>';
const p = (...lines: string[]): string => `${lines.map((l) => `<p>${l}</p>`).join('')}${FOOTER}`;
const orderLink = '<a href="{{orderUrl}}">View your order</a>';

const SPECS: Readonly<Record<NotificationEvent, Spec>> = {
  USER_REGISTERED: {
    email: {
      subject: 'Welcome to {{brandName}}, {{firstName}}',
      body: p(
        'Hi {{firstName}},',
        'Your account is ready.',
        '<a href="{{accountUrl}}">Go to your account</a>',
      ),
      variants: {
        ALREADY_REGISTERED: {
          subject: 'You already have a {{brandName}} account',
          body: p(
            'Hi {{firstName}},',
            'Someone tried to register with this email, but an account already exists.',
            '<a href="{{loginUrl}}">Sign in</a> or reset your password from the sign-in page.',
          ),
        },
      },
    },
    whatsapp: ['firstName'],
  },
  VERIFICATION_REQUESTED: {
    email: {
      subject: 'Verify your email for {{brandName}}',
      body: p(
        'Hi {{firstName}},',
        '<a href="{{verifyUrl}}">Verify your email</a>',
        'This link is valid for {{expiresInHours}} hours. If you did not create an account, ignore this email.',
      ),
    },
  },
  PASSWORD_RESET_REQUESTED: {
    email: {
      subject: 'Reset your {{brandName}} password',
      body: p(
        'Hi {{firstName}},',
        '<a href="{{resetUrl}}">Reset your password</a>',
        'The link is valid for {{expiresInMinutes}} minutes and can be used once. If you did not request this, ignore this email.',
      ),
    },
  },
  PASSWORD_CHANGED: {
    email: {
      subject: 'Your {{brandName}} password was changed',
      body: p(
        'Hi {{firstName}},',
        'Your password was changed on {{changedAt}}. All other devices were signed out.',
        'If this was not you, <a href="{{accountRecoveryUrl}}">reset your password</a> immediately.',
      ),
    },
    whatsapp: ['firstName', 'changedAt'],
  },
  ORDER_PLACED: {
    email: {
      subject: "We've received your order {{orderNumber}}",
      body: p(
        'Hi {{firstName}},',
        'Order {{orderNumber}} for ₹{{amount}} ({{paymentMethod}}) has been received.',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'amount', 'paymentMethod', 'orderUrl'],
  },
  ORDER_CONFIRMED: {
    email: {
      subject: 'Order confirmed — {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'Thank you! Your order {{orderNumber}} of ₹{{amount}} is confirmed.',
        'Your invoice will be available once the order ships.',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'amount', 'orderUrl'],
  },
  PAYMENT_SUCCEEDED: {
    email: {
      subject: 'Payment received for {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'We received ₹{{amount}} for order {{orderNumber}} ({{paymentMethod}}).',
        orderLink,
      ),
    },
    whatsapp: ['amount', 'orderNumber', 'paymentMethod'],
  },
  PAYMENT_FAILED: {
    email: {
      subject: 'Payment unsuccessful for order {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'Your payment for order {{orderNumber}} did not go through. You can retry within {{retryMinutes}} minutes.',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'retryMinutes'],
  },
  INVOICE_AVAILABLE: {
    email: {
      subject: 'Your invoice for order {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'Tax invoice {{invoiceNumber}} for order {{orderNumber}} is available in your account.',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'invoiceNumber', 'orderNumber'],
  },
  ORDER_PROCESSING: {
    email: {
      subject: "We're preparing your order {{orderNumber}}",
      body: p(
        'Hi {{firstName}},',
        'Your order {{orderNumber}} is being prepared and will be dispatched soon.',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber'],
  },
  ORDER_SHIPPED: {
    email: {
      subject: 'Your order {{orderNumber}} has shipped',
      body: p(
        'Hi {{firstName}},',
        'Shipment {{shipmentNumber}} of order {{orderNumber}} is on its way with {{courier}} (AWB {{awb}}).',
        '<a href="{{trackingUrl}}">Track your parcel</a>',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'courier', 'awb', 'expectedDelivery'],
  },
  ORDER_OUT_FOR_DELIVERY: {
    email: {
      subject: 'Out for delivery: {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'Your order {{orderNumber}} is out for delivery today. Please keep your phone reachable.',
        orderLink,
      ),
      variants: {
        // §4.11 COD: amount = the order's stored payable total (`codAmount`), never card/UPI data.
        COD: {
          subject: 'Out for delivery: {{orderNumber}}',
          body: p(
            'Hi {{firstName}},',
            'Your order {{orderNumber}} is out for delivery today. Please keep your phone reachable.',
            'Amount to pay: ₹{{codAmount}}',
            orderLink,
          ),
        },
      },
    },
    whatsapp: ['firstName', 'orderNumber'],
    whatsappVariants: {
      COD: {
        whatsappTemplateName: 'order_out_for_delivery_cod_v1',
        order: ['firstName', 'orderNumber', 'codAmount'],
      },
    },
  },
  ORDER_DELIVERED: {
    email: {
      subject: 'Delivered: your order {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'Your order {{orderNumber}} has been delivered. We hope you love it!',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'helpUrl'],
  },
  ORDER_CANCELLED: {
    email: {
      subject: 'Your order {{orderNumber}} has been cancelled',
      body: p(
        'Hi {{firstName}},',
        'Your order {{orderNumber}} has been cancelled. {{refundNote}}',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'refundNote'],
  },
  REFUND_INITIATED: {
    email: {
      subject: 'Refund initiated for order {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'Refund {{refundNumber}} of ₹{{amount}} has been initiated to your {{methodLabel}}. It usually reflects within {{businessDays}} business days.',
      ),
      variants: {
        LATE_CAPTURE: {
          subject: 'Refund of your payment for order {{orderNumber}}',
          body: p(
            'Hi {{firstName}},',
            'Your payment for order {{orderNumber}} arrived after the order had closed, so ₹{{amount}} is being refunded to your {{methodLabel}}.',
          ),
        },
      },
    },
    whatsapp: ['firstName', 'amount', 'orderNumber', 'methodLabel', 'businessDays'],
  },
  REFUND_COMPLETED: {
    email: {
      subject: 'Refund completed — ₹{{amount}}',
      body: p(
        'Hi {{firstName}},',
        'Your refund of ₹{{amount}} for order {{orderNumber}} has been processed. Reference: {{reference}}.',
      ),
    },
    whatsapp: ['firstName', 'amount', 'orderNumber', 'reference'],
  },
  LOW_STOCK_ALERT: {
    email: {
      subject: 'Low stock: {{count}} SKU(s) at or below threshold',
      body: p('{{summary}}', '<a href="{{inventoryUrl}}">Open inventory</a>'),
    },
  },
  STAFF_INVITED: {
    email: {
      subject: "You've been invited to {{brandName}} admin",
      body: p(
        '{{inviterName}} invited you to the admin panel.',
        '<a href="{{acceptUrl}}">Accept the invitation</a>',
        'The link expires in {{expiresInHours}} hours. If you were not expecting this, ignore this email.',
      ),
    },
  },
  CANCELLATION_REQUESTED: {
    email: {
      subject: "We've received your cancellation request for {{orderNumber}}",
      body: p(
        'Hi {{firstName}},',
        'We received your request to cancel order {{orderNumber}} and will update you shortly.',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber'],
  },
  CANCELLATION_REJECTED: {
    email: {
      subject: 'Update on your cancellation request for {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'We could not cancel order {{orderNumber}}. {{reason}}',
        orderLink,
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'reason'],
  },
  REFUND_REJECTED: {
    email: {
      subject: 'Update on your refund for order {{orderNumber}}',
      body: p(
        'Hi {{firstName}},',
        'Refund {{refundNumber}} for order {{orderNumber}} could not be approved. Reason: {{reason}}',
      ),
    },
    whatsapp: ['firstName', 'orderNumber', 'reason'],
  },
  SECURITY_ALERT: {
    email: {
      subject: 'New sign-in to your {{brandName}} account',
      body: p(
        'Hi {{firstName}},',
        'There was a new sign-in on {{signedInAt}} ({{device}}).',
        'If this was not you, <a href="{{accountRecoveryUrl}}">reset your password</a>.',
      ),
      variants: {
        ACCOUNT_SUSPENDED: {
          subject: 'Your {{brandName}} account has been suspended',
          body: p(
            'Hi {{firstName}},',
            'Your account has been suspended. Please contact {{supportEmail}} for help.',
          ),
        },
      },
    },
    whatsapp: ['firstName', 'signedInAt'],
  },
};

function humanize(event: NotificationEvent): string {
  return event
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Pure: the default template rows. */
export function buildNotificationTemplateRows(): NotificationTemplateSeedRow[] {
  const rows: NotificationTemplateSeedRow[] = [];
  for (const event of Object.keys(SPECS) as NotificationEvent[]) {
    const spec = SPECS[event];
    const allowed = [...EVENT_SPECS[event].variables];
    rows.push({
      event,
      channel: 'EMAIL',
      locale: TEMPLATE_LOCALE,
      name: `${humanize(event)} (email)`,
      subject: spec.email.subject,
      body: spec.email.body,
      whatsappTemplateName: null,
      whatsappLanguage: null,
      whatsappApprovalStatus: null,
      variables: { allowed, order: [], variants: { ...(spec.email.variants ?? {}) } },
    });
    if (spec.whatsapp !== undefined) {
      rows.push({
        event,
        channel: 'WHATSAPP',
        locale: TEMPLATE_LOCALE,
        name: `${humanize(event)} (WhatsApp)`,
        subject: null,
        body: null,
        whatsappTemplateName: `${event.toLowerCase()}_v1`,
        whatsappLanguage: 'en',
        whatsappApprovalStatus: 'DRAFT',
        variables: {
          allowed,
          order: [...spec.whatsapp],
          variants: Object.fromEntries(
            Object.entries(spec.whatsappVariants ?? {}).map(([key, v]) => [
              key,
              { whatsappTemplateName: v.whatsappTemplateName, order: [...v.order] },
            ]),
          ),
        },
      });
    }
  }
  return rows;
}

/** Creates missing templates; never overwrites existing (possibly staff-edited) rows. */
export async function seedNotificationTemplates(db: Queryable): Promise<{ total: number }> {
  const rows = buildNotificationTemplateRows();
  for (const row of rows) {
    await db.notificationTemplate.upsert({
      where: {
        event_channel_locale: { event: row.event, channel: row.channel, locale: row.locale },
      },
      create: { ...row, version: 1, isActive: true },
      update: {},
    });
  }
  return { total: rows.length };
}
