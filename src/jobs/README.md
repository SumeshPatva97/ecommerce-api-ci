# Background Jobs

**Status:** scheduler (`scheduler.ts`, `registry.ts`) run by the **dedicated worker process** (`src/worker.ts`, D-61, Batch 9 — accepted for offline mocked scope only, 2026-11-24); **off by default** (`JOBS_ENABLED=false`) and **exactly one worker process** may run. The API process never runs jobs. Tested with a mocked DB only. Full coverage table and deviations: [`docs/PHASE4-JOBS-AND-SCHEDULING.md`](../../docs/PHASE4-JOBS-AND-SCHEDULING.md).

## Decisions/constraints

- Redis/BullMQ deferred unless explicitly approved (PROJECT_CONTEXT D-38 / OQ-35). Until then there is no distributed lock, so never enable jobs on more than one process.
- Job handlers must be **idempotent**, observable (structured logs), and safe to retry.
- Sensitive payloads must follow the logging redaction policy.

## Files

| File                        | Job                                                           | Scheduled?                                    |
| --------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| `reservationExpiry.ts`      | `reservation-expiry` (1 min)                                  | yes                                           |
| `unpaidOrderCancel.ts`      | `unpaid-order-cancel` (5 min)                                 | yes                                           |
| `notificationDispatcher.ts` | `notification-dispatch` (15 s; covers `notification-retries`) | yes                                           |
| `paymentReconciliation.ts`  | `payment-reconciliation` (15 min)                             | yes                                           |
| `shipmentTrackingPoll.ts`   | `shipment-tracking-poll` (30 min; polling couriers only)      | yes                                           |
| `promotionActivation.ts`    | `promotion-activation` (1 min)                                | yes                                           |
| `catalogAggregates.ts`      | `best-seller-refresh`, `rating-aggregate` (24 h)              | yes                                           |
| `abandonedCarts.ts`         | `abandoned-carts` (1 h; RD-08 option B)                       | yes                                           |
| `tokenCleanup.ts`           | `token-cleanup` (24 h; 7-day verification grace PROPOSED)     | yes                                           |
| `reportExport.ts`           | `report-exports` worker                                       | no: needs a durable queue and private storage |
| `scheduler.ts`              | scheduler (overlap protection, stop signal for long jobs)     | n/a                                           |
| `registry.ts`               | job list started by the worker (`src/workerRuntime.ts`)       | n/a                                           |

## Adding a job

Add a `run*` function that takes explicit dependencies and returns a summary object, register it in `registry.ts` with a unique name and an interval of at least 1 s, and add a mocked-DB unit test that covers a re-run (idempotency) and a per-item failure.

Not implemented by decision: `low-stock-digest` (RD-09 = instant only). Start the worker with `npm run dev:worker` / `npm run start:worker` (with `JOBS_ENABLED=true` for the worker only); stop the old worker before starting a replacement. Multi-server / distributed scheduling is deferred (D-61).
