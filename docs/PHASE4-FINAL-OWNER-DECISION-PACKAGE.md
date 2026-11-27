# Phase 4 — Final Owner Decision Package

| Field    | Value                                                                                     |
| -------- | ----------------------------------------------------------------------------------------- |
| Date     | 2026-11-24                                                                                |
| Nature   | Decision support. **Nothing in this document is decided, approved, accepted or deferred** |
| Basis    | The three latest reports, re-checked against the current code on 2026-11-24 (read-only)   |
| Evidence | Local, mocked / offline. Not real-database, CI, staging or production evidence            |

_(Clarification 2026-11-27, "Nature" row: the words "Nothing in this document is decided, approved, accepted or deferred" describe the package as first issued on 2026-11-24 and are kept as written. Later dated records in this document govern their own items: D1, D6, D7, D12, D13 and DEC-12 (reply label D10). Every item without such a record is still open. This note adds, approves and changes no decision.)_

**Status preserved:** Phases 1–3 APPROVED — COMPLETE · Phase 4 IN PROGRESS — NOT APPROVED · G4 NOT
MET · Batch 9 PENDING USER ACCEPTANCE · Batch 10 PENDING USER ACCEPTANCE.

_Update 2026-11-24: Batch 9 and Batch 10 were accepted by the owner for offline mocked scope only (Parts 3 and 4). Phase 4 stays IN PROGRESS — NOT APPROVED and G4 NOT MET._

_Update 2026-11-24: D6 and D7 were approved by the owner as formal deferrals (records under D6 and D7 below). Every other decision and every other proposed deferral stays open._

_Update 2026-11-27: DEC-12 (reply label D10) was decided by the owner: real MySQL verification of the six prepared concurrency scenarios is required for G4 (record under D10 below). The decision authorizes no database execution. Coupon hardening is not authorized. Every other open decision and every proposed deferral stays open._

> **Update 2026-11-24 — D1 is decided and implemented.** You classified PW-08 / A9-F02 as S2 and
> authorized the fix (Option 1). It is implemented and tested; results are under D1 below and in
> the security plan §1.9. **Every other decision in this package is still open.** Nothing else
> was approved, accepted or deferred.

**Decision status on 2026-11-24.**

| Decision                               | Status                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 Mock payment provider in production | **RESOLVED** — approved wording: "I classify PW-08 / A9-F02 as S2 and authorize the fix in the security plan §1.5 Option B with the tests in §1.6." Implemented and locally verified |
| D2 – D5                                | **OPEN**                                                                                                                                                                             |
| D6 E-mail and WhatsApp webhooks        | **RESOLVED — FORMAL DEFERRAL APPROVED** (owner, 2026-11-24): DEF-A1 to Phase 7, three operations and their dependent behaviour, with one condition                                   |
| D7 `GET /api/v1/openapi.json`          | **RESOLVED — FORMAL DEFERRAL APPROVED** (owner, 2026-11-24): HTTP serving of the specification deferred                                                                              |
| D8 – D11                               | **OPEN**                                                                                                                                                                             |
| D12 Batch 9                            | **RESOLVED — ACCEPTED, OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-24; ten risks acknowledged — Part 3)                                                                              |
| D13 Batch 10                           | **RESOLVED — ACCEPTED, OFFLINE MOCKED SCOPE ONLY** (owner, 2026-11-24; six limitations acknowledged — Part 4)                                                                        |
| D14 – D17                              | **OPEN**                                                                                                                                                                             |
| Proposed deferrals                     | DEF-A1: **APPROVED** (2026-11-24, D6). DEF-A2 … DEF-A5 and DEF-B1 … DEF-B3: **NOT APPROVED**                                                                                         |

**Decision status change on 2026-11-27.** DEC-12 (reply label D10) is **DECIDED — REAL MYSQL VERIFICATION REQUIRED FOR G4** (owner, received 2026-11-27; record under D10 below). The table above is the 2026-11-24 position and is kept as written. Its row "D8 – D11 — OPEN" now reads as follows: D8, D9 and D11 are still OPEN; under D10, DEC-12 is decided and only the coupon-hardening question remains, which is NOT AUTHORIZED and will be considered separately. No database execution is authorized by the decision.

**How to answer.** Each decision has a quoted sentence for every option. Reply with the heading and
the option, for example "D1: approve option 1". Silence is not approval.

**Identifiers.** Only identifiers that already exist in the project documents are used (requirement
IDs, control IDs, `DEC-…`, `DEF-…`, `RK-…`, `ACC-02`). The headings D1 … D17 below are section
numbers of this package for replying; they are not new decision IDs. The labels "SEC-F02",
"DB-P1", "DEC-13d", "DC-06" and "SEC-ACC" in the 2026-11-24 reports were reference labels written
by those reports; they carry no approval status.

**Identifier collisions (disambiguation note, 2026-11-27).** This note is a reading aid only. It renames nothing, changes no decision record and alters no historical reference. Several labels are used with more than one meaning in the project documents:

- **D1 – D17** are the reply headings of this package. **D1 – D6** are also the delivery principles of the canonical roadmap (`project-documentation/10-project-management/IMPLEMENTATION_ROADMAP.md` §2).
- **D8 – D14** are also database decisions approved on 2026-11-17 (`INCREMENT-B-RISK-ASSESSMENT.md` §0.1). For example, "D9" is both the open promotions-guard question of this package and an implemented foreign-key rule.
- **D6** has a third meaning in `PHASE4-MASTER-COMPLETION-ROADMAP.md`: a Batch 7 audit item about deleting revoked refresh tokens (deferred, RD-11). It is not the owner decision D6 of this package.
- **DOC-01 – DOC-12** are documentation tasks in the master completion roadmap, and also document IDs of the canonical documents. For example, DOC-12 is `API_DOCUMENTATION.md` and DOC-06 is `PROJECT_CONTEXT.md`.
- **DEF-01 – DEF-08** are the "deferred / future scope" items of the master completion roadmap (§4-I). They are distinct from the proposed-deferral identifiers DEF-A1 – DEF-B3, of which only DEF-A1 is approved.
- **CC-01 – CC-09** are concurrency test cases in `TESTING_STRATEGY.md` §8. **CC-01 – CC-06** are also security controls in the security self-assessment draft. For example, CC-03 is "coupon last redemption" in the first and "cart races" in the second.
- **G7 and G8** are database gates in the Phase 4 documents (G7: scratch-database migration; G8: migration against `ecommerce_dev`). They are also the exit gates of Phase 7 and Phase 8 in the canonical roadmap.
- **DB-P1 – DB-P3** are labels for predicted database behaviours. The "P" is not a priority or a severity.
- **DEC-12 and RD-12** are unrelated decisions with similar identifiers. DEC-12 is the real-MySQL verification decision. RD-12 is the architecture-only worker decision (D-61).
- **B1 – B7** are decision labels of implementation Batch 9 (the dedicated worker; for example "Batch 9 decision B3"). **B1 – B9** are also Phase 4 milestone labels (B0-a … B9). _(This entry and the two below were added later on 2026-11-27.)_
- **Batch numbers.** The documentation audits and correction batches of 2026-11-27 were numbered 1 – 8 in the working session. They are not the implementation Batches 7 – 13: Batches 7, 8, 9 and 10 are accepted for offline mocked scope only, and Batches 11 – 13 are not defined as formal batches (DEC-19). The documentation correction wave that followed is labelled DCW-9, so that it is not read as implementation Batch 9.
- **ACC-03 and AC-03** are unrelated. ACC-03 is the acceptance item for the earlier deliverables (with DEC-03). AC-03 is the acceptance criterion of FR-CPN-008 (coupon last redemption).

