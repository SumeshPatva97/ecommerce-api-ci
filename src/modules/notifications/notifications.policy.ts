/**
 * Consent decision at send time — NOTIFICATION_WORKFLOWS.md §5.1/§5.3 (opt-outs re-checked by the
 * worker), API_DOCUMENTATION.md §3.2. Pure. PROVISIONAL (OQ-38 legal review pending).
 *
 * | Channel  | TRANSACTIONAL              | MARKETING             | STAFF_ALERTS            |
 * | EMAIL    | always sent (essential)    | explicit opt-in only  | explicit opt-in (OQ-47) |
 * | WHATSAPP | explicit opt-in only       | explicit opt-in only  | never (no staff WA, v1) |
 */
import type { NotificationCategory, NotificationChannel } from '../../generated/prisma/enums.js';

export interface PreferenceRow {
  readonly channel: NotificationChannel;
  readonly category: NotificationCategory;
  readonly isOptedIn: boolean;
}

export type ConsentDecision = 'ALLOW' | 'OPTED_OUT' | 'NO_CONSENT';

export function consentDecision(
  channel: NotificationChannel,
  category: NotificationCategory,
  prefs: readonly PreferenceRow[],
): ConsentDecision {
  if (channel === 'EMAIL' && category === 'TRANSACTIONAL') return 'ALLOW';
  if (channel === 'WHATSAPP' && category === 'STAFF_ALERTS') return 'NO_CONSENT';
  const row = prefs.find((p) => p.channel === channel && p.category === category);
  if (row === undefined) return 'NO_CONSENT';
  return row.isOptedIn ? 'ALLOW' : 'OPTED_OUT';
}
