/**
 * DEC-12 — optional run parameters of the real-database harness. Pure (the caller passes the
 * environment), unit-tested in the default suite (`tests/unit/dbHarness/options.test.ts`).
 *
 * `DB_TESTS_ITERATIONS` — how many times each scenario is repeated (fresh data per iteration).
 * TESTING_STRATEGY §8 asks for 5 iterations in PR CI and ≥ 20 nightly; the default here is 3 so
 * a first owner run stays short. A value that is not an integer 1–50 is refused (fail closed)
 * rather than silently replaced.
 */
export const DB_TEST_ITERATIONS_VAR = 'DB_TESTS_ITERATIONS';
export const DEFAULT_ITERATIONS = 3;
export const MAX_ITERATIONS = 50;

type Env = Readonly<Record<string, string | undefined>>;

export function resolveIterations(env: Env, fallback: number = DEFAULT_ITERATIONS): number {
  const raw = (env[DB_TEST_ITERATIONS_VAR] ?? '').trim();
  if (raw === '') return fallback;
  if (!/^\d{1,2}$/.test(raw)) {
    throw new Error(`${DB_TEST_ITERATIONS_VAR} must be an integer from 1 to ${MAX_ITERATIONS}.`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_ITERATIONS) {
    throw new Error(`${DB_TEST_ITERATIONS_VAR} must be an integer from 1 to ${MAX_ITERATIONS}.`);
  }
  return value;
}
