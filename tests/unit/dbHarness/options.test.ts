/**
 * DEC-12 harness options (tests/db/harness/options.ts) — pure, no database.
 */
import { describe, expect, it } from 'vitest';

import {
  DB_TEST_ITERATIONS_VAR,
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS,
  resolveIterations,
} from '../../db/harness/options.js';

describe('DEC-12 harness options — DB_TESTS_ITERATIONS', () => {
  it.each([[undefined], [''], ['   ']])('defaults when the variable is %s', (value) => {
    expect(resolveIterations({ [DB_TEST_ITERATIONS_VAR]: value })).toBe(DEFAULT_ITERATIONS);
    expect(resolveIterations({ [DB_TEST_ITERATIONS_VAR]: value }, 7)).toBe(7);
  });

  it.each([
    ['1', 1],
    ['5', 5],
    [' 20 ', 20],
    [String(MAX_ITERATIONS), MAX_ITERATIONS],
  ])('accepts %s', (value, expected) => {
    expect(resolveIterations({ [DB_TEST_ITERATIONS_VAR]: value })).toBe(expected);
  });

  it.each([['0'], ['51'], ['100'], ['-1'], ['1.5'], ['five'], ['1e1'], ['0x10'], ['3;']])(
    'refuses %s instead of silently replacing it',
    (value) => {
      expect(() => resolveIterations({ [DB_TEST_ITERATIONS_VAR]: value })).toThrow(
        DB_TEST_ITERATIONS_VAR,
      );
    },
  );
});
