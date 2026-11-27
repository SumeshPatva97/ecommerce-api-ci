/**
 * DEC-12 — vitest per-file setup of the real-database suite (defence in depth).
 *
 * Runs inside the worker BEFORE each `*.dbtest.ts` file is imported and repeats the guard, so a
 * scenario file can never be evaluated in a process whose environment fails the guard (for
 * example when the file is started through another configuration that lists this setup file).
 * Imports the pure guard only.
 */
import { resolveDbTestTarget } from '../harness/guard.js';

resolveDbTestTarget(process.env);
