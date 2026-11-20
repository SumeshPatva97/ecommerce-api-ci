/**
 * Dashboard query — API_DOCUMENTATION.md §4.2: `from`, `to` (IST dates, default today),
 * `compareTo=previous_period` (comparisons are always included).
 */
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD (IST).' });

export const DashboardQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  compareTo: z.enum(['previous_period']).optional(),
});
export type DashboardQuery = z.output<typeof DashboardQuery>;
