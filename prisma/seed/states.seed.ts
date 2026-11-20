/**
 * Indian states / UTs with GST state codes — DATABASE_DESIGN.md §25.1 (reference data; codes and
 * UT/legislature flags to be verified by a qualified tax professional before production).
 *
 * The approved `State` model has no `is_active` column, so the two legacy codes marked inactive in
 * §25.1 (25 "Daman and Diu (legacy)", 28 "Andhra Pradesh (old code)") are NOT seeded — otherwise
 * they would be selectable for addresses. Idempotent: upsert by `code`.
 */
import type { Queryable } from '../../src/core/db/transaction.js';

export interface StateSeedRow {
  readonly code: string;
  readonly name: string;
  readonly isUnionTerritory: boolean;
  readonly hasLegislature: boolean;
}

type Raw = readonly [
  code: string,
  name: string,
  ut: boolean,
  legislature: boolean,
  active: boolean,
];

/** §25.1 verbatim (including inactive legacy codes, filtered out by `buildStateRows`). */
export const GST_STATES: readonly Raw[] = [
  ['01', 'Jammu and Kashmir', true, true, true],
  ['02', 'Himachal Pradesh', false, true, true],
  ['03', 'Punjab', false, true, true],
  ['04', 'Chandigarh', true, false, true],
  ['05', 'Uttarakhand', false, true, true],
  ['06', 'Haryana', false, true, true],
  ['07', 'Delhi', true, true, true],
  ['08', 'Rajasthan', false, true, true],
  ['09', 'Uttar Pradesh', false, true, true],
  ['10', 'Bihar', false, true, true],
  ['11', 'Sikkim', false, true, true],
  ['12', 'Arunachal Pradesh', false, true, true],
  ['13', 'Nagaland', false, true, true],
  ['14', 'Manipur', false, true, true],
  ['15', 'Mizoram', false, true, true],
  ['16', 'Tripura', false, true, true],
  ['17', 'Meghalaya', false, true, true],
  ['18', 'Assam', false, true, true],
  ['19', 'West Bengal', false, true, true],
  ['20', 'Jharkhand', false, true, true],
  ['21', 'Odisha', false, true, true],
  ['22', 'Chhattisgarh', false, true, true],
  ['23', 'Madhya Pradesh', false, true, true],
  ['24', 'Gujarat', false, true, true],
  ['25', 'Daman and Diu (legacy, merged)', true, false, false],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu', true, false, true],
  ['27', 'Maharashtra', false, true, true],
  ['28', 'Andhra Pradesh (old code)', false, true, false],
  ['29', 'Karnataka', false, true, true],
  ['30', 'Goa', false, true, true],
  ['31', 'Lakshadweep', true, false, true],
  ['32', 'Kerala', false, true, true],
  ['33', 'Tamil Nadu', false, true, true],
  ['34', 'Puducherry', true, true, true],
  ['35', 'Andaman and Nicobar Islands', true, false, true],
  ['36', 'Telangana', false, true, true],
  ['37', 'Andhra Pradesh', false, true, true],
  ['38', 'Ladakh', true, false, true],
  ['97', 'Other Territory', true, false, true],
];

/** Pure: the active rows the seed upserts. */
export function buildStateRows(raw: readonly Raw[] = GST_STATES): StateSeedRow[] {
  return raw
    .filter(([, , , , active]) => active)
    .map(([code, name, ut, legislature]) => ({
      code,
      name,
      isUnionTerritory: ut,
      hasLegislature: legislature,
    }));
}

export async function seedStates(db: Queryable): Promise<{ upserted: number }> {
  const rows = buildStateRows();
  for (const row of rows) {
    await db.state.upsert({
      where: { code: row.code },
      create: row,
      update: {
        name: row.name,
        isUnionTerritory: row.isUnionTerritory,
        hasLegislature: row.hasLegislature,
      },
    });
  }
  return { upserted: rows.length };
}
