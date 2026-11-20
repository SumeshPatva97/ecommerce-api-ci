/**
 * Prisma error → canonical AppError (BACKEND_STRUCTURE.md §21).
 *
 * | Prisma | Meaning                         | Canonical            |
 * | P2002  | unique constraint               | 409 DUPLICATE_RESOURCE |
 * | P2003  | foreign key constraint          | 409 CONFLICT         |
 * | P2025  | record not found (update/delete)| 404 NOT_FOUND        |
 * | P2034  | write conflict / deadlock       | 409 CONFLICT         |
 * | P1001/P1002/P1017 | DB unreachable       | 503 SERVICE_UNAVAILABLE |
 *
 * Never echoes SQL, values or constraint internals beyond the field names Prisma reports.
 */
import { AppError } from './AppError.js';

interface PrismaLikeError {
  code: string;
  meta?: Record<string, unknown>;
  clientVersion?: string;
}

export function isPrismaKnownError(error: unknown): error is PrismaLikeError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; clientVersion?: unknown; name?: unknown };
  return (
    typeof candidate.code === 'string' &&
    /^P\d{4}$/.test(candidate.code) &&
    (typeof candidate.clientVersion === 'string' ||
      candidate.name === 'PrismaClientKnownRequestError')
  );
}

function targetFields(meta: Record<string, unknown> | undefined): string[] {
  const target = meta?.target;
  if (Array.isArray(target)) return target.filter((t): t is string => typeof t === 'string');
  if (typeof target === 'string') return [target];
  return [];
}

export function mapPrismaError(error: unknown): AppError | undefined {
  if (!isPrismaKnownError(error)) return undefined;
  switch (error.code) {
    case 'P2002': {
      const fields = targetFields(error.meta);
      return new AppError('DUPLICATE_RESOURCE', undefined, {
        cause: error,
        ...(fields.length > 0
          ? { details: fields.map((field) => ({ field, message: 'Must be unique.' })) }
          : {}),
      });
    }
    case 'P2003':
      return new AppError('CONFLICT', 'The operation conflicts with related records.', {
        cause: error,
      });
    case 'P2025':
      return new AppError('NOT_FOUND', undefined, { cause: error });
    case 'P2034':
      return new AppError('CONFLICT', 'The resource is busy. Please retry.', { cause: error });
    case 'P1001':
    case 'P1002':
    case 'P1017':
      return new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error });
    default:
      return undefined;
  }
}
