# Phase 4 — Remaining Decisions

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Document ID | P4-DEC-03                                                                                |
| Date        | 2026-11-19 (RD-08 … RD-13 added and RD-08/09/10/13 decided 2026-11-20)                   |
| Status      | **OPEN — owner input required** (nothing here is decided by this document)               |
| Resolved    | Decisions 1, 2, 5, 7 of 2026-11-19 → D-60, D-57, D-58, D-59 (`PROJECT_CONTEXT.md` §17.6) |

Each item states what is implemented today, the exact question, a recommendation and the impact.

## RD-01 — CGST/SGST odd-paisa rounding (tax-law question — PROVISIONAL)

**Implemented (`src/lib/tax/engine.ts` `computeRowTax`, marked PROVISIONAL OQ-23):**

1. Line tax = half-up to ₹0.01 of `value × r / (100 + r)` (GST-inclusive) or `value × r / 100` (exclusive).
2. SGST/UTGST = line tax ÷ 2, **truncated** to the paisa.
3. CGST = line tax − SGST (the odd paisa goes to **CGST**).
4. Invoice total rounded to the nearest ₹1 with a separate round-off line.

**Example** (API_DOCUMENTATION §3.9, taxable ₹3 394.37 at 3 %): line tax ₹101.83 → CGST ₹50.92 + SGST ₹50.91.
The alternative in TAX_AND_GST_WORKFLOWS examples A/C rounds each component independently
(`taxable × 1.5 %` half-up each) → CGST ₹50.92 + SGST ₹50.92 = ₹101.84 (one paisa more tax).

**Question for a qualified tax professional/CA:** for an intra-state supply, must CGST and SGST each be
computed and rounded independently, or may the total line tax be rounded once and split with the odd
paisa assigned to CGST? Does the answer change for invoice-level vs line-level rounding?