These are naming collisions only. This note renames no identifier and alters no decision record.

Companion documents: `PHASE4-FINAL-SECURITY-REVIEW-AND-REMEDIATION-PLAN.md`,
`PHASE4-OWNER-EXECUTION-RUNBOOK.md`, `PHASE4-G4-CRITERIA-AND-EVIDENCE-MATRIX.md`.

---

## Part 1 — Reconciled inventory (verified 2026-11-24)

### 1.1 Completed technical work (re-verified in the current tree)

| Item                                            | Verification                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No source file changed since 2026-11-21         | File-time scan of `src/`, `prisma/`, `scripts/`, `package.json`                                                                                                        |
| Notification defects DF-01, DF-02, DF-03        | Fixed in code; 292 notification tests pass                                                                                                                             |
| Batch 10: WP10-1 … WP10-6 and the scheduler fix | Code and tests present; two mutation checks; §Part 4                                                                                                                   |
| FR-ORD-006, FR-INV-006, FR-SF-004               | Code and tests present                                                                                                                                                 |
| Refund and promotion documentation              | 29 dated corrections applied; consistent with the code                                                                                                                 |
| Database harness                                | Prepared; guard refuses without variables; **never executed**                                                                                                          |
| Local gates                                     | `format:check`, `lint`, `typecheck`, `build`, `openapi:check` pass; **120 files, 3,124 passed, 3 todo, 0 failed** after the D1 fix (119 files, 3,110 passed before it) |

### 1.2 Remaining implementation work (none is authorized)

| Item                                                     | Size                                                                | Part |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ---- |
| Mock payment provider refusal in production              | **Done 2026-11-24** (authorized under D1)                           | D1   |
| FR-AD-008 leftovers (payment retry, recently viewed)     | Small                                                               | D2   |
| FR-PRM-004 promoted price on listing and detail          | Medium                                                              | D3   |
| FR-PL-013 search by brand, category, attributes          | Small to medium                                                     | D4   |
| FR-TAX-013 HSN summary on the invoice PDF                | Small, after the tax answer                                         | D5   |
| `GET /api/v1/openapi.json` (documented, not implemented) | Small — **formally deferred 2026-11-24**, not to be implemented now | D7   |
| Promotions guard for D-63                                | Small                                                               | D9   |
| Barcode content type in OpenAPI                          | Trivial                                                             | D14  |

### 1.3 Contradictions found between the reports and the code

| #   | Where                                                                      | Contradiction                                                                                                                                                                                                                                                                                                                    | Effect                                          |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | Remaining-decisions §1 heading; decision package ACC-02                    | Both say "nine risks". The authoritative review lists **15** risks and requires acknowledgement of **11** (RK-01 … RK-10, RK-13). The table under the heading does list all 11                                                                                                                                                   | Part 3 uses the 15 and the 11                   |
| 2   | Authoritative review, RK-04 wording                                        | Says "four flows". The code has five paths (admin retry added)                                                                                                                                                                                                                                                                   | Verbatim wording kept in Part 3, with the note  |
| 3   | Master report §14, criterion 1                                             | Lists two missing webhook endpoints. A re-check of every `METHOD /path` in API_DOCUMENTATION against the 248 OpenAPI operations finds **four** documented operations with no implementation: `POST /webhooks/email`, `POST /webhooks/whatsapp`, `GET /webhooks/whatsapp` (verification handshake) and `GET /api/v1/openapi.json` | D6 and D7                                       |
| 4   | Master report §10; remaining-decisions §6                                  | "No tests for the strict-environment rules". Tests exist for `https`, rate limiting and logs. Missing: required secrets, `COOKIE_SECURE`, webhook production refusal                                                                                                                                                             | Corrected in the master report addendum         |
| 5   | DEC-13 traceability report (Agent 6), FR-PRM-004                           | Says the catalogue sets no cache headers. The code sends `Cache-Control: public, max-age=60, stale-while-revalidate=300` on anonymous catalogue responses (`src/modules/catalog/index.ts`)                                                                                                                                       | Matters for D3                                  |
| 6   | Several documents: "push a branch so CI runs"                              | `ci.yml` runs only on a push **to `main` or `develop`**, or on a pull request **targeting** them. A push to another branch runs nothing                                                                                                                                                                                          | Runbook step 6                                  |
| 7   | `CI-CD-AND-DEPLOYMENT-PREPARATION.md` §8                                   | Still shows the baseline: `lint` and `format:check` failing, 113 files. Current result: all pass, 119 files                                                                                                                                                                                                                      | Corrected 2026-11-24 with a dated results table |
| 8   | `paymentProvider.ts` line 184 (code comment)                               | "the mock is refused in production by the payments module". True for the webhook only                                                                                                                                                                                                                                            | D1 — comment corrected 2026-11-24               |
| 9   | Decision package DEC-12                                                    | Says cleanup "by truncating tables". The harness uses `DELETE` only, so the test user needs no `DROP` privilege                                                                                                                                                                                                                  | Stricter than documented; note only             |
| 10  | Tracker §1 and §3 against §10                                              | Earlier sections still show Batch 10 "NOT AUTHORIZED" and DF-01 … 03 open. §10 supersedes them and says so                                                                                                                                                                                                                       | History kept by design                          |
| 11  | Your closure brief, items "G7 migration execution" and "G8 seed execution" | In the authoritative roadmap, G7 is the migration on a **scratch** database and G8 is the migration on **`ecommerce_dev`**. Seeds are a separate step after G8, with their own authorization                                                                                                                                     | Runbook steps 3–5                               |

---

## Part 2 — Decisions

### D1. Mock payment provider in production (control PW-08, finding A9-F02) — RESOLVED 2026-11-24

**Scope.** The API and worker can start with `NODE_ENV=production` and the mock payment provider.
`POST /payments/verify` then accepts a signature made with a public constant, and a signed-in
customer could mark an own order as paid. Not reachable today. Full analysis, fix and tests:
security plan §1.

**Recommendation.** Classify as **S2** (S1 if a production deployment existed) and authorize the
fix now.

