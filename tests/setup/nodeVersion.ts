/**
 * Vitest global setup: refuse to run on an unsupported Node.js (package.json engines >= 22.13.0).
 * Without this, the native argon2 module segfaults on Node 22.12.0 and vitest only reports
 * "Worker exited unexpectedly".
 */
import { assertSupportedNode } from '../../src/core/runtime/nodeVersion.js';

export default function setup(): void {
  assertSupportedNode();
}