**Recommendation:** keep the current rule (it reproduces the API contract's worked example) until the
CA answers; switching is a one-function change plus fixture updates. **Not decided by engineering.**

**Answer needed from you:** _not now_ — only the CA's written answer, when available. Status stays
**PROVISIONAL** (OQ-23) until then.

## RD-02 — Five catalog routes outside the route catalogue

| Route                                 | Basis in approved material                                                                                                 | Recommendation                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /admin/categories/reorder`      | ADMIN_WIREFRAMES categories tree (drag reorder/re-parent, `categories.update`); permission text "Edit categories, reorder" | **Keep** — implements an approved UI requirement |
| `POST /admin/categories/:id/restore`  | OQ-39 working assumption "restore or rename"; canonical `RESTORE` audit action                                             | **Keep**                                         |
| `POST /admin/brands/:id/restore`      | same                                                                                                                       | **Keep**                                         |
| `POST /admin/collections/:id/restore` | same                                                                                                                       | **Keep**                                         |
| `POST /admin/attributes/:id/restore`  | same                                                                                                                       | **Keep**                                         |

All five are permission-guarded (restore uses `<module>.delete`, the inverse operation), audited
(`UPDATE` / `RESTORE`), tested, and now listed in API_DOCUMENTATION §4.4 as "implemented additions —
pending route-catalogue confirmation". **Question:** add them to PROJECT_CONTEXT §8.1? Nothing was
removed. If any is rejected, removal is a route-file change plus test update.

RD-02 is about **route-catalogue status only** (whether these five implemented admin routes become
canonical in PROJECT_CONTEXT §8.1); it does not change behaviour, permissions or data.

**Answer needed from you (explicit):** `RD-02 = add all five` (recommended) / `add some: …` / `remove all`.

## RD-03 — Schema changes (Phase 3 re-open)

See `PHASE3-SCHEMA-CHANGE-PROPOSAL.md` (P3-SCP-01): SCP-1 MFA recovery codes, SCP-2 staff password
history, SCP-3 review rejection reason, SCP-4 encrypted COD refund bank details, SCP-5 promotion
description/banner label, SCP-6 shipment tracking URL. **Recommendation:** approve per item, deliver
as one separate forward migration after G8 (keeps G6 valid). All remain **blocked** until approved.

## RD-04 — Customer/staff cancellation of unpaid orders (documentation conflict found)

**Verified conflict (re-read 2026-11-19):**

| Source                                                                    | Customer self-cancel                                                                            | Staff cancel                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| API_DOCUMENTATION §3.10 (`POST /me/orders/:orderNumber/cancel`)           | **Direct** from `PENDING_PAYMENT`, `PAYMENT_FAILED`, `CONFIRMED`; **request** from `PROCESSING` | —                                                                             |
| API_DOCUMENTATION §4.7 (`POST /admin/orders/:orderId/cancel`)             | —                                                                                               | From `PENDING_PAYMENT`, `PAYMENT_FAILED`, `CONFIRMED`, `PROCESSING`, `PACKED` |
| PROJECT_CONTEXT §5.1 state machine (canonical) + OQ-12 working assumption | Direct from `CONFIRMED`; request from `PROCESSING`                                              | `CONFIRMED`, `PROCESSING`, `PACKED`                                           |
| **Implemented today** (`src/lib/orderStateMachine.ts`)                    | `CONFIRMED` direct, `PROCESSING` request                                                        | `CONFIRMED`, `PROCESSING`, `PACKED`                                           |

Unpaid orders today leave `PENDING_PAYMENT` only via payment (`CONFIRMED`), failure/expiry
(`PAYMENT_FAILED`, reservation released by the expiry job) or the automatic unpaid-order job
(`PAYMENT_FAILED → CANCELLED`, OQ-58 PROVISIONAL).

**Proposed transition table (recommended):**

| From                             | To          | Staff (`orders.update` + `orders.approve`, D-58) | Customer (owner) | Side effects                                                                                                                                  |
| -------------------------------- | ----------- | ------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING_PAYMENT`                | `CANCELLED` | **Allow**                                        | **Allow**        | Release reservation (`RESERVATION_RELEASE`); coupon usage `RELEASED`; mark the open payment session `CANCELLED`; no refund (nothing captured) |
| `PAYMENT_FAILED`                 | `CANCELLED` | **Allow**                                        | **Allow**        | Reservation already released; coupon `RELEASED` if still reserved; no refund                                                                  |
| late capture after either cancel | —           | —                                                | —                | Existing OQ-59 path: payment captured for a `CANCELLED` order → automatic full refund (already implemented in the payments module)            |
| all other edges                  | unchanged   | —                                                | —                | —                                                                                                                                             |

Rationale: both API sections are client-approved contracts and the race with a late gateway capture is
already handled by the auto-refund path, so allowing both actors is safe; it also frees stock sooner.
Customer cancel of `PENDING_PAYMENT` must not be offered while the gateway checkout window is open in
the same session (frontend concern).

**Impact if approved:** two edges added to `ORDER_TRANSITIONS` and `customerCancelMode`/`staffCanCancel`,
PROJECT_CONTEXT §5.1 diagram + OQ-12 wording updated, tests for both actors and the late-capture refund.

**Answer needed from you (explicit), choose one:**

- `RD-04 = staff + customer` (recommended, matches API_DOCUMENTATION §3.10/§4.7);
- `RD-04 = staff only` (customer keeps CONFIRMED-only; API §3.10 updated to match);
- `RD-04 = keep canonical` (no manual cancel of unpaid orders; API §3.10 and §4.7 corrected to §5.1).

## RD-05 — Store legal name duplicate and footer visibility

`store.legal_name` (settings) and `tax.seller_legal_name` (tax module, used on invoices) duplicate the
same fact, like the GSTIN did. The storefront footer (DESIGN_SYSTEM) shows legal name + GSTIN; GSTIN is
now published from `tax.seller_gstin` (D-57) but `store.legal_name` is seeded non-public.
**Recommendation:** apply the D-57 pattern — canonical `tax.seller_legal_name`, publish it on
`/settings/public`, remove `store.legal_name`. Not changed without approval (decision 2 named only the
GSTIN and state code).

**Canonical setting:** `tax.seller_legal_name` — it is the value printed on tax invoices and credit
notes (`src/modules/invoices`), edited only through `PATCH /admin/tax/settings` (`tax.update` + re-auth),
and named by TAX_AND_GST_WORKFLOWS. `store.name` (trade/display name, already public) stays separate.

**Public exposure implications:**

- The registered legal name is a business identifier that already appears on every customer invoice;
  the GSTIN (already published since D-57) can be looked up publicly on the GST portal, which also shows
  the legal name. Publishing it adds no new disclosure beyond what invoices reveal.
- Indian e-commerce consumer-protection rules are commonly read as requiring the seller's legal name
  and address to be shown on the platform — **confirm with counsel**; this is not an engineering decision.
- `tax.seller_address` should **not** be published automatically by this change; footer address display
  would be a separate decision.
- Removing `store.legal_name` needs no data backfill (baseline not applied); any environment that already
  stored a value must copy it to `tax.seller_legal_name` first.

**Answer needed from you (explicit):** `RD-05 = canonical tax.seller_legal_name + public` (recommended) /
`canonical tax.seller_legal_name, not public` / `keep both keys`.

## RD-06 — Infrastructure and vendors (blockers maintained)

| Item                     | Implemented now                                                                                                                                                                     | Blocked until                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node line (OQ-110)       | `.nvmrc` 22, `engines >=22.13`; tests run on Node 24.12; CI runs Node 22                                                                                                            | Owner chooses 22-only or 22 + 24                                                                |
| Redis (OQ-35)            | In-memory stores (single instance) — see hardening report §5                                                                                                                        | Decision + provisioned Redis before any multi-instance deployment                               |
| Payment provider (OQ-06) | `PaymentProviderAdapter` + verifiable mock (signature, webhook, refund); optional `fetchOrderPayments` for reconciliation (2026-11-20)                                              | Vendor choice + sandbox credentials                                                             |
| Courier (OQ-07)          | `ShippingProviderAdapter` + mock (rates, booking, tracking webhook); registry in the container, optional `SHIPPING_WEBHOOK_SECRET`, optional `getTracking` for polling (2026-11-20) | Vendor choice + credentials                                                                     |
| Email / WhatsApp (OQ-08) | Fake email adapter (outbox), mock WhatsApp, notification dispatcher                                                                                                                 | Vendor choice; then `POST /webhooks/email` and `/webhooks/whatsapp` (signature schemes unknown) |
| CAPTCHA (OQ-71 vendor)   | Threshold logic; `CAPTCHA_PROVIDER=none`                                                                                                                                            | Vendor choice + keys                                                                            |
| Cloudinary credentials   | Local signature generation; mock media adapter; no Admin-API asset verification                                                                                                     | Credentials (never committed)                                                                   |
| Hosting (OQ-34)          | Dockerfile, CI                                                                                                                                                                      | Provider/region/budget                                                                          |
| Export storage           | Sync exports work; async exports fail closed (`STORAGE_UNAVAILABLE`)                                                                                                                | Private object storage decision                                                                 |

No external account was created and no real credential was used.

## RD-07 — Gates (unchanged; owner execution/authorization)

G2 USER EXECUTION PENDING (Step 0 PASS, Step 1 NOT VERIFIED) · G3 NOT ACCEPTED (procedure v1.2.1 ready) · F5 NOT STARTED · G7/G8 NOT AUTHORIZED. (Updated 2026-11-20.)

## RD-08 — Abandoned carts (decided: option B; ACCEPTED — OFFLINE MOCKED SCOPE ONLY)

**Decision 2026-11-20: option B approved. Implemented in Batch 8 (2026-11-20, mocked tests only).**
`cart.abandon_after_days` = 30 (seed definition only, seed not run), reactivation of the newest
abandoned cart in the cart service, `abandoned-carts` job (abandon + 90-day purge). No schema,
migration or constraint change. Report: `docs/PHASE4-BATCH8-COMPLETION-REPORT.md`.

**Status update 2026-11-20 (owner acceptance):** RD-08 option B (Batch 8) — **ACCEPTED — OFFLINE
MOCKED SCOPE ONLY**. M1 correction (transactional lost-race recovery,
`docs/PHASE4-BATCH8-M1-CORRECTION-REPORT.md`) — **ACCEPTED — OFFLINE MOCKED SCOPE ONLY**. MySQL /
Prisma verification (generated SQL, REPEATABLE READ snapshots, row locking, uniqueness errors under
concurrency, lock interactions, cascade deletion, retry frequency) remains **pending Batch 12, after
the required G7/G8 authorization**. Not production-ready. The history below (conflict and
recommendation) is kept as originally written.

**Conflict found (2026-11-20):**

| Source                                             | Rule                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| BACKEND_STRUCTURE §14 `abandoned-carts` (PROPOSED) | hourly; `ACTIVE` carts idle > **24 h** → `ABANDONED`; empty carts **deleted**              |
| USER_WORKFLOWS §9.3 (PROPOSED)                     | inactivity → `ABANDONED` after **30 days**, setting `cart.abandon_after_days` (not seeded) |
| DATABASE_DESIGN retention table                    | abandoned carts purged **90 days** after `ABANDONED` (weekly)                              |

**Customer impact not covered by any document:** the cart module only loads the customer's `ACTIVE` cart
and creates a new empty one otherwise. A customer returning after the threshold would find their
bag empty. Nothing defines reactivation or a merge.

**Recommendation:** 30 days (`cart.abandon_after_days`, seeded with default 30). When an abandoned
cart exists and no active one does, reactivate it on the customer's next cart read instead of creating
a new cart. Purge 90 days after `ABANDONED`. No reminders (OQ-62 out of v1).

**Answer needed from you:** `RD-08 = recommended` / `24 h + delete empty as §14` / `defer`.

## RD-09 — Low-stock alert mode (OQ-47)

**Decision 2026-11-20: instant only.** Already the implemented behaviour; no code change. The
`low-stock-digest` job will not be built.

Implemented (2026-11-20, provisional): **instant** alert per low-stock episode. NOTIFICATION_WORKFLOWS
§4.16 offers instant **or** a daily 09:00 IST digest; BACKEND_STRUCTURE §14 describes both. Running both
would e-mail staff twice for the same SKUs, so the digest is **not** implemented.

**Answer needed from you:** `RD-09 = instant only` (current) / `digest only` / `both`. With "digest", the
job would run hourly and send once per IST date after 09:00 (dedupe key `LOW_STOCK_ALERT:<date>:<userId>`),
which matches the wall-clock time without cron.

## RD-10 — Payment reconciliation scope

**Decision 2026-11-20: option B approved; implemented in Batch 7** (mocked tests only). CANCELLED
payments updated within the last 24 h are re-checked; only a gateway capture is applied (late-capture
path). `updated_at` stands in for the cancellation time because there is no `cancelled_at` column.

Implemented (2026-11-20): `payment-reconciliation` checks payments still **PENDING** more than 20 minutes
after creation (§14). However, `reservation-expiry` moves PENDING payments to **CANCELLED** at 15 minutes.
A capture that reaches the gateway after that is only discovered if the gateway's webhook arrives (OQ-59
path). If that webhook is lost, the customer is charged and the order stays cancelled until a person notices.

