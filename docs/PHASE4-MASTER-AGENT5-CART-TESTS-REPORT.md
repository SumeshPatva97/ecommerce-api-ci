# Phase 4 Master Completion — Agent 5: Cart Tests (WP10-6)

| Field       | Value                  |
| ----------- | ---------------------- |
| Document ID | P4-MASTER-AGENT5       |
| Date        | 2026-11-24             |
| Executed by | Orchestrator           |
| Evidence    | Offline / mocked tests |

## Status

| Work package                  | Status           |
| ----------------------------- | ---------------- |
| WP10-6 Batch 8 cart test gaps | ALREADY COMPLETE |

The tests date from 2026-11-21. This workstream is test-only: the cart source
(`src/modules/cart/cart.service.ts`, `cart.repository.ts`) was last modified on 2026-11-20 (Batch 8
M1) and is unchanged. Nothing was changed in this run.

## Coverage of the required cases

| Required case                                  | Test                                                                                                                                                                    | Result |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Re-resolution creating a fresh cart (add item) | `cartTransactionalRace.test.ts`: "addItem: claim fails because the cart was converted and nothing else exists → re-resolution CREATES a new cart and writes only there" | Pass   |
| Re-resolution creating a fresh cart (merge)    | "merge: same re-resolution creates a new cart and every guest item lands in it"                                                                                         | Pass   |
| Add-item retry race, first claim fails         | "addItem retry: claim fails once (cart replaced) → re-resolves and adds the line only to the current cart"                                                              | Pass   |
| Add-item retry race, both claims fail          | "addItem retry: claim fails twice → 409 CONFLICT and no line is written"                                                                                                | Pass   |
| Exact boundary, 30-day abandon                 | `abandonedCarts.test.ts`: "WP10-6 exact boundary: idle exactly 30 days is kept; 1 ms more is abandoned"                                                                 | Pass   |
| Exact boundary, 90-day purge                   | "WP10-6 exact boundary: abandoned exactly 90 days is kept; 1 ms more is purged"                                                                                         | Pass   |
| Boundary with a configured window              | "WP10-6 boundary with a configured window: exactly N days is kept, N days + 1 ms abandoned"                                                                             | Pass   |

No production defect was found by these tests.

## Checks executed today

| Command                                                                                                                   | Result             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `npx vitest run tests/integration/modules/cart tests/unit/jobs/abandonedCarts.test.ts tests/unit/scripts/openapi.test.ts` | 5 files, 58 passed |

## Limits

Mocked transaction behaviour only. Real MySQL locking, isolation and uniqueness behaviour for the
cart remains pending (Batch 12, after the database gates).
