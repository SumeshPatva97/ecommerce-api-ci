import { describe, expect, it } from 'vitest';

import {
  MIN_NODE_VERSION,
  assertSupportedNode,
  isSupportedNode,
} from '../../../src/core/runtime/nodeVersion.js';

describe('Node.js runtime guard (engines >= 22.13.0)', () => {
  it('accepts the minimum and newer versions, rejects older ones', () => {
    expect(MIN_NODE_VERSION).toBe('22.13.0');
    expect(isSupportedNode('22.13.0')).toBe(true);
    expect(isSupportedNode('v22.20.1')).toBe(true);
    expect(isSupportedNode('24.12.0')).toBe(true);
    expect(isSupportedNode('22.12.0')).toBe(false);
    expect(isSupportedNode('20.18.0')).toBe(false);
  });

  it('throws a clear, actionable message on an unsupported runtime', () => {
    expect(() => {
      assertSupportedNode('22.12.0');
    }).toThrow(/Node\.js 22\.12\.0 is not supported: ecommerce-api requires >= 22\.13\.0/);
    expect(() => {
      assertSupportedNode('24.12.0');
    }).not.toThrow();
  });
});