**Recommendation:** also re-check payments CANCELLED by the system within the last **24 hours** (one
gateway call per payment, bounded). A capture found there goes through the existing OQ-59 path (confirm if
stock is still free, else cancel + full auto-refund).

**Answer needed from you:** `RD-10 = add 24 h CANCELLED lookback` / `PENDING only (as §14)`.

## RD-11 — Token retention periods (PROPOSED, not approved; corrected 2026-11-20)

**Correction (independent audit, 2026-11-20):** the earlier text said the 7 days was an implementation
proposal because §14 only says "used/expired". That was wrong. DATABASE_DESIGN.md §20 (retention table)
proposes **verification tokens: 7 days after expiry/consumption** and **refresh tokens: 30 days after
expiry/revocation**. The whole §20 table is **[PROPOSED] pending OQ-38** (DPDP Act, legal review), so
**neither value is approved**, the 30 days included.

Code vs §20 (unchanged in Batch 7, which excludes RD-11 and D6):

| Data                | Code (`tokenCleanup.ts`)                             | DATABASE_DESIGN §20 (PROPOSED)     |
| ------------------- | ---------------------------------------------------- | ---------------------------------- |
| Verification tokens | 7 days after expiry, consumption **or invalidation** | 7 days after expiry/consumption    |
| Refresh tokens      | 30 days after expiry **or revocation**               | 30 days after expiry/revocation    |
| Idempotency keys    | at `expires_at`, **daily**                           | 24 h + **1 day grace**, **hourly** |

