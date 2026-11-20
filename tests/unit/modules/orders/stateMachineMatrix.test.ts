/**
 * TC-054 — order state machine: invalid transitions rejected (exhaustive).
 *
 * Asserts `canTransition` (src/lib/orderStateMachine.ts) for the FULL OrderStatus × OrderStatus
 * cross product (generated from the Prisma enum, so a new status extends the matrix automatically
 * and fails until it is classified), against an explicit, hand-written expected edge list.
 * Separately compares the implemented edge set with the documented one:
 * - PROJECT_CONTEXT.md §5.1 "Order state machine (canonical)" (mermaid diagram) — authoritative;
 * - ADMIN_WORKFLOWS.md §7.1 "State flow (staff-driven portion)" — must be a subset;
 * - ORDER_PAYMENT_AND_REFUND_DATABASE_DESIGN.md §4 defers to PROJECT_CONTEXT §5.1.
 * Doc-vs-code differences are not bent into the expectation: each is listed in KNOWN_CONFLICTS
 * and recorded as `it.todo` (see report). Pure — no DB.
 */
import { describe, expect, it } from 'vitest';

import { OrderStatus } from '../../../../src/generated/prisma/enums.js';
import {
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
  canTransition,
  initialOrderStatus,
  staffCanCancel,
} from '../../../../src/lib/orderStateMachine.js';

type Edge = `${OrderStatus}->${OrderStatus}`;
const edge = (from: OrderStatus, to: OrderStatus): Edge => `${from}->${to}`;

const STATUSES = Object.values(OrderStatus);

/** PROJECT_CONTEXT.md §5.1 mermaid diagram (excluding [*] start/end markers) — 17 edges. */
const DOC_CANONICAL: readonly Edge[] = [
  'PENDING_PAYMENT->CONFIRMED', // payment CAPTURED
  'PENDING_PAYMENT->PAYMENT_FAILED', // payment failed / reservation expired
  'PAYMENT_FAILED->PENDING_PAYMENT', // customer retries
  'CONFIRMED->PROCESSING',
  'PROCESSING->PACKED',
  'PACKED->SHIPPED',
  'SHIPPED->OUT_FOR_DELIVERY',
  'OUT_FOR_DELIVERY->DELIVERED',
  'CONFIRMED->CANCELLATION_REQUESTED', // customer request
  'PROCESSING->CANCELLATION_REQUESTED', // customer request
  'CANCELLATION_REQUESTED->CANCELLED', // approved
  'CANCELLATION_REQUESTED->PROCESSING', // rejected
  'CONFIRMED->CANCELLED', // admin / customer direct cancel (OQ-12)
  'PROCESSING->CANCELLED', // admin
  'PACKED->CANCELLED', // admin
  'DELIVERED->RETURN_REQUESTED', // OQ-11
  'RETURN_REQUESTED->RETURNED', // OQ-11
];

/** ADMIN_WORKFLOWS.md §7.1 (staff-driven portion only) — 11 edges, must all be implemented. */
const DOC_ADMIN_7_1: readonly Edge[] = [
  'CONFIRMED->PROCESSING',
  'PROCESSING->PACKED',
  'PACKED->SHIPPED',
  'SHIPPED->OUT_FOR_DELIVERY',
  'OUT_FOR_DELIVERY->DELIVERED',
  'PROCESSING->CANCELLATION_REQUESTED',
  'CANCELLATION_REQUESTED->CANCELLED',
  'CANCELLATION_REQUESTED->PROCESSING',
  'CONFIRMED->CANCELLED',
  'PROCESSING->CANCELLED',
  'PACKED->CANCELLED',
];

/**
 * Known differences between the §5.1 diagram and the implementation. `code` = implemented?
 * Each is reported as an it.todo; the comparison test fails on any difference NOT listed here.
 */
const KNOWN_CONFLICTS: readonly { edge: Edge; doc: boolean; code: boolean; note: string }[] = [
  {
    edge: 'PAYMENT_FAILED->CANCELLED',
    doc: false,
    code: true,
    note: 'absent from the PROJECT_CONTEXT §5.1 diagram; code adds it as PROVISIONAL auto-cancel per OQ-58 / R-06 (PROJECT_CONTEXT §15, USER_WORKFLOWS §15.6 "auto-CANCELLED")',
  },
];

/** Expected implemented edges, written out literally (independent of ORDER_TRANSITIONS). */
const EXPECTED_ALLOWED: ReadonlySet<Edge> = new Set<Edge>([
  'PENDING_PAYMENT->CONFIRMED',
  'PENDING_PAYMENT->PAYMENT_FAILED',
  'PAYMENT_FAILED->PENDING_PAYMENT',
  'PAYMENT_FAILED->CANCELLED',
  'CONFIRMED->PROCESSING',
  'CONFIRMED->CANCELLATION_REQUESTED',
  'CONFIRMED->CANCELLED',
  'PROCESSING->PACKED',
  'PROCESSING->CANCELLATION_REQUESTED',
  'PROCESSING->CANCELLED',
  'PACKED->SHIPPED',
  'PACKED->CANCELLED',
  'SHIPPED->OUT_FOR_DELIVERY',
  'OUT_FOR_DELIVERY->DELIVERED',
  'DELIVERED->RETURN_REQUESTED',
  'CANCELLATION_REQUESTED->CANCELLED',
  'CANCELLATION_REQUESTED->PROCESSING',
  'RETURN_REQUESTED->RETURNED',
]);

const PAIRS: readonly (readonly [OrderStatus, OrderStatus])[] = STATUSES.flatMap((from) =>
  STATUSES.map((to) => [from, to] as const),
);

