/**
 * Audit helpers for catalog masters — ROLE_PERMISSION_AND_AUDIT_LOGS.md §9 (catalog: CREATE,
 * UPDATE with diff, DELETE, RESTORE, STATUS_CHANGE).
 */
import type { AuditAction } from '../../generated/prisma/enums.js';

/**
 * `STATUS_CHANGE` when the only business change is the active flag, otherwise `UPDATE`
 * (both carry the field-level diff).
 */
export function updateAction(changedKeys: readonly string[]): AuditAction {
  const meaningful = changedKeys.filter((k) => k !== 'updatedById' && k !== 'updatedAt');
  return meaningful.length === 1 && meaningful[0] === 'isActive' ? 'STATUS_CHANGE' : 'UPDATE';
}

/** Keys whose values differ between two snapshots (shallow, JSON comparison). */
export function changedKeys(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  return Object.keys(patch).filter(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(patch[key] ?? null),
  );
}
