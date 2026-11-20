/**
 * System settings — zod schemas (API_DOCUMENTATION.md §4.16 "Settings", DATABASE_DESIGN.md §13.11).
 *
 * PATCH body: a partial set of typed changes, each carrying the row `version` read by the client
 * (optimistic concurrency, §13.11: `UPDATE … WHERE setting_key = ? AND version = ?`).
 */
import { z } from 'zod';

const settingKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, {
  message: 'Unknown setting key format.',
});

export const AdminSettingsQuery = z.object({
  group: z
    .string()
    .regex(/^[a-z_]{1,50}$/)
    .optional(),
});
export type AdminSettingsQuery = z.output<typeof AdminSettingsQuery>;

export const PatchSettingsBody = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        key: settingKey.max(100),
        value: z.json(),
        version: z.number().int().min(1),
      }),
    )
    .min(1)
    .max(50)
    .refine((rows) => new Set(rows.map((r) => r.key)).size === rows.length, {
      message: 'Each setting may appear once.',
    }),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type PatchSettingsBody = z.output<typeof PatchSettingsBody>;