D6 (security): deleting a revoked refresh token 30 days after revocation while it is still unexpired
disables reuse detection for it. This only happens if `REFRESH_TTL_STOREFRONT_DAYS` is set above 30
(allowed up to 365).

**Answer needed from you:** `RD-11 = approve §20 values` (plus align idempotency keys and keep revoked
refresh tokens until 30 days after expiry, fixing D6) / other periods / wait for OQ-38 legal review.

## RD-12 — Scheduler beyond one server (DECIDED 2026-11-20: single dedicated worker — implementation NOT authorized by the decision; later implemented in Batch 9, pending acceptance)

**Decision 2026-11-20 (owner, explicit approval; recorded as D-61 in PROJECT_CONTEXT §17.7):**

1. Background jobs and scheduled tasks run in a **single dedicated worker process**.
2. The API server and the worker are **separate runtime processes** with separated responsibilities.
3. **Multi-server / distributed scheduling is DEFERRED**; not implemented now.
4. **No Redis, BullMQ or other queue infrastructure** unless separately approved and justified by a
   future architecture decision (D-38 / OQ-35 unchanged).
5. **Architecture APPROVED; implementation NOT AUTHORIZED.** The worker does **not** exist yet. The
   in-process scheduler still runs inside the API process. Moving the jobs into the dedicated worker is
   future work (Batch 9, **not authorized**).

