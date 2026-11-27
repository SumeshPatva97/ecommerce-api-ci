# Phase 4 — Consolidated User Decision Package

| Field    | Value                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document | P4-DECISIONS-01                                                                                                                                    |
| Date     | 2026-11-20                                                                                                                                         |
| Purpose  | Every open decision blocking Phase 4, with options, consequences and a recommendation. **Nothing here is decided or implemented until you answer** |
| Sources  | `PHASE4-MASTER-COMPLETION-ROADMAP.md` §4-G, `PHASE4-REMAINING-DECISIONS.md`, `PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`, current code                |

How to answer: reply with the decision ID and the option letter (e.g. "DEC-14: A"), or with amendments.

> **Status update (2026-11-21).** The owner's "Execution Authorization — G4 Closure" decided the
> following, recorded as D-62 … D-66 in `PROJECT_CONTEXT.md` §17.8:
>
> - DEC-14 → A;
> - DEC-06 → A (rule adopted; implementation discrepancy recorded);
> - DEC-05 → B, documentation / manual procedure only (no re-submission mechanism);
> - DEC-04 → approved including the scheduler fix;
> - DEC-13 → implementation of the explicitly small items only.
>
> **Correction to DEC-13 below:** the text says "six small items", but only **four** rows are
> explicitly marked "Implement (small)": FR-AD-008, FR-ORD-006, FR-INV-006 and FR-SF-004. Only those
> four were implemented. Still open: ACC-02, DEC-08, DEC-10, DEC-12, and the individual deferral
> approvals. See `PHASE4-REMAINING-USER-DECISIONS.md`.

> **Status update (2026-11-27) — the block above is historical.** It records the position on 2026-11-21 and must not be read as the current decision status. In particular, "Still open: … DEC-12" no longer holds: **DEC-12 was decided by the owner on 2026-11-27.** Real MySQL verification of all six concurrency scenarios is mandatory for G4. The six scenarios remain PREPARED — NOT EXECUTED. G7 PASS is a prerequisite before execution; G7 PASS alone does not authorize execution; a separate explicit written owner authorization is also required. GST-15 is excluded from DEC-12 and requires a separate owner decision. For the current status of every decision named in this document, use `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`.

## Summary

| ID     | Decision                              | Recommendation (short)                                                                                   | Blocks                             |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| ACC-02 | Accept Batch 9 (offline mocked scope) | Accept, with the nine risks acknowledged                                                                 | Batch acceptance register          |
| DEC-04 | Batch 10 scope                        | Approve WP10-1 … WP10-6 + optional scheduler fix                                                         | Batch 10                           |
| DEC-05 | M-1 refund recovery (five code paths) | B now (documented manual procedure), C later with the payment vendor                                     | IMP-08, runbook, SEC               |
| DEC-06 | Promotion EXPIRED rule                | A: EXPIRED is final                                                                                      | IMP-07                             |
| DEC-08 | Hosting for dev / staging             | Decide before staging; recommendation depends on budget (A or B)                                         | SEC-04 staging releases            |
| DEC-10 | `.env.example` Batch 3 edit           | B: keep the variable block, comment refresh under a one-time authorization                               | DOC-10                             |
| DEC-12 | Real-database verification for G4     | A: required, via the procedure in §DEC-12, after G7                                                      | G4 criterion 2 (6 cases), Batch 12 |
| DEC-13 | Formal deferral list                  | Defer the blocked items and the [PROPOSED] portions; implement or defer the 11 other partials explicitly | G4 criteria 1 and 2                |
| DEC-14 | Defect convention for G4              | A: G4 "P0 / P1" = TESTING_STRATEGY §19 "S1 / S2"                                                         | G4 criterion 3                     |

