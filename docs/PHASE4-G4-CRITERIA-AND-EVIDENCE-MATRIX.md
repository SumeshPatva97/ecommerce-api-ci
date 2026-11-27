# Phase 4 — G4 Criteria and Evidence Matrix

| Field    | Value                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date     | 2026-11-24                                                                                                                                                                                                                                                                                                 |
| Criteria | `project-documentation/10-project-management/IMPLEMENTATION_ROADMAP.md`, Phase 4 "Exit criteria / Gate G4". _(Canonical location, verified 2026-11-24. From 2026-11-21 until 2026-11-24 the file sat in `02-architecture/`; it was moved back on the owner's authorization and its content is unchanged.)_ |
| Evidence | Local, mocked / offline, Node 24.12.0. **Not** real-database, CI, staging or production evidence                                                                                                                                                                                                           |
| Verdict  | **G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED**                                                                                                                                                                                                                                                   |

Decision references (D1 … D17) point to `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`. Runbook
references point to `PHASE4-OWNER-EXECUTION-RUNBOOK.md`.

## 1. Summary

| #   | Criterion                                                           | Position on 2026-11-24                                                                                                      | Closed by                                                                                             |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | All endpoints in API_DOCUMENTATION implemented or formally deferred | **No known gap at method-and-path level** since 2026-11-24 (D6 and D7 approved). Not independently verified. _Was: Not met_ | Independent verification; D14 for the barcode content type (shape, not presence)                      |
| 2   | All FR "Must" API-side acceptance criteria pass in automated tests  | **Not met**                                                                                                                 | D2 – D5, D10, D14 and the seven other proposed deferrals; runbook steps 1–5 _(D6 decided 2026-11-24)_ |
| 3   | No open P0 / P1 defects                                             | **Not confirmed**                                                                                                           | D8, D10 (D1 done 2026-11-24)                                                                          |
| 4   | Security checklist self-assessment complete                         | **Draft, not accepted**                                                                                                     | D11                                                                                                   |
| 5   | Client written approval                                             | **Not started**                                                                                                             | Runbook step 9                                                                                        |

_(Pointer 2026-11-27: this summary is the position on 2026-11-24 and is kept as written. It is historical. For the later position read §12 and §13 of this document. §12 (2026-11-24, later): criterion 1 was checked a second time, so "Not independently verified" in row 1 is superseded; 32 contract rows are open and criterion 1 is still not marked met. §13 (2026-11-27): DEC-12 is decided, so "D10" in rows 2 and 3 no longer names a pending DEC-12 decision. The six real-MySQL scenarios are mandatory G4 evidence and remain PREPARED — NOT EXECUTED; under D10 only the coupon-hardening question remains, and it is NOT AUTHORIZED. This pointer changes no criterion status.)_

## 2. Criterion 1 — endpoints implemented or formally deferred

**Evidence that exists.**

- The generated specification has 248 operations and `npm run openapi:check` passes (run
  2026-11-24).
- Re-check on 2026-11-24: every `METHOD /path` written in `API_DOCUMENTATION.md` (202 distinct
  mentions) was compared with the 248 operations. 178 match **by method and path** — a route with that method and path is registered; request and response shapes were not compared. 20 are notation in the document
  (wildcards, shorthand such as `/admin/products[/:id]`, generic CRUD fragments, an example report
  key). **Four are documented operations with no implementation.**

| Documented operation                              | State           | Proposal                                                                                                                         |
| ------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST /webhooks/email`                            | Not implemented | **Formally deferred** to Phase 7 — DEF-A1 approved 2026-11-24 (D6). _Was: not approved_                                          |
| `POST /webhooks/whatsapp`                         | Not implemented | **Formally deferred** to Phase 7 — DEF-A1 approved 2026-11-24 (D6). _Was: not approved_                                          |
| `GET /webhooks/whatsapp` (verification handshake) | Not implemented | **Formally deferred** to Phase 7 — included in DEF-A1 as approved 2026-11-24 (D6). _Was: not approved_                           |
| `GET /api/v1/openapi.json`                        | Not implemented | **Formally deferred** — approved 2026-11-24 (D7); to be decided before the first frontend integration that needs it. _Was: open_ |

**Limit of this check.** It compares method and path text only. It does not prove that request and
response shapes match the document. One known shape mismatch: the variant barcode image is
documented as JSON in the specification (DC-05).

**Evidence still required.** Your approval or rejection of DEF-A1 (extended), and a decision on the
OpenAPI-serving sentence.

_Update 2026-11-24: both were given. D6 approved DEF-A1 with the extended scope and a condition; D7 approved the deferral of HTTP serving. Records: `PHASE4-REMAINING-USER-DECISIONS.md` §3.1. Evidence still to come: an independent check of this criterion, and the D14 decision on the barcode content type._

**Blocker.** Owner decisions only. _(Update 2026-11-24: the two owner decisions for this criterion are taken. No known blocker remains at method-and-path level.)_

## 3. Criterion 2 — FR "Must" API-side acceptance criteria pass in automated tests

**Evidence that exists.**

| Evidence                                              | Value                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Full suite (2026-11-24, after the D1 fix)             | 120 files, 3,124 passed, 3 todo, 0 failed (119 files, 3,110 passed before the fix)    |
| Coverage                                              | Statements 92.11 %, branches 82.69 %, functions 94.74 %, lines 93.86 %                |
| Gates                                                 | `format:check`, `lint`, `typecheck`, `build`, `openapi:check` pass                    |
| Traceability matrix (draft, 239 API-side "Must" rows) | 219 tested, 7 implemented with no test found, 11 partial, 2 blocked / deferred        |
| Test-case catalogue (draft)                           | Route × role matrix 1,113 cases; state machine; GST catalogue; notification rendering |

All of it is mocked. The traceability matrix is a draft produced by static reading and has not been
reviewed by you.

**The 11 partial requirements.**

| Requirement | Gap                                                             | Proposed handling                                    | Decision                                                     |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| FR-AD-008   | Payment retry and recently-viewed ignore two settings           | Implement (small)                                    | D2                                                           |
| FR-PRM-004  | No promoted price on listing / detail                           | Implement display; or defer to Phase 5               | D3                                                           |
| FR-PL-013   | Search misses brand, category, attributes                       | Implement plain extension; or defer                  | D4                                                           |
| FR-TAX-013  | No HSN summary on the invoice PDF                               | Tax professional first; defer until then             | D5                                                           |
| FR-NTF-005  | Delivery webhooks absent; direct auth e-mails not logged        | DEF-A1 (**approved** 2026-11-24, D6); DEC-13c (open) | D6, D14                                                      |
| FR-RPT-011  | Async exports never run                                         | Deferral DEF-A2                                      | Open — proposed deferral, **not** covered by the D6 approval |
| FR-AUTH-007 | CAPTCHA is a no-op                                              | Deferral DEF-A4                                      | Open — proposed deferral, **not** covered by the D6 approval |
| FR-AUTH-010 | Breached-password check is offline only                         | Deferral DEF-A5                                      | Open — proposed deferral, **not** covered by the D6 approval |
| FR-PL-015   | Out-of-stock not sorted last (`[PROPOSED]` portion)             | Deferral DEF-B1                                      | Open — proposed deferral, **not** covered by the D6 approval |
| FR-INV-004  | No CSV bulk upload (`[PROPOSED]` portion)                       | Deferral DEF-B2                                      | Open — proposed deferral, **not** covered by the D6 approval |
| FR-PV-012   | Image limits (`[PROPOSED]` portion); no server-side file checks | Deferral DEF-B3                                      | Open — proposed deferral, **not** covered by the D6 approval |

No deferral is approved _(update 2026-11-24: DEF-A1 is approved under D6, and HTTP serving of the specification is deferred under D7; the other seven proposed deferrals are not approved)_. The 2 blocked rows (FR-PAY-001 real gateway, FR-NTF-002 real e-mail /
WhatsApp vendors) are Phase 7 items. The 7 rows with no test are structural or design-level and are
listed in the matrix §1.4.

**Cases that mocked tests cannot prove.**

| Case                                 | State                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| TC-004 refresh-token replay          | Scenario prepared; not executed                                               |
| TC-030 last-unit oversell            | Scenario prepared; not executed                                               |
| TC-041 coupon last redemption        | Scenario prepared; not executed; **a failure is predicted from code reading** |
| TC-045 gap-free invoice numbers      | Scenario prepared; not executed                                               |
| TC-048 idempotency-key replay        | Scenario prepared; not executed                                               |
| TC-051 webhook against client verify | Scenario prepared; not executed                                               |
| GST-15 (database part)               | `todo` in the suite                                                           |

**Evidence still required.**

- Your decisions D2 – D5 and D14, and on the seven other proposed deferrals (D6 was decided on 2026-11-24 and covers DEF-A1 only); then either passing tests for what is implemented or an approved
  deferral record for what is not.
- Your review of the traceability matrix draft.
- DEC-12 (D10): real-database run after G7, or an explicit deferral of these cases. _(Update 2026-11-27: decided by the owner — real MySQL verification of the six scenarios is required for G4; they are not deferred. Execution is not authorized by the decision. See §13.)_

**Blockers.** Owner decisions; implementation authorizations; the database chain G2 → G3 → F5 → G7.

## 4. Criterion 3 — no open P0 / P1 defects

Convention D-62: G4 "P0 / P1" = `TESTING_STRATEGY.md` §19 "S1 / S2".

**Evidence that exists.** No S1 or S2 defect is confirmed by a test. Register:

| Item                                                    | State                                                           | Recommended severity                  | Effect on this criterion               |
| ------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- | -------------------------------------- |
| DF-01, DF-02, DF-03 (notifications)                     | Fixed, re-verified                                              | —                                     | None                                   |
| M-2 (registry wiring untested)                          | Closed by test                                                  | —                                     | None                                   |
| Mock payment provider not refused in production (PW-08) | **RESOLVED 2026-11-24**: fixed; 14 test cases; mutation-checked | S2 (owner classification, 2026-11-24) | None: fixed and tested (mocked) (D1)   |
| M-1 refund interrupted after commit                     | Open; manual procedure                                          | S3 with a go-live condition           | Blocks only if you classify it S2 (D8) |
| Coupon over-redemption under concurrency                | **Predicted, not tested**                                       | S2 if reproduced                      | Unknown until TC-041 runs (D10)        |
| Promotion revived by a date edit (D-63)                 | Open; guard not authorized                                      | S3                                    | None at S3 (D9)                        |
| Barcode content type in OpenAPI (DC-05)                 | Open                                                            | S4                                    | None                                   |

**Evidence still required.** Your severity classification of M-1 (PW-08 was classified S2 and fixed on
2026-11-24); the TC-041 result, or your explicit acceptance that it is untested; the
`npm audit` result (runbook step 7).

**Blocker.** Owner classification of M-1; the coupon case tested or accepted as untested.

_(Clarification 2026-11-27 — the two paragraphs above ("Evidence still required" and "Blocker") are the 2026-11-24 position and are kept as written. DEC-12 was decided by the owner on 2026-11-27. The route they describe, "your explicit acceptance that it is untested" / "accepted as untested", is no longer available for the six mandatory real-MySQL scenarios. TC-041 must be executed and its results reviewed, as DEC-12 requires. It is PREPARED — NOT EXECUTED. G7 PASS is a prerequisite for execution, not an authorization. A separate explicit written owner authorization is required before execution. Coupon hardening remains NOT AUTHORIZED pending review of the TC-041 evidence and a separate owner decision; this clarification neither authorizes nor requires it. The same applies to the words "or accept it as untested" in row 3 of the tables in §10 and §11. The owner's classification of M-1 (D8) is still needed.)_

## 5. Criterion 4 — security checklist self-assessment complete

**Evidence that exists.** `operations/SECURITY_SELF_ASSESSMENT-G4-DRAFT.md`: 142 controls in 16
areas.

| Result          | Controls                   |
| --------------- | -------------------------- |
| TESTED (mocked) | 71 before D1; **72** after |
| CODE-VERIFIED   | 15                         |
| DOCUMENTED      | 9                          |
| PREPARED        | 4                          |
| BLOCKED         | 14                         |
| USER-DEPENDENT  | 12                         |
| GAP             | 17 before D1; **16** after |

Backup / restore and CI have no tested control: nothing in those areas has been executed.

**What "complete" requires.** The criterion asks for the self-assessment to be complete. It does
not ask for every control to be met. The draft becomes the self-assessment when you accept it with
its gaps recorded.

**Evidence still required.** Your acceptance or return of the draft (D11). The 16 open gaps (17 before D1) with
severity, remediation and G4 effect are in the security plan §4.2.

_(Clarification 2026-11-27: "16 open gaps" is the count after D1 and is kept as written. The independent read-only audit of 2026-11-27 counted 14 control rows currently classified as GAP in the draft (142 controls: TESTED 74, CODE-VERIFIED 13, DOCUMENTED 9, PREPARED 6, BLOCKED 14, USER-DEPENDENT 12, GAP 14). The difference is two controls, SH-10 (`.dockerignore`) and CS-03 (CI coverage step), which the author of the 2026-11-24 update reassessed from GAP to PREPARED. That reassessment has not been reviewed or approved by the owner. D11 is still open and criterion 4 is not complete.)_

**Blocker.** Owner review.

## 6. Criterion 5 — client written approval

**Evidence that exists.** None.

**Evidence required.** A dated written approval that names Phase 4 / Gate G4, lists the accepted
deferrals and known limitations, and follows the closure of criteria 1–4 (runbook step 9).

**Blocker.** Criteria 1–4; then the client.

## 7. Phase 4 deliverables that are not exit criteria

| Deliverable      | State                                                                                                                                                                                                 | Needs                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CI on Node 22    | No run recorded. The workflow runs on a push or pull request to `main` / `develop` only                                                                                                               | Runbook step 6; DEC-18                                                                |
| Staging releases | None                                                                                                                                                                                                  | DEC-08; runbook step 8                                                                |
| Runbook drafts   | Partial: no procedure for notifications left in `SENDING`; refund recovery undefined when no refund was issued                                                                                        | D8, D14                                                                               |
| Batch acceptance | **Batch 9 and Batch 10 ACCEPTED — OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-24). Ten Batch 9 risks and six Batch 10 limitations acknowledged; they stay open. _Until then: pending user acceptance_ | Nothing further for acceptance. Record: `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §18 |
| Database gates   | G2 at Step 1; G3, G7, G8 not started                                                                                                                                                                  | Runbook steps 1–4                                                                     |

## 8. Smallest safe sequence to reach G4

"Smallest" means the fewest steps that close every criterion without leaving a known S2 candidate
unexamined. Steps 1–4 need only your replies. Nothing below is started.

| Step | Action                                                                                                                                                 | Who                 | Closes                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------- |
| 1    | **Done 2026-11-24.** PW-08 classified S2 (D1); fix, 14 test cases and a full gate run completed                                                        | You, then assistant | Criterion 3 (largest item)               |
| 2    | **Done 2026-11-24.** Batch 9 and Batch 10 accepted, offline mocked scope only                                                                          | You                 | Batch register                           |
| 3    | Decide D2 – D7 and D14: implement the small items you choose; approve the deferrals you choose. _(D6 and D7 decided 2026-11-24; D2 – D5 and D14 open)_ | You, then assistant | Criterion 1; most of criterion 2         |
| 4    | Classify M-1 (D8) and accept or return the security draft (D11)                                                                                        | You                 | Criterion 3 (rest); criterion 4          |
| 5    | Run `npm audit`; open a pull request so CI runs on Node 22                                                                                             | You                 | Supporting evidence for criteria 2 and 3 |
| 6    | Decide DEC-12 (D10). If required: G2 → G3 → F5 → G7, then the six scenarios, TC-041 early                                                              | You                 | Criterion 2 (real-database cases)        |
| 7    | Assistant refreshes this matrix and the master report with the results; you review the traceability matrix                                             | Assistant, you      | Evidence package                         |
| 8    | Client written approval                                                                                                                                | Client              | Criterion 5                              |

_(Clarification 2026-11-27, step 6 — the step is kept as written. No new DEC-12 decision is needed: DEC-12 was decided by the owner on 2026-11-27. The six real-MySQL concurrency scenarios are mandatory G4 evidence. They remain PREPARED — NOT EXECUTED. Execution requires G7 PASS and a separate explicit written owner authorization; G7 PASS alone does not authorize execution. The "fork" described below is therefore settled: the branch "Without it (explicit deferral)" is no longer available for the six scenarios. Current record: §13 of this document and `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`, D10. Current procedure: `PHASE4-OWNER-EXECUTION-RUNBOOK.md` §5.)_

**The one real fork is step 6.**

- **With the real-database run:** G4 rests on tested concurrency behaviour, and the coupon
  prediction is settled. Time depends on the database chain, which is entirely in your hands.
- **Without it (explicit deferral):** G4 can be reached on decisions alone, but criterion 2 then
  rests on mocked evidence only and criterion 3 carries one untested S2 candidate. I recommend
  against deferring TC-041.

Until every row above is closed and the client approves in writing: **Phase 4 is IN PROGRESS — NOT
APPROVED and G4 is NOT MET.**

## 9. Update 2026-11-24 — D1 implemented

The owner decided D1 only: PW-08 / A9-F02 is S2 and its fix is authorized. It is implemented.

| Item                             | Actual result                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source changed                   | `src/container.ts`, `src/bootstrap.ts`, `src/modules/payments/payments.service.ts`; one comment in `paymentProvider.ts`                                                                                            |
| Tests added                      | 14 cases in three files; no existing test changed                                                                                                                                                                  |
| Focused tests                    | 3 files, 40 passed                                                                                                                                                                                                 |
| Mutation checks (scratch copies) | Start-up check removed: 2 tests fail. Catch-and-exit removed: 2 fail. `verify` guard removed: 1 fails ("expected 200 to be 503"). Webhook guard removed: 1 fails ("expected 200 to be 404"). Unchanged copies pass |
| Self-assessment                  | PW-08 reassessed GAP → TESTED; totals TESTED 72, GAP 16 of 142                                                                                                                                                     |
| Gates                            | `format:check`, `lint`, `typecheck`, `build`, `openapi:check`: PASS                                                                                                                                                |
| Full suite                       | 120 files, 3,124 passed, 3 todo, 0 failed                                                                                                                                                                          |
| Coverage                         | Statements 92.11 %, branches 82.69 %, functions 94.74 %, lines 93.86 %                                                                                                                                             |
| Evidence type                    | Local, mocked, Node 24.12.0. Not CI, not a real-database run, not a real process start                                                                                                                             |

**Still outstanding for this finding.**

- **CI:** no run exists. The new tests have only run locally on Node 24.12.0; CI uses Node 22. _(Clarification 2026-11-27: "no run exists" is kept as written. Read it as: no CI run evidence is recorded in the reviewed project documentation. This does not establish whether a CI run occurred.)_
- **Real production-process verification:** no API or worker process was started with a production
  configuration. The exit behaviour is proven by tests that intercept `process.exit`.
- **A real payment provider** (Phase 7). Until one exists, no production process can start.

**Effect on the criteria.**

- Criterion 3: the one item recommended as a P1 is closed. The criterion is still **not confirmed**:
  M-1 is unclassified and the coupon-concurrency prediction is untested.
- Criteria 1, 2, 4 and 5: unchanged.

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.** Details: security plan §1.9.

## 10. Update 2026-11-24 — Batch 9 and Batch 10 accepted

The owner accepted both batches for **offline mocked scope only**, with ten Batch 9 risks (RK-01,
RK-02, RK-03, RK-04, RK-05, RK-06, RK-08, RK-09, RK-10, RK-13) and six Batch 10 limitations
acknowledged. Exact wording: `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §18.

**Effect on the criteria: none.** Batch acceptance is not a G4 exit criterion. It completes the
batch register that belongs to the G4 package.

| #   | Criterion                                  | Position                          | Next owner decision or action                                               |
| --- | ------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------- |
| 1   | Endpoints implemented or formally deferred | Not met _(when written; see §11)_ | D6 (webhook deferral), D7 (OpenAPI-serving route) — both decided 2026-11-24 |
| 2   | "Must" criteria pass in automated tests    | Not met                           | D2 – D5, D14 (implement or defer); D10 / DEC-12 and the database chain      |
| 3   | No open P0 / P1 defects                    | Not confirmed                     | D8 (classify M-1); TC-041 on a real database, or accept it as untested      |
| 4   | Security self-assessment complete          | Draft, not accepted               | D11                                                                         |
| 5   | Client written approval                    | Not started                       | After criteria 1–4                                                          |

_(Clarification 2026-11-27, row 3 of the table above (§10): "or accept it as untested" is the 2026-11-24 wording. That route is no longer available after DEC-12; see the clarification dated 2026-11-27 in §4.)_

What the acceptances do not establish: real-MySQL behaviour, real operating-system signals, two
worker processes, real providers, a CI run, deployment, multi-server safety or production readiness.

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.**

## 11. Update 2026-11-24 — D6 and D7 approved (formal deferrals)

**D6 (verbatim):**

> D6: I approve the formal deferral DEF-A1 to Phase 7 (provider integration). It covers `POST /webhooks/email`, `POST /webhooks/whatsapp` and `GET /webhooks/whatsapp`, and the behaviour that depends on them: delivery, read and failure status callbacks, e-mail bounce and complaint suppression, and inbound WhatsApp STOP / START handling. Condition: no real e-mail or WhatsApp provider is enabled before these are implemented and verified against the vendor sandbox.

**D7 (verbatim):**

> D7: I approve the formal deferral of serving the OpenAPI specification over HTTP (`GET /api/v1/openapi.json`). For Phase 4 the specification is the generated, committed and drift-checked file `docs/openapi/openapi.json`. HTTP serving is to be decided before the first frontend integration that needs it.

**Criterion 1 after these decisions.**

| Documented operations (method and path)                                                        | Count                            | State                                                                                    |
| ---------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Present in the OpenAPI specification                                                           | 178 of the 202 distinct mentions | Route registered with that method and path. Request and response parity **not verified** |
| Notation in the document (wildcards, shorthand, generic CRUD fragments, an example report key) | 20                               | Not operations                                                                           |
| `POST /webhooks/email`, `POST /webhooks/whatsapp`, `GET /webhooks/whatsapp`                    | 3                                | **Formally deferred** to Phase 7 (D6)                                                    |
| `GET /api/v1/openapi.json`                                                                     | 1                                | **Formally deferred** (D7)                                                               |

- **Position:** no documented operation is known to be both unimplemented and undeferred. This is a method-and-path finding. **Criterion 1 is not marked verified.** _(Clarification 2026-11-27: the first sentence of this item is the 2026-11-24 position and is kept as written. The contract audit (`PHASE4-API-CONTRACT-CONFORMANCE-AUDIT.md` §1) also identifies a signed report-export download URL that has no route and no approved deferral. It appears in the API document only in a response example and is related to FR-RPT-011. Whether this item falls within G4 criterion 1 is unresolved and requires owner review. It is not a fifth deferral and is not approved deferred scope. The four formal deferrals in the table above (D6, D7) and their statuses are unchanged.)_
- **Limits:** the check compares method and path text only. It does not compare request and
  response shapes. One shape mismatch is known (variant barcode image documented as JSON, DC-05,
  decision D14, open). The check has not been repeated by anyone else.
- **Not claimed:** publishing the specification as a release artefact is **not verified** — no
  release, and no release-publishing workflow, has been confirmed.
- **Conditions now in force:** no real e-mail or WhatsApp provider before the deferred webhooks are
  implemented and verified (D6); HTTP serving of the specification to be decided before the first
  frontend integration that needs it (D7).

**Other criteria: unchanged.**

| #   | Criterion                               | Position            | Next owner decision or action                                                         |
| --- | --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| 2   | "Must" criteria pass in automated tests | Not met             | D2 – D5, D14; the seven other proposed deferrals; D10 / DEC-12 and the database chain |
| 3   | No open P0 / P1 defects                 | Not confirmed       | D8 (classify M-1); TC-041 on a real database, or accept it as untested                |
| 4   | Security self-assessment complete       | Draft, not accepted | D11                                                                                   |
| 5   | Client written approval                 | Not started         | After criteria 1–4                                                                    |

_(Clarification 2026-11-27, row 3 of the table above (§11): "or accept it as untested" is the 2026-11-24 wording. That route is no longer available after DEC-12; see the clarification dated 2026-11-27 in §4.)_

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.**

## 12. Update 2026-11-24 — autonomous execution run (later the same day)

Evidence: local, Node 24.12.0, mocked database. Full suite 126 files, 3,237 passed, 2 todo, 0 failed; coverage statements 92.77 %, branches 84.07 %, functions 95.80 %, lines 94.32 %; `format:check`, `lint`, `typecheck`, `build` and `openapi:check` pass. Record: `PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §20.

| #   | Criterion                                           | Position after this run                                                                                                                                                                                                         | What changed                                                                                                                                                           | Still needed                                                                                             |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | All endpoints implemented or formally deferred      | **Presence confirmed by a second, independent check** that read the route files: 248 of 248 documented operations have a route, none is undocumented, the four deferred operations are the only absent ones. **Not marked met** | `PHASE4-API-CONTRACT-CONFORMANCE-AUDIT.md`: 57 contract differences recorded — 1 fixed, 22 noted in the API document §11, 2 known, 32 awaiting your decision           | Your decision on whether presence is sufficient and how the 32 open rows are handled; D14 (DC-05)        |
| 2   | FR "Must" API-side criteria pass in automated tests | **Not met**                                                                                                                                                                                                                     | Traceability: tested 226 (was 219), no test found 0 (was 7), partial 11, blocked / deferred 2. Five of the seven moved rows rest on a static schema test, not on MySQL | D2 – D5; the seven proposed deferrals; D10 / DEC-12 and the database chain for the six concurrency cases |
| 3   | No open P0 / P1 defects                             | **Not confirmed**                                                                                                                                                                                                               | No new S1 / S2 found. One S4 defect found and fixed (public ETag, CA1-09)                                                                                              | D8 (classify M-1); TC-041 on a real database, or its acceptance as untested                              |
| 4   | Security self-assessment complete                   | **Draft, not accepted**                                                                                                                                                                                                         | TESTED 74, CODE-VERIFIED 13, PREPARED 6, GAP 14 (was 72 / 15 / 4 / 16)                                                                                                 | D11                                                                                                      |
| 5   | Client written approval                             | **Not started**                                                                                                                                                                                                                 | Nothing                                                                                                                                                                | After criteria 1 – 4                                                                                     |

_(Clarification 2026-11-27, row 4: the figures "GAP 14" and "PREPARED 6" include the reassessment of SH-10 and CS-03 from GAP to PREPARED by the author of the 2026-11-24 update. That reassessment has not been reviewed or approved by the owner; see the clarification dated 2026-11-27 in §5.)_

_(Clarification 2026-11-27, row 1: 248 is the number of specification operations, all with routes. Route presence is not contract conformance; 32 contract rows are open. See the contract audit §1 (`PHASE4-API-CONTRACT-CONFORMANCE-AUDIT.md`). Criterion 1 is still not marked met. The row is kept as written.)_

_(Clarification 2026-11-27, row 1, the words "the four deferred operations are the only absent ones": the contract audit §1 also identifies a signed report-export download URL that has no route and no approved deferral. It appears in the API document only in a response example and is related to FR-RPT-011. Whether this item falls within G4 criterion 1 is unresolved and requires owner review. No fifth deferral exists, and the item is not approved deferred scope. The four formal deferrals (D6, D7) and their statuses are unchanged. This note does not say that any operation is contract-conformant.)_

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.** Nothing in this run is evidence for MySQL, real providers, CI, deployment or production.

## 13. Update 2026-11-27 — DEC-12 decided: real MySQL verification required for G4

**Owner decision, received 2026-11-27. Decision ID: DEC-12. Reply label: D10.** REAL MYSQL VERIFICATION REQUIRED FOR G4. Full record: `PHASE4-FINAL-OWNER-DECISION-PACKAGE.md`, D10.

**Required evidence — all of it outstanding.** Each of the six prepared scenarios must pass against the designated `ecommerce_test` database and produce reviewable evidence before G4 acceptance. Current state of each: REQUIRED FOR G4 · PREPARED — NOT EXECUTED · execution not authorized.

- TC-004 — refresh-token replay
- TC-030 — last-unit oversell
- TC-041 — coupon last redemption
- TC-045 — invoice number sequence
- TC-048 — Idempotency-Key replay
- TC-051 — webhook versus verify capture

The evidence stays outstanding until the scenario run is separately authorized, executed by the owner, and its evidence accepted by the owner. A failing scenario must be investigated, classified and resolved through separately authorized work. No scenario has run and none has passed.

**Effect on the criteria.**

- **Criterion 2:** not met. The six cases need passing real-database evidence; they are not deferred.
- **Criterion 3:** not confirmed. The coupon over-redemption prediction stays untested until TC-041 runs. Coupon hardening is NOT AUTHORIZED; it will be considered separately after the TC-041 evidence has been reviewed.
- **Criteria 1, 4 and 5:** unchanged.

**Not decided, or not changed, by DEC-12.**

- **Execution.** DEC-12 is an evidence requirement only. It grants no new authorization for G2 backup or restore, G3 migrator-user or privilege operations, the G7 scratch-database migration, the G8 migration against `ecommerce_dev`, execution of the six scenarios, seeds, or database user, grant, schema or data changes. All existing prerequisites and separate explicit authorizations remain mandatory. Only the owner executes user-only database procedures.
- **G2.** Existing G2 authorization and status are unchanged: USER EXECUTION IN PROGRESS — NOT ACCEPTED. DEC-12 neither grants nor withdraws a G2 authorization. G2 is independent of DEC-12.
- **GST-15.** Excluded from DEC-12; a separate owner decision is required. Not approved, deferred, implemented or verified.
- **Batch 12.** The older roadmap reference to a proposed Batch 12 MySQL suite is not addressed and is not included in the six scenarios. Open pending separate owner clarification.
- **Iteration count.** Not decided. Neither the harness default of 3 nor the testing-strategy values of 5 and 20 is selected. A separate decision is needed before scenario execution.
- **Outside the decision.** G8, seeds, staging, GST-15 and production database operations.

**Clarification 2026-11-27 (execution prerequisites and traceability).** G7 PASS is a prerequisite before any of the six scenarios is executed. G7 PASS alone does not authorize scenario execution: a separate explicit written authorization from the owner is also required. TC-041 is the real-database evidence scenario for requirement FR-CPN-008 and its acceptance criterion AC-03, so it is the required evidence for that "Must" row under criterion 2 and for the coupon case under criterion 3. TC-041 has not been executed. Coupon hardening remains NOT AUTHORIZED until the TC-041 evidence has been reviewed and a separate owner decision is made.

**G4 is NOT MET. Phase 4 is IN PROGRESS — NOT APPROVED.** Recording DEC-12 satisfies no criterion.
