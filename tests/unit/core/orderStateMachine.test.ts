import { describe, expect, it } from 'vitest';

import {
  ORDER_TRANSITIONS,
  canTransition,
  customerCancelMode,
  initialOrderStatus,
  staffCanCancel,
} from '../../../src/lib/orderStateMachine.js';

describe('order state machine (PROJECT_CONTEXT §5.1)', () => {
  it('covers all 12 statuses and the canonical edges', () => {
    expect(Object.keys(ORDER_TRANSITIONS)).toHaveLength(12);
    expect(canTransition('PENDING_PAYMENT', 'CONFIRMED')).toBe(true);
    expect(canTransition('PAYMENT_FAILED', 'PENDING_PAYMENT')).toBe(true);
    expect(canTransition('CANCELLATION_REQUESTED', 'PROCESSING')).toBe(true);
    expect(canTransition('SHIPPED', 'CANCELLED')).toBe(false);
    expect(canTransition('PACKED', 'PROCESSING')).toBe(false);
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(false);
  });

  it('applies the OQ-12 cancellation policy and initial status', () => {
    expect(customerCancelMode('CONFIRMED')).toBe('DIRECT');
    expect(customerCancelMode('PROCESSING')).toBe('REQUEST');
    expect(customerCancelMode('PACKED')).toBe('NOT_ALLOWED');
    expect(staffCanCancel('PACKED')).toBe(true);
    expect(staffCanCancel('SHIPPED')).toBe(false);
    expect(staffCanCancel('PAYMENT_FAILED')).toBe(false);
    expect(initialOrderStatus('COD')).toBe('CONFIRMED');
    expect(initialOrderStatus('ONLINE')).toBe('PENDING_PAYMENT');
  });
});