| Choice                     | Consequence                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorize the fix          | Three source files change (`container.ts`, `bootstrap.ts`, `payments.service.ts`) plus one comment; eight new tests; no existing test changes. Afterwards no production process can start until a real provider exists |
| Classify S2 and do not fix | An open P1 remains; G4 criterion 3 is not met                                                                                                                                                                          |
| Classify S3 and defer      | G4 criterion 3 is not blocked by this item, but the protection then depends on Phase 7 remembering it                                                                                                                  |

**Dependencies.** None. **Approver.** Owner (severity: owner / QA under D-62).

**Decision wording:**

- Option 1 (recommended): "I classify the mock-payment-provider finding (PW-08 / A9-F02) as S2 and
  authorize the fix described in the security plan §1.5 Option B with the tests in §1.6. No other
  source change is authorized by this."
- Option 2: "I classify PW-08 / A9-F02 as S2. The fix is not authorized now."
- Option 3: "I classify PW-08 / A9-F02 as S3 and defer the fix to the payment-provider integration."

**Decision recorded (owner, 2026-11-24): Option 1.** "I classify PW-08 / A9-F02 as S2 and authorize
the fix in the security plan §1.5 Option B with the tests in §1.6."

**Implemented 2026-11-24.**

| Item                   | Actual result                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source files changed   | `src/container.ts`, `src/bootstrap.ts`, `src/modules/payments/payments.service.ts`; comment only in `src/integrations/payments/paymentProvider.ts`                         |
| Test files             | `tests/unit/core/container.test.ts` (6 cases added), `tests/integration/modules/payments/payments.routes.test.ts` (3 added), `tests/unit/bootstrap.test.ts` (new, 5 cases) |
| Existing tests changed | None                                                                                                                                                                       |
| Behaviour              | Production start with the mock provider exits with code 1; `POST /payments/verify` answers 503 for the mock in production; development, test and staging unchanged         |
| Mutation checks        | Removing any one of the three guards makes its test fail                                                                                                                   |
| Gates                  | `format:check`, `lint`, `typecheck`, `build`, `openapi:check` pass; 120 files, 3,124 passed, 3 todo, 0 failed                                                              |
| Evidence type          | Local, mocked. Not CI, not a real process start                                                                                                                            |

Consequence now in force: no production process can start until a real payment provider exists.

### D2. FR-AD-008 — two code paths ignore the settings

**Verified.**

