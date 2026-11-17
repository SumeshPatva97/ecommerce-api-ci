/**
 * Readiness registry (BACKEND_STRUCTURE.md §22). Dependency checks (MySQL `SELECT 1`, Redis
 * `PING`) are registered by the increments that introduce those dependencies; until then the
 * only readiness condition is "not shutting down".
 */
export type ReadinessCheck = () => Promise<void>;
export type CheckStatus = 'ok' | 'fail';

export interface ReadinessReport {
  ready: boolean;
  shuttingDown: boolean;
  checks: Record<string, CheckStatus>;
}

const DEFAULT_CHECK_TIMEOUT_MS = 1000;

function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('readiness check timed out'));
    }, timeoutMs);
    check().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('readiness check failed'));
      },
    );
  });
}

export class Readiness {
  private readonly checks = new Map<string, ReadinessCheck>();
  private shuttingDown = false;

  constructor(private readonly timeoutMs = DEFAULT_CHECK_TIMEOUT_MS) {}

  register(name: string, check: ReadinessCheck): void {
    if (this.checks.has(name)) throw new Error(`Readiness check "${name}" already registered`);
    this.checks.set(name, check);
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async evaluate(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      [...this.checks.entries()].map(async ([name, check]): Promise<[string, CheckStatus]> => {
        try {
          await withTimeout(check, this.timeoutMs);
          return [name, 'ok'];
        } catch {
          return [name, 'fail'];
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const allOk = entries.every(([, status]) => status === 'ok');
    return { ready: allOk && !this.shuttingDown, shuttingDown: this.shuttingDown, checks };
  }
}