_(Clarification 2026-11-27, row DEC-12 — the row is the 2026-11-20 recommendation and is kept as written. DEC-12 is no longer an open decision: the owner decided it on 2026-11-27, and real MySQL verification of all six concurrency scenarios is mandatory for G4. The row's "Blocks" entry names Batch 12. The decision does not address Batch 12, which stays open.)_

---

## ACC-02 — Batch 9 acceptance

**Proposed status:** ACCEPTED — OFFLINE MOCKED SCOPE ONLY.

**Risks to acknowledge:**

1. Exactly one worker; no lock or runtime enforcement.
2. A second worker would run every job twice.
3. M-1 in five code paths (pre-existing): an interrupted refund stays `PROCESSING` with no automatic
   recovery. `complete` is allowed only after provider confirmation (procedural, not enforced).
   Recovery is undefined when no refund was issued.
4. Premature "refund initiated" notifications (staff approval, customer self-cancel).
5. Notifications stuck in `SENDING` after a forced kill.
6. The 60 s forced exit can cut off running work.
7. M-2 stop-signal wiring has no test (Batch 10 WP10-1 adds one).
8. Mocked evidence only; not multi-server safe, not production-ready.
9. Low worker / bootstrap exit-path coverage.

Evidence: `PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md`.

## DEC-04 — Batch 10 scope

Full review: `PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md`. No database impact; no route or
behaviour change except WP10-2 / WP10-5.

| WP     | Scope                                                                                              | Files / modules                                                   | Type         | Complexity | Separable | Risk                                    |
| ------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------ | ---------- | --------- | --------------------------------------- |
| WP10-1 | Registry wiring tests: cursor carry-over, stop signal (M-2)                                        | new `tests/unit/jobs/registryWiring.test.ts`                      | Tests only   | Low        | Yes       | None                                    |
| WP10-2 | Per-item error isolation in best-seller / rating jobs                                              | `src/jobs/catalogAggregates.ts` + tests                           | Small source | Low        | Yes       | Low (summary gains `errors`)            |
| WP10-3 | Reconciliation-level late-capture tests                                                            | `tests/unit/jobs/paymentReconciliation.test.ts`                   | Tests only   | Low        | Yes       | None                                    |
| WP10-4 | OpenAPI content types for 5 file downloads                                                         | `scripts/generate-openapi.ts`, `docs/openapi/openapi.json`, tests | Contract doc | Low–medium | Yes       | Low (documented contract only)          |
| WP10-5 | Configurable best-seller window                                                                    | `src/jobs/catalogAggregates.ts` + tests                           | Small source | Low        | Yes       | Low (default 90 kept)                   |
| WP10-6 | Batch 8 cart test gaps                                                                             | cart integration tests                                            | Tests only   | Low        | Yes       | None (a defect found → stop and report) |
| opt.   | Scheduler: log a synchronous `job.run()` throw; refresh stale comment / start log (L-1, L-4, R-16) | `src/jobs/scheduler.ts` + test                                    | Small source | Low        | Yes       | Low                                     |

**Recommendation:** approve all six. **Include the scheduler fix**, because today a synchronous throw
exits the worker with code 1 (an availability issue), and the change is tiny and testable.

Acceptance criteria per WP: proposal §3. Gates: proposal §5.

## DEC-05 — M-1 refund recovery

**Sequence (verified in code; five paths).** A transaction commits the refund as `PROCESSING`
(`prepareGatewayRefund`), then the gateway call runs after commit. The five paths:

- worker late capture;
- staff approval;
- customer self-cancel;
- API late capture (verify / webhook);
- admin retry of a `FAILED` gateway refund.

If the process stops in between, the refund stays `PROCESSING` with no provider refund id. _(Note 2026-11-24: after an admin retry, the provider refund id of an earlier failed attempt can still be stored; see the runbook §9.1 step 1.)_

**Outcomes:**

| Provider says        | Current handling                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Refund completed     | `complete` may record it (records only; no gateway call)                                                              |
| Refund pending       | Wait; the refund webhook can only match a refund with a provider id, so a refund whose call never ran gets no webhook |
| **No refund issued** | **Undefined.** `retry` rejects `PROCESSING`; `complete` must not be used                                              |

**Risks of manual recovery:**

- double refund (re-issuing at the gateway when the first call actually succeeded);
- a false `COMPLETED` record;
- the customer was already told "refund initiated".

**Options:**

| Option      | Description                                                                                                                                                                                                                                                                                                                                                                                                                               | Pros                                                                                    | Cons                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A           | Status quo: documented limitation only                                                                                                                                                                                                                                                                                                                                                                                                    | No change                                                                               | Customer money can be stuck; no procedure                                            |
| **B (now)** | Written manual procedure plus an admin filter for stale `PROCESSING` refunds (no provider id, `processingAt` older than N minutes). Finance checks the provider dashboard using the refund id (sent as the gateway idempotency key / reference). If completed → `complete`. If not issued → a **new guarded action** "re-submit gateway refund" (only for stale `PROCESSING` with no provider id; same idempotency key; audited; re-auth) | Closes the "no refund issued" gap safely; the idempotency key limits double-refund risk | Needs a small code change (separate authorization) and a business-approved procedure |
| C (later)   | Automatic sweep: a job queries the provider's refund status by reference before re-submitting                                                                                                                                                                                                                                                                                                                                             | Fully automatic                                                                         | Needs a chosen payment vendor's refund-lookup API (OQ-06)                            |

**Recommendation:** B now, C when the payment vendor is chosen. Also decide the notification
question:

- move `REFUND_INITIATED` to after a successful gateway call (needs code), or
- accept the premature notification.

Nothing will be implemented until you choose.

## DEC-06 — Promotion EXPIRED rule

**Current behaviour.** Status is derived from dates: `now ≥ ends_at` → `EXPIRED`
(`promotions.rules.ts` line 73). The activation job moves `SCHEDULED / ACTIVE → EXPIRED`. Editing
`ends_at` into the future could therefore make an expired promotion active again.

> **Clarification (2026-11-24, code re-read).** The last sentence holds only while the **stored** status is still `SCHEDULED` / `ACTIVE` after `ends_at`. Once `EXPIRED` is stored (activation job, resume, or a `PATCH` that keeps the past dates), a date edit is accepted but the status stays `EXPIRED`. D-63 adopted option A as the rule; the service guard is not authorized (DEC-06-impl).

**Options:**

- **A — EXPIRED is final:** reject edits that would revive it; duplicate the promotion instead.
- **B — revivable:** editing dates re-derives the status.

**Recommendation: A.** Expired promotions may already be referenced by orders and audit history;
reviving them blurs reporting and coupon / promotion analytics. Implementation would join Batch 10 or
a later batch.

## DEC-08 — Hosting (dev / staging)

Source: `DEPLOYMENT_ARCHITECTURE.md` §3 (indicative prices only; verify current pricing).

| Option                                                                             | Fit for current architecture (API + exactly one worker, MySQL 8, no Redis yet) | Indicative monthly (prod scale) | Ops effort  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------- | ----------- |
| A — AWS Mumbai (ECS Fargate api + 1 worker task, RDS MySQL 8, S3, Secrets Manager) | Strong; documented recommendation                                              | ~USD 250–500                    | Medium–high |
| B — DigitalOcean Bangalore (App Platform service + worker, Managed MySQL, Spaces)  | Good for launch scale; single Indian region                                    | ~USD 120–250                    | Low–medium  |
| C — VPS for API with self-managed MySQL                                            | Not recommended for the system-of-record database                              | ~USD 60–150                     | High risk   |

**Notes:**

- Redis is not needed today (D-61 / D-38). The single-worker rule must be enforced by deployment
  configuration (worker desired count = 1).
- Staging can be smaller than production.

**Your decision:**

- provider;
- budget for dev / staging;
- who creates the accounts. I will not create accounts, purchase or deploy.

**Recommendation:**

- **B** if budget dominates;
- **A** if compliance and DR (second Indian region) dominate.

Alternatively, formally defer staging releases from G4 (they are a Phase 4 deliverable, not a G4
exit criterion).

## DEC-10 — `.env.example` Batch 3 edit

**History.** In Batch 3 an agent added a `JOBS_ENABLED=false` block to `.env.example`. That was a
restriction breach (the file matches the forbidden `.env.*` pattern); it was disclosed and left in
place. The roadmap also notes the comment is now outdated: it mentions 4 jobs and "in-process", while
there are 10 jobs, run by the D-61 worker. **I have not opened the file** and will not without your
explicit authorization.

**Options:**

- **A — revert** the block. This removes the documented default for a real config variable.
- **B — keep the block and refresh its comment.** Needs a one-time authorization to open and edit
  only `.env.example`.
- **C — leave as is** and record the outdated comment as a known documentation issue.

**Recommendation: B.** `JOBS_ENABLED` is a genuine, non-secret variable; documenting it is correct.
Only the wording is stale.

## DEC-12 — Real-database verification

**Clarification 2026-11-27 — this section is historical.** It is the proposal of 2026-11-20 and is kept as written. It is not the current decision record and it is not the current procedure.

- **Decision.** DEC-12 was decided by the owner on 2026-11-27: real MySQL verification of all six concurrency scenarios listed below is mandatory for G4. The "Options" and "Recommendation" at the end of this section are the proposal that preceded that decision. Current record: `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`, D10.
- **State.** The six scenarios remain PREPARED — NOT EXECUTED. TC-041 is the real-database evidence scenario for FR-CPN-008 / AC-03 and has not been executed.
- **Execution.** G7 PASS is a prerequisite. G7 PASS alone does not authorize execution. A separate explicit written authorization from the owner is also required, and DEC-12 does not give it. DEC-12 does not authorize G8, seeds, staging or any unrelated operation. G2 and G3 statuses are unchanged.
- **Procedure.** The "Proposed procedure" below is an older description. It differs from the current procedure, in particular on how credentials are supplied and how test data is cleaned up, and it must not be followed. The current authorized procedure must be taken from `PHASE4-OWNER-EXECUTION-RUNBOOK.md` §5 and `tests/db/README.md`.
- **Outside DEC-12.** GST-15 is excluded and requires a separate owner decision. The Batch 12 suite mentioned below is not addressed by the decision and stays open. Coupon hardening remains NOT AUTHORIZED pending review of the TC-041 evidence and a separate owner decision.

**Cases mocks cannot prove (QA-03):**

| TC     | Case                                                                  |
| ------ | --------------------------------------------------------------------- |
| TC-004 | Refresh-token replay within the grace window                          |
| TC-030 | Last-unit oversell (CC-01)                                            |
| TC-041 | Coupon last-redemption race (CC-03)                                   |
| TC-045 | Gap-free invoice / credit-note numbers under concurrency (CC-05 / 06) |
| TC-048 | Idempotency-Key concurrent replay (CC-08)                             |
| TC-051 | Webhook vs client-verify race (CC-09)                                 |

Batch 12 (roadmap §10) adds job / transaction behaviour on MySQL.

**Proposed procedure (not executed; needs your approval).**

**Prerequisites:**

- G2 PASS (backup / restore drill);
- G3 PASS (migration identity);
- F5 READY;
- G7 PASS (baseline applied to a scratch database).

**Environment:**

- the local MySQL 8.4 server (already installed, `MySQL84`);
- a dedicated, isolated database **`ecommerce_test`** (empty), created by you;
- a test-only app user with DML on `ecommerce_test` only. Grants follow G3; credentials are entered
  by you in a git-ignored file. **I never see them.**

**Schema:** the reviewed baseline migration is applied to `ecommerce_test` with the migration
identity (same command family as G7, target name hard-checked).

**Safety controls (built into the test harness before any run):**

- refuse to start unless the database name is exactly `ecommerce_test`;
- refuse any URL containing `ecommerce_dev`;
- no `DROP DATABASE`; data cleanup only by truncating tables inside `ecommerce_test`.

**Destructiveness:** destructive **only within `ecommerce_test`** (truncate / insert between tests).
`ecommerce_dev` is never touched.

**Execution:** you run one command per step; I review the output before the next step.

**Evidence:**

- per-case pass / fail with counts (e.g. exactly one successful last-unit purchase out of N
  concurrent);
- the invoice number sequence check;
- a test log with no secrets.

**Rollback:** drop the scratch / test database (your action) — no effect on `ecommerce_dev`.

**Risks:**

- a misconfigured connection string pointing at `ecommerce_dev`, mitigated by the hard name guard;
- local load;
- Windows-specific MySQL timing (results are indicative of InnoDB behaviour, not of production
  hosting).

**Options:**

- **A — required for G4:** run after G7.
- **B — formally defer** real-database verification to a later phase. G4 would then state "mocked
  evidence only".

**Recommendation: A.** Oversell, coupon races and gap-free invoice numbers are financial / legal
correctness properties. Mocked evidence cannot establish them.

## DEC-13 — Formal deferrals

**Group 1 — blocked items (recommend: defer).**

| Item                               | Requirement / source                           | Reason                                            | Impact if deferred                                  | Future phase                       | Affects G4              |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- | ---------------------------------- | ----------------------- |
| Email / WhatsApp delivery webhooks | PROJECT_CONTEXT §8.1 routes; FR-NTF-005 (part) | Vendor unknown (OQ-08); signature schemes unknown | No delivery / bounce status in logs                 | Phase 7 (provider)                 | Criterion 1 (endpoints) |
| Async report exports (> 10k rows)  | FR-RPT-011; TC-065                             | Needs a queue + private storage; outside D-61     | Large exports unavailable; sync ≤ 10k works         | After the Redis / storage decision | Criterion 2             |
| MFA recovery codes                 | RD-03 SCP-1                                    | Needs a schema change (not approved)              | Staff who lose their MFA device need a manual reset | After the schema decision          | Criterion 2             |
| CAPTCHA                            | FR-AUTH-007 (part)                             | Vendor (OQ-71 / D-48)                             | Bot protection relies on rate limits only           | Phase 7                            | Criterion 2             |
| Breached-password API              | FR-AUTH-010 (part)                             | External service; offline list exists             | Weaker password screening                           | Phase 7                            | Criterion 2             |

**Group 2 — [PROPOSED] portions of Must requirements (verified in requirement text; recommend: defer
or re-word).**

| Requirement | [PROPOSED] portion                                           | Current code                                                     |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| FR-PL-015   | "out-of-stock … sorted after in-stock ones"                  | No availability sort                                             |
| FR-INV-004  | "bulk (CSV upload) [PROPOSED bulk]"                          | JSON bulk only                                                   |
| FR-PV-012   | "Max 15 images/product, 10 MB each, JPG/PNG/WebP [PROPOSED]" | 30 images (API doc "proposed"); size / format not server-checked |

**Group 3 — mandatory requirements found PARTIAL (QA-02; decide: implement in a batch, or defer).**

| Requirement                          | Gap                                                       | Recommendation                                                  |
| ------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| FR-PRM-004                           | No promotional price on listing / detail                  | **Implement** (customer-visible price correctness)              |
| FR-TAX-013                           | No HSN summary on the invoice PDF                         | **Implement or confirm with the tax professional** (with RD-01) |
| FR-AD-008                            | Two settings not read (reservation TTL, new-arrival days) | Implement (small)                                               |
| FR-ORD-006                           | No SKU in order search                                    | Implement (small)                                               |
| FR-INV-006                           | No actor filter on stock history                          | Implement (small)                                               |
| FR-SF-004                            | Empty collections not hidden                              | Implement (small)                                               |
| FR-PL-013                            | Search misses brand / category / attributes               | Implement (medium) or defer                                     |
| FR-NTF-005                           | Direct auth e-mails not logged                            | Decide (logging policy)                                         |
| FR-RPT-011, FR-AUTH-007, FR-AUTH-010 | See Group 1                                               | Defer                                                           |

**Recommendation:** approve Groups 1 and 2 as formal deferrals. For Group 3, authorize a small
"G4 gap" implementation batch for the six small items (plus FR-PRM-004, FR-TAX-013 after the tax
confirmation). Nothing is marked deferred until you approve.

> **Addendum (2026-11-24, DEC-13 re-verified; evidence: `PHASE4-MASTER-AGENT6-DEC13-TRACEABILITY-REPORT.md`).**
>
> - "Six small items" above is wrong: exactly **four** rows are marked "Implement (small)", and only
>   those four were implemented on 2026-11-21 (D-66).
> - **FR-ORD-006, FR-INV-006, FR-SF-004:** implemented and tested (mocked).
> - **FR-AD-008 is still PARTIAL.** Both settings are read on their main paths. Two paths still
>   ignore them: payment retry uses the environment TTL, and the recently-viewed list uses the
>   30-day default for the new-arrival badge. Closing them is a small change that is **not
>   authorized** (it was not part of the four items as described).
> - **FR-PRM-004 belongs in Group 2 as well.** Its source is `[PROPOSED]`, and its "never below ₹1"
>   floor is marked `[PROPOSED]`. The pricing engine floor is ₹0.01. The Group 3 recommendation
>   "Implement" stands as a recommendation only; the floor needs its own decision because it changes
>   cart and checkout totals.
> - **FR-TAX-013:** RD-01 contains only the odd-paisa question. No HSN-summary question has been
>   written for the tax professional yet, and the requirement does not say whether "HSN summary"
>   means a block on each invoice or the periodic `gst-hsn` report (which exists).
> - **FR-PRM-004, FR-PL-013, FR-TAX-013 are not implemented.** Recommendations and proposed
>   acceptance criteria are in the Agent 6 report, Part B. No deferral record exists for them yet.

## DEC-14 — Defect convention for G4

**Facts (`TESTING_STRATEGY.md` §19):**

- severity S1 Critical, S2 Major, S3 Minor, S4 Trivial (set by QA);
- priority P1–P4 (set by the product owner);
- release criterion: **"0 open S1/S2, S3 count agreed"**.

G4 says "no open P0/P1 defects"; there is no P0 in §19.

**Options:**

- **A:** G4 "P0 / P1" = S1 / S2. Defects at S3 / S4 are allowed open at G4 with an agreed list.
- **B:** G4 "P0 / P1" = priority P1 (and an undefined P0). This mixes business priority with
  severity and leaves P0 undefined.

**Recommendation: A.** It equals the existing release rule exactly, so it does not weaken it. The
audit scale maps as Critical → S1, High → S2 (Medium → S3, Low → S4); confirm or adjust.

**Current audit findings under A:**

- no Critical or High findings are open (Batch 9 audit);
- M-1 / M-2 are Medium (S3) → allowed open with an agreed list.

**Caveat:** you may decide M-1 is S2 (refund money stuck). That would make it a G4 blocker until
DEC-05 option B is implemented.

## User-only gates — your next step

**G2 is at Step 1** (Step 0 PASS, 2026-11-19).

**Step 1 (PowerShell, on your machine).** This step is **non-destructive**: it only creates the
folders `C:\db-backups\ecommerce` and an evidence subfolder, defines variables and safety guards, and
does not contact MySQL.

1. Open Windows PowerShell 5.1.
2. Run the Step 1 block exactly as written in `docs/G2-USER-EXECUTION-GUIDE.md` lines 52–88. Change
   `$adminUser` only if your admin account is not `root`.
3. **Expected output:** two lines:
   - `dump file : C:\db-backups\ecommerce\ecommerce_dev_<timestamp>_G2.sql`
   - `evidence dir : …\G2_evidence_<timestamp>`

   There is no password prompt.

4. Send me those two lines (they contain no secrets). **Stop** if you see any `G2 STOP:` line.

Do not run Step 2 yet. I will verify Step 1 and then give you Step 2 (read-only counts; it prompts
for the MySQL password in your terminal, never in chat).

**After G2:** G3 needs your approval to execute (procedure v1.2.1), then F5 review, then G7 / G8
(both need explicit authorization).
