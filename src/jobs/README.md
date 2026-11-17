# Background Jobs — Architecture Scaffold (B0-c)

**Status:** scaffold only (no runtime job workers started, no Redis/BullMQ introduced).

## Decisions/constraints

- Redis/BullMQ deferred unless explicitly approved (PROJECT_CONTEXT D-38 / OQ-35). Do not add heavy infrastructure without documented justification and approval.
- Job handlers must be **idempotent**, observable (structured logs/correlation IDs), and safe to retry.
- Sensitive payloads must follow logging redaction policy.

## Planned job categories (per approved docs, to implement when scheduled)

- Notification dispatch (email/WhatsApp/in-app) via provider adapters
- Payment/webhook reconciliation and retry-safe post-processing (with strict idempotency)
- Inventory reservation expiry/cleanup (if approved)
- Report/export generation (async, authorized)
- Maintenance/cleanup tasks (tokens, idempotency keys, temp artifacts) per retention policy

## Implementation notes (future)

- Introduce a `JobRunner` interface with in-process/dev stub and an approved durable queue adapter when required.
- Register jobs with explicit names, schemas, retry/backoff policy, and dead-letter handling.
- Wire health/metrics and operational runbooks before production use.