const IMPLEMENTED: ReadonlySet<Edge> = new Set(
  STATUSES.flatMap((from) => ORDER_TRANSITIONS[from].map((to) => edge(from, to))),
);

describe('TC-054 matrix shape', () => {
  it('covers all 12 OrderStatus values and the full 12 × 12 = 144 cross product', () => {
    expect(STATUSES).toHaveLength(12);
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...STATUSES].sort());
    expect(PAIRS).toHaveLength(STATUSES.length * STATUSES.length);
    expect(new Set(PAIRS.map(([f, t]) => edge(f, t))).size).toBe(144);
  });

  it('every expected edge uses real statuses (no typos in the table)', () => {
    for (const e of [...EXPECTED_ALLOWED, ...DOC_CANONICAL, ...DOC_ADMIN_7_1]) {
      const [from, to] = e.split('->');
      expect(STATUSES).toContain(from);
      expect(STATUSES).toContain(to);
    }
  });
});

describe('TC-054 canTransition — exhaustive (every ordered pair)', () => {
  it.each(PAIRS)('%s → %s', (from, to) => {
    const expected = EXPECTED_ALLOWED.has(edge(from, to));
    expect(canTransition(from, to)).toBe(expected);
    expect(ORDER_TRANSITIONS[from].includes(to)).toBe(expected);
  });

  it('allows exactly 18 edges and rejects the other 126 pairs', () => {
    const allowed = PAIRS.filter(([f, t]) => canTransition(f, t));
    expect(allowed).toHaveLength(18);
    expect(PAIRS.length - allowed.length).toBe(126);
    expect(new Set(allowed.map(([f, t]) => edge(f, t)))).toEqual(EXPECTED_ALLOWED);
  });

  it.each(STATUSES)('%s → itself (self-transition) is rejected', (status) => {
    expect(canTransition(status, status)).toBe(false);
  });

  it.each(TERMINAL_ORDER_STATUSES)('terminal %s has no outgoing transition', (status) => {
    expect(STATUSES.filter((to) => canTransition(status, to))).toEqual([]);
  });

  it('terminal statuses are exactly CANCELLED and RETURNED; no edge leaves them', () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(['CANCELLED', 'RETURNED']);
    const withoutOutgoing = STATUSES.filter((s) => ORDER_TRANSITIONS[s].length === 0);
    expect(withoutOutgoing.sort()).toEqual(['CANCELLED', 'RETURNED']);
  });

  it('no transition leads back into PENDING_PAYMENT except the PAYMENT_FAILED retry', () => {
    const into = STATUSES.filter((s) => canTransition(s, 'PENDING_PAYMENT'));
    expect(into).toEqual(['PAYMENT_FAILED']);
  });

  it('nothing can be cancelled once SHIPPED (SHIPPED / OUT_FOR_DELIVERY / DELIVERED)', () => {
    for (const s of ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const) {
      expect(canTransition(s, 'CANCELLED')).toBe(false);
      expect(canTransition(s, 'CANCELLATION_REQUESTED')).toBe(false);
    }
  });

  it('every status is reachable from an initial status (ONLINE / COD)', () => {
    const seen = new Set<OrderStatus>([initialOrderStatus('ONLINE'), initialOrderStatus('COD')]);
    const queue = [...seen];
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      for (const to of ORDER_TRANSITIONS[s]) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...STATUSES].sort());
  });

  it.each(STATUSES)('staffCanCancel(%s) matches "admin only, before SHIPPED" (OQ-12)', (s) => {
    expect(staffCanCancel(s)).toBe(['CONFIRMED', 'PROCESSING', 'PACKED'].includes(s));
  });
});

describe('TC-054 documented vs implemented transitions', () => {
  const docSet = new Set<Edge>(DOC_CANONICAL);
  const docOnly = [...docSet].filter((e) => !IMPLEMENTED.has(e));
  const codeOnly = [...IMPLEMENTED].filter((e) => !docSet.has(e));

  it('PROJECT_CONTEXT §5.1 lists 17 edges; implementation has 18', () => {
    expect(docSet.size).toBe(17);
    expect(IMPLEMENTED.size).toBe(18);
  });

  it('documented set equals implemented set apart from the listed KNOWN_CONFLICTS', () => {
    const differences = [
      ...docOnly.map((e) => ({ edge: e, doc: true, code: false })),
      ...codeOnly.map((e) => ({ edge: e, doc: false, code: true })),
    ].sort((a, b) => a.edge.localeCompare(b.edge));
    expect(differences).toEqual(
      KNOWN_CONFLICTS.map(({ edge: e, doc, code }) => ({ edge: e, doc, code })).sort((a, b) =>
        a.edge.localeCompare(b.edge),
      ),
    );
  });

  it('every documented §5.1 edge is implemented (no doc-only edge)', () => {
    expect(docOnly).toEqual([]);
  });

  it('ADMIN_WORKFLOWS §7.1 staff-driven edges are all implemented and all in §5.1', () => {
    for (const e of DOC_ADMIN_7_1) {
      expect(IMPLEMENTED.has(e), e).toBe(true);
      expect(docSet.has(e), e).toBe(true);
    }
  });

  for (const c of KNOWN_CONFLICTS) {
    const [from, to] = c.edge.split('->');
    it.todo(
      `${String(from)} → ${String(to)} — CONFLICT: doc says ${c.doc ? 'allowed' : 'not in diagram'}, code says ${c.code ? 'allowed' : 'rejected'} (${c.note})`,
    );
  }
});