**Status update 2026-11-20 (Batch 9):** implemented — **COMPLETE, PENDING USER ACCEPTANCE** (offline /
mocked validation only): `src/worker.ts` runs all jobs when `JOBS_ENABLED=true`; the API never runs
them; one worker by deployment discipline (stop the old worker before starting a new one); no lock,
no Redis/BullMQ. Report: `docs/PHASE4-BATCH9-COMPLETION-REPORT.md`.

**Status summary (2026-11-20, documentation clarification F22; the decision text above is unchanged):**

- **D-61 architecture decision:** APPROVED.
- **Implementation:** the decision itself did **not** authorize implementation (item 5 above, as written
  on the decision date). Batch 9 implementation was then **authorized separately** by the owner
  (2026-11-20: WP1–WP7 + WP-O2, decisions B1–B7).
- **Dedicated worker:** implemented under Batch 9.
- **Batch 9 acceptance:** still **PENDING**.
- **Multi-server / distributed scheduling:** DEFERRED.
- **Redis / BullMQ:** not implemented and not authorized.

The analysis below is kept as originally written (decision history).

The in-process scheduler (`JOBS_ENABLED`, default `false`) has **no distributed lock**. §14 requires a
lock per job (`lock:job:<name>`). Every job is written to be idempotent (compare-and-set, dedupe keys,
row locks), so a duplicate run should not corrupt data. But duplicate runs double gateway and courier
calls and notification attempts, and this has only been tested with a mocked DB. **Multi-server safety is
not claimed.**

Before more than one API process may run jobs, one of these is required:

| Option                                                                     | Needs                 | Notes                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| BullMQ repeatable jobs + Redis lock (the documented design)                | Redis (OQ-35 / D-38)  | Also unlocks the `report-exports` queue                                                                                            |
| MySQL `GET_LOCK('job:<name>', 0)` per run                                  | nothing new           | Lock is per connection; Prisma's pool needs a dedicated connection or `$transaction` scope — needs a design note and MySQL testing |
| Dedicated single "worker" process; API processes keep `JOBS_ENABLED=false` | deployment discipline | Simplest; a crash stops all jobs until restart                                                                                     |

**Answer given 2026-11-20:** option 3, dedicated single worker process (see decision above). Until the worker is implemented: one process only.

## RD-13 — OpenAPI response contract (OQ-49)

**Decision 2026-11-20: option B approved; implemented in Batch 7.** A `respondsWith(...)` route marker
declares success statuses; the generator documents them, and in tests `ok()` fails on any mismatch.
36 operations documented as non-200 (the audit estimated about 37; the actual count is 36, including
the notifications resend route, which the audit missed). Typed `data` schemas (option A) remain open.

Done (2026-11-20, batch 6): every operation now lists the error responses its guards can produce, each
with its canonical codes in `x-error-codes` (validation 422/400, auth 401, permission / re-auth 403,
idempotency 409, rate limit 429, path resource 404, webhook signature 401). `ErrorEnvelope.error.code`
is constrained to the canonical code list. Generator tests: `tests/unit/scripts/openapi.test.ts`.

Still not modelled:

1. **Typed `data` schemas.** `SuccessEnvelope.data` is untyped for all 248 operations; shapes live in
   API_DOCUMENTATION.md. Modelling them means writing a Zod response schema per operation (and
   ideally validating responses against them in tests).
2. **Success status codes.** The document says `200` everywhere, but about 36 operations return `201`
   (28 + 3 `created()`) or `202` (5). Fixing this needs a per-route status marker, best done together
   with item 1.

**Answer needed from you:** `RD-13 = model typed responses + statuses` (recommended before the
storefront/admin repos consume the contract; large) / `statuses only` / `defer until OQ-49 is decided`.