| Setting                            | Honoured in                                                             | **Not** honoured in                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.reservation_ttl_minutes` | Order placement (`checkout.service.ts` line 267)                        | Payment retry: `payments.service.ts` line 438 calls `reservationExpiry(now)`, which uses the environment value (`inventory.stock.ts` line 472)                                                        |
| `catalog.new_arrival_days`         | Listing, related products, `isNewArrival` filter (`catalog.service.ts`) | Recently viewed: `recently-viewed.service.ts` line 39 calls `mapCard` without the window, so the 30-day default applies. Wishlist does the same, but its response drops badges, so nothing is visible |

**Effect.** With the TTL set to 30 minutes, the first attempt holds stock for 30 minutes and a retry
holds it for the environment value (default 15). The same product can show `NEW_ARRIVAL` on the
listing and not in "recently viewed".

**Smallest implementation (not authorized).**

- `payments.service.ts` `retryPayment`: read the TTL through the existing
  `reservationTtlMinutes(tx, fallback)` reader and compute the expiry from it.
- `recently-viewed.service.ts` `list`: call the existing `loadNewArrivalDays(db)` once and pass it
  to `mapCard`. Pass it in `wishlist.mapper.ts` too, for consistency.
- Tests: retry with the setting present, missing and invalid; recently-viewed badge with a
  configured window.
- No schema, API-contract or dependency change.

**Recommendation.** Implement (small, closes a "Must" requirement that is otherwise partial).

**Decision wording:**

- Option 1 (recommended): "I authorize the FR-AD-008 leftover change: payment retry honours
  `checkout.reservation_ttl_minutes` and recently-viewed and wishlist cards honour
  `catalog.new_arrival_days`, with tests."
- Option 2: "FR-AD-008 stays partial. Prepare a deferral record for my approval."

**Approver.** Owner.

### D3. FR-PRM-004 — promoted price and badge on listing and detail

**Requirement** (`PROJECT_REQUIREMENTS.md`, priority M, source `[PROPOSED]`): "Promoted price shown
on PLP/PDP with original price struck through; never below ₹1 [PROPOSED]."

**Current limitation (verified).**

- `catalog.mapper.ts` `mapCard` builds `price.min/max` from the variant selling price and returns
  `promotionLabel: null` (line 129). Its header still says no promotion engine exists.
- `catalog.service.ts` `mapDetail` returns `effectivePrice` = selling price and `promotion: null`
  (lines 598–600).
- Price filter, sort and facets use the base price.
- The cart and checkout **do** apply promotions through the pricing engine. A customer therefore
  sees the base price on the listing and a lower price in the cart.
- `API_DOCUMENTATION.md` already describes effective prices and a promotion label on these
  endpoints, so the storefront will be built against fields that are always null today.
- The engine's floor is ₹0.01, not ₹1.

**Performance.** Reuse the existing loader and `selectBestPromotion`: a fixed number of extra
queries per page, matching in memory, no query per product. Filtering and sorting by effective
price is a different size: the stored price columns are base prices, so it needs a maintained
column (schema change plus a job) or in-memory filtering that breaks pagination.

**Caching.** Anonymous catalogue responses are sent with
`Cache-Control: public, max-age=60, stale-while-revalidate=300`. FR-PRM-003 requires a promotion's
start and end to take effect within one minute. With promoted prices in these responses, a shared
cache may serve a stale price for up to 60 seconds, and for up to five more minutes while it
revalidates. The cart always prices fresh, so the customer would see the price change at the cart.
Implementing FR-PRM-004 therefore needs a decision on that header.

**Consistency.** A promotion can end between page view and add-to-cart. The open D-63 discrepancy
(D9) would become visible on listings. Changing the floor to ₹1 changes cart and checkout totals.

| Choice                              | Consequence                                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implement display now (recommended) | Medium change in the catalogue module, no schema change. Listing, detail, related, autocomplete, wishlist and recently-viewed show the same price as the cart. Closes the requirement apart from the floor |
| Defer                               | Listing and detail keep showing base prices. The storefront (Phase 5) is built against null promotion fields and must be revisited                                                                         |

**Recommendation.** Implement the display part before storefront work starts. Keep price filter,
sort and facets on the base price for now and record that as a limitation. Keep the ₹0.01 floor
unless you confirm ₹1 separately.

**Dependencies.** The cache-header decision; D9 is advisable first.

**Acceptance criteria if implemented.**

1. Detail returns `effectivePrice` = selling price minus the unit discount of the best promotion,
   and `promotion { id, label }`; `sellingPrice` and `mrp` unchanged.
2. Listing returns effective `price.min/max` and a non-null `promotionLabel` when a variant is
   promoted.
3. Without an effective promotion, responses are identical to today.
4. For the same variant at the same instant, detail `effectivePrice` equals the cart unit price
   after promotion.
5. `DRAFT`, `PAUSED`, `EXPIRED`, deleted and out-of-window promotions never change a price.
6. A listing request issues a fixed number of promotion queries, whatever the page size.
7. Every endpoint that returns a listing card shows the same price for the same product.
8. The cache header on these responses matches your decision.

**Decision wording:**

- Option 1 (recommended): "FR-PRM-004: implement the display of promoted prices and labels on
  listing and detail endpoints, per the acceptance criteria in the decision package D3. Price
  filter, sort and facets stay on the base price. The engine floor stays ₹0.01."
- Option 2: "FR-PRM-004: formally defer to the start of Phase 5 (before storefront listing and
  detail integration). Prepare the deferral record for my approval."
- Separate, either way: "The ₹1 floor in FR-PRM-004 is confirmed / is not confirmed."

**Approver.** Owner.

### D4. FR-PL-013 — search by brand, category and attribute values

**Requirement** (priority M, `[CONFIRMED]`): "Product search over name, SKU (exact), brand,
category, attribute values; minimum 2 characters."

**Current behaviour (verified).** `catalog.service.ts` `buildWhere` (lines 163–173) matches `q`
against product name, search keywords and short description (`contains`) and an active variant SKU
(`startsWith`). Autocomplete lists matching brands and categories as suggestions but does not use
them to find products. The two-character minimum is enforced. No test asserts the search clause of
`GET /products?q=`.

**Gap.** A brand name, category name or attribute value finds a product only if the same word is
also in its name, keywords or description. The requirement says "SKU (exact)"; the code matches by
prefix.

**Scope and dependencies.** Extending the `OR` list with brand name, category name and attribute
values needs no schema change and no API-contract change. `contains` across joined tables cannot
use an index; that is acceptable for a small catalogue. Full-text search or a search column is a
schema change. Inactive or deleted brands, categories and attribute values must not match;
attributes that are neither filterable nor shown should not be searchable.

| Choice                                      | Consequence                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Implement the plain extension (recommended) | Small to medium. Requirement met for a small catalogue. No ranking; weak matches may rank high |
| Defer                                       | Search stays name / keyword based. Merchandisers must put brand and material words in keywords |
| Full-text search                            | Larger; needs a schema decision. Not recommended for G4                                        |

**Acceptance criteria if implemented.**

1. `GET /products?q=` returns a visible product when the text (2–100 characters) is contained in
   its name, its active brand's name, its active category's name, or an active attribute value of
   the product or of one of its active variants; or matches an active variant SKU.
2. Inactive or deleted brands, categories and attribute values never produce a match.
3. A shorter `q` returns 422 (unchanged).
4. Autocomplete finds products by the same fields.
5. "jhumka" still matches "Oxidised Jhumkas".
6. Facet counts for a search use the same rule.

**Decision wording:**

- Option 1 (recommended): "FR-PL-013: implement the plain search extension per the acceptance
  criteria in D4, with tests. No schema change."
- Option 2: "FR-PL-013: formally defer. Prepare the deferral record for my approval."
- Separate: "SKU matching by prefix is acceptable / SKU matching must be exact."

**Approver.** Owner.

### D5. FR-TAX-013 — HSN summary on the invoice PDF

**Requirement** (priority M, `[CONFIRMED]`, no acceptance note): "Invoice tax breakdown per line and
per component, HSN summary."

**What exists (verified).** `invoices.pdf.ts` prints one row per line with an HSN column, the rate,
the taxable value and one column per tax component, then one totals line. A period-level HSN report
(`gst-hsn`) exists in the reports module.

**What is missing.** No block on the invoice or credit-note PDF that groups amounts by HSN (or by
rate). No test asserts the printed content of the PDF.

**What needs a tax professional.** This document makes no statement about what the law requires.

- Whether an HSN-wise summary must appear on each invoice, or whether the periodic report meets
  the need.
- Whether the summary is by HSN, by HSN and rate, or by rate.
- How shipping and COD-fee rows are assigned to an HSN, and the `'0000'` placeholder used in one
  fallback.
- Whether a unit-quantity code is needed (the approved schema has no such column).

`TAX_AND_GST_WORKFLOWS.md` §16.3 lists "HSN code per line" among the fields "to be verified with
CA" and has no HSN-summary item. RD-01 contains only the odd-paisa question; the HSN question has
not been written into it.

**Recommendation (safest next step).** Do not implement yet. Add the questions above to the RD-01
list, obtain the written answer, then decide. Until then record a formal deferral that depends on
that answer.

**Decision wording:**

- Option 1 (recommended): "FR-TAX-013: add the HSN-summary questions in D5 to the tax
  professional's list (RD-01). Formally defer the PDF change until the written answer is received.
  Prepare the deferral record for my approval."
- Option 2: "FR-TAX-013: implement an HSN-and-rate summary table on invoice and credit-note PDFs
  now, summing stored ledger rows, with tests; review again after the tax answer."
- Option 3: "FR-TAX-013: the `gst-hsn` report satisfies 'HSN summary'. Re-word the requirement."
  (Advisable only with the tax professional's agreement.)

**Approver.** Owner, with the tax professional's written input.

### D6. E-mail and WhatsApp delivery webhooks (proposed deferral DEF-A1) — RESOLVED 2026-11-24 (deferral approved)

**Scope.** `API_DOCUMENTATION.md` documents `POST /webhooks/email`, `POST /webhooks/whatsapp` and
the verification handshake `GET /webhooks/whatsapp`. None is implemented. The existing proposal
DEF-A1 names the two `POST` routes; the `GET` handshake belongs with them. Part of FR-NTF-005.

| Field              | Proposed text                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Recommendation     | Defer                                                                                                            |
| Reason             | The vendors are not chosen (OQ-08), so the signature schemes and payloads are unknown                            |
| Consequence        | No delivery or bounce status in notification logs. Sending itself is unaffected                                  |
| Risk               | A bounced or failed message is not visible; affects support, not security                                        |
| Dependency         | Vendor selection (OQ-08)                                                                                         |
| Proposed milestone | Phase 7, provider integration                                                                                    |
| Acceptance later   | Signed webhooks verified against the vendor sandbox; delivery status recorded; replay and bad signatures refused |
| Effect on G4       | Criterion 1 is met for these three operations only when the deferral is approved                                 |

**Decision wording:**

- Option 1 (recommended): "I approve the deferral DEF-A1 to Phase 7, extended to include
  `GET /webhooks/whatsapp`."
- Option 2: "DEF-A1 is not approved."

The other proposed deferrals are unchanged and still await you: DEF-A2 (async report exports),
DEF-A3 (MFA recovery codes), DEF-A4 (CAPTCHA), DEF-A5 (breached-password service), DEF-B1
(out-of-stock sort), DEF-B2 (CSV bulk upload), DEF-B3 (upload limits). Their records are in
`PHASE4-REMAINING-USER-DECISIONS.md` §3. Wording: "I approve DEF-A2, DEF-A3, DEF-A4, DEF-A5,
DEF-B1, DEF-B2, DEF-B3" (or name the ones you approve).

**Approver.** Owner.

**Decision recorded (owner, 2026-11-24) — verbatim:**

> D6: I approve the formal deferral DEF-A1 to Phase 7 (provider integration). It covers `POST /webhooks/email`, `POST /webhooks/whatsapp` and `GET /webhooks/whatsapp`, and the behaviour that depends on them: delivery, read and failure status callbacks, e-mail bounce and complaint suppression, and inbound WhatsApp STOP / START handling. Condition: no real e-mail or WhatsApp provider is enabled before these are implemented and verified against the vendor sandbox.

| Field                        | Record                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status                       | **APPROVED — FORMALLY DEFERRED** (owner, 2026-11-24)                                                                                                                           |
| Deferral record              | DEF-A1, with the extended scope below                                                                                                                                          |
| Operations deferred          | `POST /webhooks/email`, `POST /webhooks/whatsapp`, `GET /webhooks/whatsapp`                                                                                                    |
| Behaviour deferred with them | Delivery, read and failure status callbacks; e-mail bounce and complaint suppression; inbound WhatsApp STOP / START handling                                                   |
| Deferred to                  | Phase 7 (provider integration)                                                                                                                                                 |
| Condition                    | No real e-mail or WhatsApp provider is enabled before these are implemented and verified against the vendor sandbox                                                            |
| Not covered                  | Sending through the fake adapters (unchanged); logging of direct authentication e-mails (DEC-13c, open); the real-vendor requirement FR-NTF-002; every other proposed deferral |
| Code state                   | Not implemented: the notifications module registers no webhook router; the three operations are not in the OpenAPI specification                                               |

The proposal text above is kept as presented. The approved scope is wider than the original DEF-A1
row: it names the `GET` handshake and the three dependent behaviours, and it adds the condition.
The seven other proposed deferrals named above are **not** approved by this decision.

### D7. `GET /api/v1/openapi.json` — documented, not implemented — RESOLVED 2026-11-24 (deferral approved)

**Found in this review.** `API_DOCUMENTATION.md` (release process, marked "added detail") says the
specification is "served at `GET /api/v1/openapi.json` in non-production". No such route exists in
`src/`, and it is not in the generated specification. No earlier report records this.

| Choice                             | Consequence                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Implement (small)                  | One read-only route in non-production that serves the committed file; one test                                        |
| Re-word the document (recommended) | State that the specification is a committed and release artefact; drop the serving sentence until a frontend needs it |
| Defer                              | A deferral record is needed for G4 criterion 1                                                                        |

**Decision wording:**

- Option 1 (recommended): "Re-word API_DOCUMENTATION so that serving the specification over HTTP
  is not promised in Phase 4."
- Option 2: "Implement `GET /api/v1/openapi.json` for non-production, with a test."
- Option 3: "Formally defer it. Prepare the deferral record."

**Approver.** Owner.

**Decision recorded (owner, 2026-11-24) — verbatim:**

> D7: I approve the formal deferral of serving the OpenAPI specification over HTTP (`GET /api/v1/openapi.json`). For Phase 4 the specification is the generated, committed and drift-checked file `docs/openapi/openapi.json`. HTTP serving is to be decided before the first frontend integration that needs it.

| Field                   | Record                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                  | **APPROVED — FORMALLY DEFERRED** (owner, 2026-11-24)                                                                                                                                        |
| Operation deferred      | `GET /api/v1/openapi.json` (serving the OpenAPI specification over HTTP)                                                                                                                    |
| What stands for Phase 4 | The generated, committed and drift-checked file `docs/openapi/openapi.json` (`npm run openapi:generate`, `npm run openapi:check`)                                                           |
| Deferred to             | To be decided before the first frontend integration that needs it                                                                                                                           |
| Not covered             | Generation and the drift check (in place); publishing the specification as a release artefact (FR-ARC-008) — **not verified: no release or release-publishing workflow has been confirmed** |
| Code state              | Not implemented: no route serves the specification under any path                                                                                                                           |

The owner chose formal deferral. The options listed above are kept as presented. Two canonical
statements that promised the HTTP endpoint were corrected with dated notes on 2026-11-24:
`API_DOCUMENTATION.md` §8 item 3 and `CROSS_APPLICATION_INTEGRATION.md` §10 (Distribution row).

### D8. Refund interrupted after commit (M-1, RK-04) and DEC-05-next

Analysis: security plan §2.

**Recommendation.** Classify M-1 as S3 for G4. Keep the manual procedure (runbook §9.1). Formally
defer the recovery action to the payment-provider integration, with the condition that no
production payments are taken until it exists and is tested against the provider sandbox.

**Decision wording:**

- Option 1 (recommended): "M-1 is S3 for G4. The re-submission / recovery action (DEC-05-next) is
  deferred to the payment-provider integration, and is a condition for taking production payments.
  Prepare the deferral record."
- Option 2: "M-1 is S2. It must be resolved before G4." (This needs the provider contract, which
  does not exist yet, so G4 would wait for Phase 7 work.)

Also for you: confirm or reject the caveat added to runbook §9.1 step 1 for retried refunds; agree
the "stale" threshold with finance; decide how a provider reference longer than 40 characters is
recorded.

**Approver.** Owner (finance for the threshold).

### D9. Promotions and D-63 (DEC-06-impl)

**Verified.** A promotion whose **stored** status is `EXPIRED` is final. A promotion still stored
`ACTIVE` / `SCHEDULED` after its end date can be revived by a `PATCH` that moves the end date
forward. The window is unbounded when no worker runs (`JOBS_ENABLED` defaults to `false`). A
`PAUSED` promotion past its end date can have its dates extended and then be resumed.

**Recommendation.** Authorize the narrow guard and extend it to the paused case, so that D-63 holds
on every path. Recommended severity of the discrepancy: S3.

**Decision wording:**

- Option 1 (recommended): "DEC-06-impl: authorize a guard that rejects date and status edits when
  the promotion's end date has passed, including a `PAUSED` promotion, with 409
  `INVALID_STATE_TRANSITION` and tests."
- Option 2: "DEC-06-impl: authorize the narrow guard only (effective status `EXPIRED`); a paused
  promotion past its end date may still be extended and resumed."
- Option 3: "No change. The discrepancy with D-63 is accepted and documented."

**Approver.** Owner.

### D10. Coupon concurrency and DEC-12 — DEC-12 DECIDED 2026-11-27 (coupon hardening not authorized)

Analysis: security plan §3. **A prediction, not a reproduced defect.**

**Recommendation.** Decide DEC-12 now so that the harness can run as soon as G7 passes, and run
TC-041 first among the hard cases. Do not change coupon code before the evidence, unless the
real-database run will be delayed for long.

**Decision wording:**

- DEC-12, option 1 (recommended): "DEC-12: real-database execution of the six concurrency
  scenarios is required for G4. I will run it after G7, following `tests/db/README.md`."
- DEC-12, option 2: "DEC-12: real-database execution is deferred beyond G4. The six cases and
  GST-15 are recorded as formally deferred, and the coupon-concurrency prediction is accepted as
  untested." (G4 criterion 2 would then rest on mocked evidence only, and criterion 3 would carry
  one untested S2 candidate.)
- Optional: "Authorize the pre-emptive coupon hardening described in the security plan §3."

**Approver.** Owner.

**Decision recorded (owner, received 2026-11-27): DEC-12 — REAL MYSQL VERIFICATION REQUIRED FOR G4.** Recorded under the decision identifier DEC-12. "D10" is the reply label of this package only.

- **Requirement.** The six prepared scenarios are mandatory for G4: TC-004, TC-030, TC-041, TC-045, TC-048 and TC-051. They must pass against the designated `ecommerce_test` database and produce reviewable evidence before G4 acceptance.
- **Failures.** Failures must be investigated, classified and resolved through separately authorized work.
- **GST-15.** Excluded from DEC-12. It requires a separate owner decision. It is not approved, deferred, implemented or verified by this decision. Option 2 above, which named GST-15, was not chosen.
- **Coupon hardening.** NOT AUTHORIZED. It will be considered separately after the TC-041 evidence has been reviewed. The "Optional" line above is not approved.
- **Database execution.** DEC-12 establishes a G4 evidence requirement only. It grants no new authorization for G2 backup or restore; G3 migrator-user or privilege operations; the G7 scratch-database migration; the G8 migration against `ecommerce_dev`; execution of the six concurrency scenarios; seeds; or database user, grant, schema or data changes. All existing prerequisites and separate explicit authorizations remain mandatory. Only the project owner executes user-only database procedures. The words "I will run it after G7" in option 1 above do not act as an authorization to run.
- **Scope exclusions.** G8, seeds, staging, GST-15 and production database operations are outside this decision.

**Clarifications recorded with the decision (owner, 2026-11-27):**

- **G2.** Existing G2 authorization and status remain unchanged. G2 remains USER EXECUTION IN PROGRESS — NOT ACCEPTED. DEC-12 neither grants a new G2 authorization nor withdraws the existing G2 authorization. G2 remains independent of DEC-12.
- **Batch 12.** The older roadmap reference to a proposed Batch 12 MySQL suite is not addressed by this decision. It is not included in the six scenarios. Its status stays open pending separate owner clarification.
- **Iteration count.** No iteration count is approved by this decision. Neither the harness default of 3 nor the testing-strategy values of 5 and 20 is selected. The iteration count is pending a separate decision before scenario execution.

**Status after this record.** DEC-12: DECIDED — REAL MYSQL VERIFICATION REQUIRED FOR G4. Execution: NOT AUTHORIZED BY THIS DECISION. The six scenarios remain PREPARED — NOT EXECUTED. No scenario has passed. Phase 4 remains IN PROGRESS — NOT APPROVED and G4 is NOT MET.

**Clarification 2026-11-27 (execution prerequisites and traceability).** G7 PASS is a prerequisite before any of the six scenarios is executed. G7 PASS alone does not authorize scenario execution: a separate explicit written authorization from the owner is also required. TC-041 is the real-database evidence scenario for requirement FR-CPN-008 and its acceptance criterion AC-03 (coupon last-redemption concurrency). TC-041 has not been executed. Coupon hardening remains NOT AUTHORIZED until the TC-041 evidence has been reviewed and a separate owner decision is made.

### D11. Security self-assessment draft (G4 criterion 4)

Review package: security plan §4 (17 gaps with severity, remediation and G4 effect; 16 remain open after D1, because PW-08 is resolved).

**Decision wording:**

- Option 1: "I accept the security self-assessment draft of 2026-11-24 as the Phase 4
  self-assessment, with the 16 open gaps recorded as open items." _(Count corrected on 2026-11-24 after D1; it was 17. D11 itself is still open.)_ _(Update 2026-11-24, later: 14 gaps remain open. SH-10 and CS-03 were reassessed from GAP to PREPARED after a `.dockerignore` and a CI coverage step were added. D11 is still open; the count in the wording above would now be 14.)_ _(Clarification 2026-11-27: "14 gaps" is a draft count, not accepted (D11). It includes two reassessments not approved by the owner (SH-10 and CS-03, from GAP to PREPARED); without them the count is 16. This note does not change the option wording or D11.)_
- Option 2: "I return the draft with these changes: …"

**Approver.** Owner.

### D12. Batch 9 and D13. Batch 10 — both RESOLVED 2026-11-24 (accepted, offline mocked scope only)

See Part 3 and Part 4.

### D14. Smaller items

| Item                                                               | Recommendation                                                                                                                                                                                  | Wording                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| DC-05: barcode image documented as JSON in OpenAPI                 | Authorize the one-entry generator change (S4)                                                                                                                                                   | "Authorize the DC-05 OpenAPI correction." / "Leave it."                                                                              |
| FR-PAY-011: permission for refund completion                       | The requirement says `refunds.approve`; the code, API document and runbook use `refunds.update` for `complete` and `retry`. Keep the code and note the requirement, unless you intend otherwise | "Completion and retry use `refunds.update`; update the requirement note." / "They must use `refunds.approve`; authorize the change." |
| DC-04: Superadmin-bypass audit event (TC-008)                      | Accept the existing audit row                                                                                                                                                                   | "The SUPERADMIN-stamped audit row is sufficient." / "A dedicated event is required."                                                 |
| DEC-13c: direct authentication e-mails are not logged (FR-NTF-005) | Log them in the notification log (small) or accept                                                                                                                                              | "Log direct sends." / "Accept them unlogged; record a deferral."                                                                     |
| Refund webhook amount check (ADMIN_WORKFLOWS §11.1)                | Decide with the payment vendor                                                                                                                                                                  | "Required." / "Not required; update the workflow document."                                                                          |
| Failed bank transfer → `FAILED` → retry (ADMIN_WORKFLOWS §11.2)    | No route can record it today                                                                                                                                                                    | "Needed; prepare a proposal." / "Not needed; update the workflow document."                                                          |
| "Duplicate it instead" (D-63)                                      | No duplicate action exists; names are unique                                                                                                                                                    | "Creating a new promotion by hand is acceptable." / "A duplicate action is wanted."                                                  |
| Notifications left in `SENDING` (RK-03, control WK-09)             | Write a manual procedure now; a reclaim rule later                                                                                                                                              | "Prepare a manual procedure for my approval." / "Authorize a reclaim rule with tests."                                               |

### D15. DEC-08 hosting · D16. DEC-10 `.env.example` · D17. DEC-18 Node line

Unchanged and still open. Comparison for DEC-08: `PHASE4-REMAINING-USER-DECISIONS.md` §4.

- DEC-08: "DigitalOcean Bangalore." / "AWS Mumbai." / "Not yet."
- DEC-10: "I give one-time permission to open and edit only the comment block of `.env.example`."
  / "Leave `.env.example` unchanged."
- DEC-18: "Node 22 only." / "Node 22 and 24."

---

## Part 3 — Batch 9 acceptance summary (D12)

**Status: ACCEPTED — OFFLINE MOCKED SCOPE ONLY (owner, 2026-11-24).** _Until then: COMPLETE —
PENDING USER ACCEPTANCE._

**The owner's acceptance (verbatim):**

> Batch 9 (dedicated background worker, D-61): ACCEPTED — OFFLINE MOCKED SCOPE ONLY.
>
> I acknowledge RK-01, RK-02, RK-03, RK-04, RK-05, RK-06, RK-08, RK-09, RK-10 and RK-13 exactly as
> described in the proposed acceptance statement.
>
> I note RK-07 and RK-14 as corrected through Batch 10, RK-11 and RK-12 as deferred items, RK-15 as
> an open business decision, and L-2 and L-3 as open audit low findings.
>
> This acceptance does not approve any deferral, classify M-1, establish multi-server safety,
> establish real MySQL or production readiness, meet G4, or approve Phase 4.

**Risks acknowledged** (the proposed statement A,
`PHASE4-BATCH9-BATCH10-FINAL-ACCEPTANCE-RECONCILIATION.md` §5):

1. RK-01 — Single worker by discipline only; no lock / runtime enforcement.
2. RK-02 — Two workers duplicate every scheduled job.
3. RK-03 — Forced termination can leave notifications in `SENDING`; no auto-recovery, and no
   manual procedure is written.
4. RK-04 — M-1: a gateway refund stays `PROCESSING` after an interruption, in five code paths
   (worker late capture, staff approval, customer self-cancel, API late capture, admin retry); no
   automatic recovery; recovery is undefined if no refund was issued. The manual procedure is
   runbook §9.1.
5. RK-05 — Premature "refund initiated" notifications in staff approval and customer self-cancel.
6. RK-06 — The 60 s forced exit can interrupt a running job and post-commit side effects.
7. RK-08 — No real OS-signal integration test.
8. RK-09 — No real MySQL or two-process concurrency test. The prepared harness has not been
   executed and does not cover two processes.
9. RK-10 — No production or deployment verification.
10. RK-13 — Limited unit coverage of process entry and exit paths: `worker.ts` is not covered and
    `bootstrap.ts` is partly covered.

**Noted, not acknowledged as open risks:**

- RK-07 (the registry wiring now has tests) and RK-14 (the scheduler comment and start log are
  corrected): corrected through Batch 10.
- RK-11 (no worker health endpoint) and RK-12 (no Redis / BullMQ / multi-server scheduling — the
  system is not multi-server safe): deferred items.
- RK-15 (late-capture refunds send no `REFUND_INITIATED`, OQ-59): open business decision.
- L-2 (signal handlers are registered after the start-up database connect) and L-3 (the forced-exit
  timer is `unref()`'d): open audit low findings.

The sections below are the review material as presented before the acceptance. Source:
`PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` §10 and §13. Its recommendation: "ACCEPTABLE
WITH EXPLICIT USER RISK ACKNOWLEDGEMENT". That review does not accept the batch, and neither does
this document.

**The review's sentence:** "Risks requiring your explicit acknowledgement: RK-01 to RK-10 and RK-13
(§10)."

### 3.1 Risk register — wording verbatim from the review

| ID    | Risk (verbatim)                                                                                                    | Severity (review) | Acceptance implication (verbatim)                        | Acknowledgement required                   | Position on 2026-11-24                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RK-01 | Single worker by discipline only; no lock / runtime enforcement                                                    | Medium            | Known limitation; **acknowledge**                        | Yes                                        | Unchanged                                                                                                                                                     |
| RK-02 | Two workers duplicate every scheduled job                                                                          | Medium            | Known limitation; **acknowledge**                        | Yes                                        | Unchanged                                                                                                                                                     |
| RK-03 | Forced termination can leave notifications in `SENDING`; no auto-recovery                                          | Medium            | Known limitation; **acknowledge**                        | Yes                                        | Unchanged. No manual procedure exists (runbook §10)                                                                                                           |
| RK-04 | M-1: refund stays `PROCESSING` after an interruption; no auto-recovery; undefined recovery if no refund was issued | Medium            | Known limitation; **acknowledge** (not a Batch 9 defect) | Yes                                        | The review's evidence says "four flows"; the code has **five** paths. Manual procedure adopted (D-64)                                                         |
| RK-05 | Premature "refund initiated" notifications (flows 2, 3)                                                            | Low–Medium        | Known pre-existing behaviour; **acknowledge**            | Yes                                        | Unchanged                                                                                                                                                     |
| RK-06 | 60 s forced exit can interrupt a running job / post-commit side effects                                            | Medium            | Known limitation; **acknowledge**                        | Yes                                        | Unchanged                                                                                                                                                     |
| RK-07 | M-2: registry → job signal wiring has no test                                                                      | Low               | Known gap; **acknowledge** (bounded impact)              | **No** _(corrected 2026-11-24; was "Yes")_ | No longer true: `registryWiring.test.ts` (5 tests, mutation-checked) covers it. Added by Batch 10 WP10-1; the tests exist whether or not Batch 10 is accepted |
| RK-08 | No real OS-signal integration test                                                                                 | Medium            | Unverified; **acknowledge**                              | Yes                                        | Unchanged                                                                                                                                                     |
| RK-09 | No real MySQL / two-process concurrency test                                                                       | Medium            | Unverified; **acknowledge**                              | Yes                                        | A harness is prepared; nothing was executed. Two-process tests are not covered by it                                                                          |
| RK-10 | No production / deployment verification                                                                            | Medium            | Unverified; **acknowledge**                              | Yes                                        | Unchanged                                                                                                                                                     |
| RK-11 | No worker HTTP health endpoint                                                                                     | Low               | Deferred item                                            | No (deferred item)                         | Unchanged                                                                                                                                                     |
| RK-12 | Redis / BullMQ / multi-server scheduling                                                                           | —                 | Deferred item; **not multi-server safe**                 | No (deferred item)                         | Unchanged                                                                                                                                                     |
| RK-13 | Low unit coverage of `worker.ts` / `bootstrap.ts` exit paths (L-5)                                                 | Low               | Known gap; **acknowledge**                               | Yes                                        | Partly improved _(corrected 2026-11-24; was "Unchanged")_: `bootstrap.ts` 35 % → 61.5 % of statements after the D1 tests; `worker.ts` still not covered       |
| RK-14 | Stale scheduler code comment / start-log wording (R-16 / L-4)                                                      | Low               | Not a blocker                                            | No                                         | Corrected in the scheduler fix (Batch 10)                                                                                                                     |
| RK-15 | Late-capture refunds send no `REFUND_INITIATED` (design says they should, OQ-59)                                   | Low               | Open business decision                                   | No (business decision)                     | Unchanged; OQ-59 open                                                                                                                                         |

The review states: "Acceptance blockers within Batch 9's authorized scope: none identified."

Earlier summaries called this "nine risks". The review requires eleven acknowledgements.

_Update 2026-11-24 (acceptance reconciliation): ten risks still need acknowledgement — RK-01 … RK-06, RK-08, RK-09, RK-10 and RK-13. RK-07 is corrected. Full risk-by-risk record: `PHASE4-BATCH9-BATCH10-FINAL-ACCEPTANCE-RECONCILIATION.md` §2._

### 3.2 What acceptance would and would not cover

It would cover the dedicated-worker implementation as verified with mocked tests. It would not
cover MySQL behaviour, real operating-system signals, two worker processes, real providers,
deployment or multi-server operation.

### 3.3 Wording

- Accept: use **statement A** in `PHASE4-BATCH9-BATCH10-FINAL-ACCEPTANCE-RECONCILIATION.md` §5. It
  lists the ten risks to acknowledge with their current wording, and notes RK-07, RK-14, RK-11,
  RK-12, RK-15 and the audit findings L-2 and L-3.
- _Superseded wording (2026-11-24, earlier the same day; kept for the record — it asked for an
  acknowledgement of RK-07, which is now corrected):_ "Batch 9: I acknowledge RK-01, RK-02, RK-03,
  RK-04, RK-05, RK-06, RK-07, RK-08, RK-09, RK-10 and RK-13 as worded in
  `PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` §10, and I note the deferred items RK-11 and
  RK-12 and the open decision RK-15. I accept Batch 9 as ACCEPTED — OFFLINE MOCKED SCOPE ONLY."
- Reject: "Batch 9 is not accepted. Required before acceptance: …"
- Hold: "Batch 9 stays pending until real-database evidence exists."

---

## Part 4 — Batch 10 acceptance summary (D13)

**Status: ACCEPTED — OFFLINE MOCKED SCOPE ONLY (owner, 2026-11-24).** _Until then: IMPLEMENTED AND
VERIFIED WITH MOCKED TESTS — PENDING USER ACCEPTANCE._

**The owner's acceptance (verbatim):**

> Batch 10 (WP10-1 to WP10-6 and the scheduler fix, D-65): ACCEPTED — OFFLINE MOCKED SCOPE ONLY.
>
> I acknowledge all six limitations described in the proposed Batch 10 acceptance statement,
> including the mocked evidence, notification/error-reporting limitations, refund reconciliation
> limitations, OpenAPI barcode content-type discrepancy, and settings-seed dependency.
>
> This acceptance does not establish real MySQL concurrency, real-provider integration, CI,
> deployment or production readiness. It does not approve any deferral, meet G4, or approve
> Phase 4.

**Limitations acknowledged** (the proposed statement B,
`PHASE4-BATCH9-BATCH10-FINAL-ACCEPTANCE-RECONCILIATION.md` §5):

1. All evidence is mocked: mocked database, mock payment gateway. The cart and reconciliation
   tests are not evidence of MySQL locking, isolation or concurrency.
2. WP10-1 proves the registry wiring with mocked job modules, not the behaviour of the jobs.
3. WP10-2: per-product errors in the two catalogue jobs are logged and counted; the run still ends
   as a normal run and nothing alerts.
4. WP10-3: a failed late-capture refund is not counted in the job summary, and a failure while
   recording a refund result leaves the refund `PROCESSING`.
5. WP10-4: the variant barcode image is still documented as JSON in the OpenAPI specification
   (DC-05).
6. WP10-5: the best-seller window is 90 days until the settings seed runs, and a database error
   while reading the setting fails the run.

The material below is as presented before the acceptance. Scope decided as
D-65: WP10-1 … WP10-6 and the scheduler fix. Proposal:
`PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md` §3.

| Work package                             | Change                                                                         | Verified evidence (2026-11-24)                                                                                                                              | Limitation / remaining risk                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| WP10-1 Registry wiring tests             | Tests only: `tests/unit/jobs/registryWiring.test.ts` (5 tests)                 | Cursor carry-over and stop signal reach the three long jobs. Mutation check: removing the wiring makes a test fail                                          | Job modules are mocked; proves wiring, not job behaviour                                                                             |
| WP10-2 Per-item error isolation          | Source: `src/jobs/catalogAggregates.ts`                                        | One product fails, the next succeeds, summary `{ products: 2, updated: 1, errors: 1 }`; a failure outside the loop still fails the run                      | Errors are logged and counted, but a run with errors still ends as a normal run; nothing alerts                                      |
| WP10-3 Reconciliation late-capture tests | Tests only: `paymentReconciliation.test.ts` (26 tests, 12 added on 2026-11-24) | Both late-capture paths; refund after commit and outside any transaction; ledger rows; provider failure; retry; duplicate prevention                        | Mock gateway. A failed refund is not counted in the job summary. If recording the refund result fails, the refund stays `PROCESSING` |
| WP10-4 OpenAPI download content types    | Generator and regenerated specification                                        | Five download operations match what the routes send; `openapi:check` passes; 8 contract tests                                                               | One more operation (variant barcode image) is still documented as JSON (DC-05)                                                       |
| WP10-5 Configurable best-seller window   | Source: `loadBestSellerWindowDays`                                             | Valid value, bounds 1 and 730, missing row, invalid and malformed values                                                                                    | The settings seed has not run, so 90 days is the effective value. A database error while reading the setting fails the run           |
| WP10-6 Cart test gaps                    | Tests only                                                                     | Re-resolution creating a fresh cart; retry race; exact 30-day and 90-day boundaries                                                                         | Mocked transactions; real locking is unverified                                                                                      |
| Scheduler fix (IMP-09)                   | Source: `src/jobs/scheduler.ts`                                                | A synchronous throw from a job is logged and the schedule continues. Mutation check: removing the wrapper makes the test fail. Log wording now matches D-61 | None found                                                                                                                           |

**Test results:** jobs and worker tests 7 files, 85 passed; cart tests 4 files, 50 passed; contract
tests 8 passed; all inside the full run of 119 files, 3,110 passed, 0 failed. No defect was found.
No database, API-behaviour, dependency or schema change.

**What acceptance would not cover:** MySQL behaviour, real providers, deployment.

**Wording:**

- Accept: use **statement B** in `PHASE4-BATCH9-BATCH10-FINAL-ACCEPTANCE-RECONCILIATION.md` §5. It
  lists the six limitations explicitly. Exact test files and counts are in §3 of that document
  (seven test files, 92 tests, all pass).
- _Earlier short wording, kept for the record:_ "Batch 10 (WP10-1 to WP10-6 and the scheduler fix): I accept it as ACCEPTED — OFFLINE
  MOCKED SCOPE ONLY, with the limitations listed in the decision package Part 4."
- Reject: "Batch 10 is not accepted. Required before acceptance: …"
