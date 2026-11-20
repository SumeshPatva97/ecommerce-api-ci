/**
 * Customer PII masking for viewers without `customers.view` — REPORTING_AND_ANALYTICS.md §2 G9
 * (`r***@example.com`, `+91******3210`). Pure.
 */
import { hasPermission } from '../rbac/permission.service.js';
import type { Viewer } from './reports.types.js';

export function canSeeCustomers(viewer: Viewer): boolean {
  return hasPermission(viewer, 'customers.view');
}

export function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  if (phone.length <= 4) return '****';
  const prefix = phone.startsWith('+91') ? '+91' : '';
  const body = phone.slice(prefix.length);
  return `${prefix}${'*'.repeat(Math.max(0, body.length - 4))}${body.slice(-4)}`;
}

export function maskName(name: string | null): string | null {
  if (name === null) return null;
  return name
    .split(/\s+/)
    .filter((p) => p !== '')
    .map((p) => `${p.slice(0, 1)}***`)
    .join(' ');
}
