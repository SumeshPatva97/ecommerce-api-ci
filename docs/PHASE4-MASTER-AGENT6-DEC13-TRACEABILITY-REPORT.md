# Phase 4 — DEC-13 Traceability Report (Agent 6)

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Document ID | `P4-MASTER-AGENT6`                                                                                                                         |
| Date        | 2026-11-24                                                                                                                                 |
| Nature      | **Read-only** documentation and evidence preparation. No source, test or existing document was changed                                     |
| Scope       | DEC-13: the four small items implemented on 2026-11-21 (Part A), the three requirements still open (Part B), proposed matrix text (Part C) |
| Evidence    | Static reading only. No test, build, database, network or Git command was run. All tests cited use a mocked database                       |
| Authority   | This report approves nothing, defers nothing and decides nothing. Every "decision needed" below is for the owner                           |

Paths are relative to `ecommerce-api/` unless they start with `project-documentation/`. Line numbers
are as read on 2026-11-24 and may shift (other agents were editing tests at the same time).

## Summary

| ID         | Status                 | One-line reason                                                                                                          |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| FR-AD-008  | PARTIAL                | Both settings are read on their main paths, but two verified code paths still ignore them                                |
| FR-ORD-006 | COMPLETE               | SKU search is implemented and tested (mocked). One interpretation point on "export" is left for the owner                |
| FR-INV-006 | COMPLETE               | `actorId` filter is implemented and tested (mocked)                                                                      |
| FR-SF-004  | COMPLETE               | Public list hides collections without an active product; tested (mocked). One residual definition point noted            |
| FR-PRM-004 | USER DECISION REQUIRED | Listing and detail still return the base price and no promotion. Not implemented                                         |
| FR-PL-013  | USER DECISION REQUIRED | Search still does not match brand, category or attribute values. Not implemented                                         |
| FR-TAX-013 | USER DECISION REQUIRED | Invoice PDF has per-line HSN only. A tax professional must confirm what is required before any decision. Not implemented |

Exactly four items were implemented on 2026-11-21: FR-AD-008, FR-ORD-006, FR-INV-006 and FR-SF-004.

---

## Part A — the four implemented items

### A.1 FR-AD-008 — status: PARTIAL

**Requirement** (`PROJECT_REQUIREMENTS.md` line 609, priority M, source `[CONFIRMED]`, no acceptance
note):

> System settings: store profile, GSTIN/state, checkout rules, reservation TTL, low-stock default,
> notification toggles; changes audited.

**What is implemented and tested**

| Part                                | Code                                                                                                                                                                                                                                      | Test                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings stored, validated, audited | `src/modules/settings/` (`settings.values.ts` `KNOWN_SETTING_RULES`: TTL int 5–120, new-arrival days int 1–365)                                                                                                                           | `tests/integration/modules/settings/settings.test.ts` — `it('PATCH validates, updates with optimistic concurrency, audits SETTINGS_CHANGE and busts the public cache')`                                                                                                                         |
| `checkout.reservation_ttl_minutes`  | `src/modules/checkout/checkout.repository.ts` `reservationTtlMinutes(db, fallback)` (lines 147–159); used in `checkout.service.ts` `writeOrder` (lines 262–269). Missing or invalid value falls back to env `RESERVATION_TTL_MINUTES`     | `tests/integration/modules/checkout/checkout.routes.test.ts` — `it('FR-AD-008: honours checkout.reservation_ttl_minutes for the reservation TTL')` and `it('FR-AD-008: falls back to the configured TTL when the setting is missing or invalid')`                                               |
| `catalog.new_arrival_days`          | `src/modules/catalog/catalog.repository.ts` `loadNewArrivalDays(db)`; used in `catalog.service.ts` `resolve` → `buildWhere` (`isNewArrival=true` filter), `list` and `related` (badge via `catalog.mapper.ts` `mapCard` / `isNewArrival`) | `tests/integration/modules/catalog/newArrivalDays.test.ts` — `it('honours a configured window for the NEW_ARRIVAL badge and the isNewArrival filter')`, `it('a shorter configured window drops the badge from older products')`, `it.each(...)('falls back to 30 days when the setting is %s')` |

**Verified leftovers**

1. **Retry payment still uses the env TTL — confirmed.**
   `src/modules/payments/payments.service.ts` `retryPayment` (lines 436–444) calls
   `deps.inventory.reservationExpiry(now)`. That function
   (`src/modules/inventory/inventory.stock.ts` line 471) adds `deps.reservationTtlMinutes`, which
   `captureDepsFor` (lines 85–88) wires from `container.config.integrations.reservationTtlMinutes`
   (env `RESERVATION_TTL_MINUTES`, default 15). The setting is never looked up on this path.
   The value is written to the new reservations, to `payments.expires_at` and to
   `orders.reservation_expires_at`.
   Effect: with the setting at 30 minutes, the first attempt holds stock for 30 minutes and every
   retry holds it for the env value. The existing retry test
   (`tests/integration/modules/payments/payments.routes.test.ts` —
   `it('re-reserves stock with a fresh TTL and opens a new gateway session (attempt 2)')`) primes no
   setting.
2. **Recently viewed still uses the 30-day default — confirmed, customer-visible.**
   `src/modules/me-addresses/recently-viewed.service.ts` `list` (line 39) calls
   `mapCard(r.product, delivery, now)` without the `newArrivalDays` argument, so the default
   `DEFAULT_NEW_ARRIVAL_DAYS = 30` applies. The response spreads the whole card, including `badges`.
   Effect: the same product can carry `NEW_ARRIVAL` on `GET /products` and not on
   `GET /me/recently-viewed` (or the reverse). No test covers badges on this endpoint.
3. **Wishlist uses the 30-day default — confirmed in code, but with no visible effect.**
   `src/modules/wishlist/wishlist.mapper.ts` `toWishlistItemDto` (line 12) also calls `mapCard`
   without `newArrivalDays`. However, the wishlist DTO returns only `slug`, `name`, `primaryImage`,
   `price.min/max` and `availability`; `badges` is discarded. This is an internal inconsistency
   only. It becomes visible only if badges are ever added to the wishlist response.

**Conclusion.** The draft matrix classed FR-AD-008 as PARTIAL because two settings were stored but
not read. Measured the same way, FR-AD-008 is still **partially met**: both settings now take effect
on their main paths, and do not take effect on retry payment (TTL) and recently viewed (badge). If
the owner reads the requirement as "settings can be stored, validated and audited" only, that part
is implemented and tested.

**Other observations (outside the two settings DEC-13 named; not fully traced).**

- The requirement also names "low-stock default". `inventory.low_stock_threshold_default` is read by
  `inventory.stock.ts` `loadLowStockDefault`, but the public catalogue
  (`catalog.mapper.ts` `variantAvailability`) and `cart.rules.ts` use a constant of 5.
- `checkout.max_qty_per_line` is read by `cart.service.ts`, but the catalogue's `maxPurchasable`
  uses the constant `MAX_QTY_PER_LINE = 5` (`products.rules.ts`).

Estimated size to close leftovers 1 and 2: S.

### A.2 FR-ORD-006 — status: COMPLETE (mocked evidence), one interpretation point

**Requirement** (line 412, priority M, source `[CONFIRMED] order mgmt`, no acceptance note):

> Admin order list with server pagination, filters (status, payment status, date range IST, payment
> method, search by order number/email/phone/SKU), export.

**SKU search**

- Code: `src/modules/orders/orders.service.ts` `listAdmin` (lines 419–430). `q` now also matches
  `{ items: { some: { sku: { contains: q } } } }` (the `order_items.sku` snapshot), next to order
  number, e-mail, phone and AWB. Schema: `orders.schemas.ts` `AdminOrdersQuery` (`q` 1–100 chars).
- Test: `tests/integration/modules/orders/orders.branches.test.ts` —
  `it('FR-ORD-006: q also matches the order-item SKU snapshot')`. Existing:
  `it('combines every filter into one AND list')`.

**Export**

- There is no export route on `/admin/orders` (`orders.routes.ts` route table). Export is done
  through the report endpoint `POST /admin/reports/orders/export`
  (`src/modules/reports/reports.sales.ts` `runOrders`).
- Test: `tests/integration/modules/reports/reports.test.ts` —
  `it('streams a sync CSV with download headers, injection guard and an EXPORT audit (no re-auth)')`.
- The report has a different filter set: a date range is required; `status`, `paymentStatus`,
  `paymentMethod`, `couponId`; and `q` matches only an **exact** order number or an **exact**
  e-mail. It does not search by phone, AWB or SKU.

**Remaining gaps / notes**

- Interpretation for the owner: if "export" means "an orders export exists", the requirement is met.
  If it means "export the list exactly as filtered on screen, including the SKU search", it is not.
- The test checks the shape of the database query only. Real matching (case sensitivity depends on
  the MySQL collation) is not verified.
- `contains` on `order_items.sku` cannot use an index. Performance on large data is not verified.
- `project-documentation/04-backend/API_DOCUMENTATION.md` line 1235 still lists `q` as "order
  number, customer email/phone, AWB" (SKU not mentioned).

### A.3 FR-INV-006 — status: COMPLETE (mocked evidence)

**Requirement** (line 385, priority M, source `[CONFIRMED]`):

> Inventory history view per variant with filters (type, date range, actor).

Acceptance note: `GET /admin/inventory/:variantId/transactions`.

- Code: `src/modules/inventory/inventory.schemas.ts` `TransactionsQuery` (`actorId: uuid.optional()`,
  line 110); `src/modules/inventory/inventory.service.ts` `transactions` (line 439,
  `createdById: query.actorId`).
- Test: `tests/integration/modules/inventory/inventory.routes.test.ts` —
  `it('FR-INV-006: filters history by actor (actorId → created_by_id) alongside type/date')`. It
  checks the filter, that the count uses the same filter, that the filter is absent without
  `actorId`, and that a malformed id returns 422.

**Remaining gaps / notes**

- Rows created by the system (`created_by_id` is null, shown as `"SYSTEM"`) cannot be selected with
  this filter. The requirement does not ask for it.
- `API_DOCUMENTATION.md` line 1205 does not list `actorId`. Agent 4's report states the OpenAPI
  document does; I did not re-verify that.

### A.4 FR-SF-004 — status: COMPLETE (mocked evidence), one residual definition point

**Requirement** (line 239, priority M, source `[CONFIRMED]`):

> Featured collections section listing collections flagged featured.

Acceptance note: "Only `ACTIVE` collections with ≥ 1 active product shown."

- Code: `src/modules/collections/collections.repository.ts` `listPublic` (lines 115–130) adds
  `products: { some: { product: { status: 'ACTIVE', deletedAt: null } } }`.
  `collections.service.ts` `listPublic` (lines 282–288) also drops rows whose active-member count
  is 0. The rule applies to the whole public list, with or without `?featured=true`.
- Test: `tests/integration/modules/catalog/collections.test.ts` —
  `it('FR-SF-004: the public list hides collections with no active product; admin list does not')`.

**Detail endpoint.** `GET /collections/:slug` (`findPublicBySlug`, `getPublic`) is unchanged: an
empty collection still returns 200 with `productCount: 0`. The requirement and its acceptance note
describe the featured collections **section** (a listing). They do not mention the detail page. So
the wording does not cover the detail endpoint, and leaving it unchanged does not contradict the
requirement. Whether an empty collection should stay reachable by direct link is not stated
anywhere I read.

**Remaining gaps / notes**

- "Active product" in the code means product status `ACTIVE` and not deleted. The storefront
  visibility rule (`catalog.repository.ts` `visibleWhere`) also requires `publishedAt ≤ now` and at
  least one ACTIVE variant. A collection whose only members are ACTIVE but not yet published, or
  have no active variant, is therefore listed while `GET /products?collection=<slug>` returns
  nothing. The same definition was already used for `productCount`. Estimated size to align: S.
- `API_DOCUMENTATION.md` line 342 does not state the "≥ 1 active product" rule.

---

## Part B — three requirements still open (not implemented, not to be implemented without a decision)

Status of all three: **USER DECISION REQUIRED**.

### B.1 FR-PRM-004 — promotional price and badge on listing (PLP) and detail (PDP)

**Requirement** (line 477, priority M, source **`[PROPOSED]`**, no acceptance note):

> Promoted price shown on PLP/PDP with original price struck through; never below ₹1 [PROPOSED].

Note: the source column of this row is `[PROPOSED]`, not `[CONFIRMED]`, and the ₹1 floor carries its
own `[PROPOSED]` marker.

**Current behaviour (code evidence)**

- Listing card: `src/modules/catalog/catalog.mapper.ts` `mapCard` builds `price.min/max` from the
  variant `sellingPrice` and returns `promotionLabel: null` (line 129).
- Detail: `src/modules/catalog/catalog.service.ts` `mapDetail` returns
  `effectivePrice: toMoneyString(v.sellingPrice)` and `promotion: null` (lines 598–600).
  The `promotion: null` literal is in `catalog.service.ts`, not in `catalog.mapper.ts`.
- Price filter, price sort and price facets use the base price: `buildWhere` (`sellingPrice`),
  `orderFor` (`minSellingPrice` / `maxSellingPrice` columns), `facets` (`minPrice(row)`).
- Cart and checkout do apply promotions: `cart.service.ts` (lines 240–255) and `checkout.quote.ts`
  (lines 280–293) call `createPricingInputLoader().load(...)` then `priceCart(...)`
  (`src/lib/pricing/engine.ts`). The best single promotion per line is chosen by
  `selectBestPromotion`.
- Price floor: `promotionUnitDiscount` keeps the promoted price at or above **₹0.01**
  (`ONE_PAISA`). The test `tests/unit/lib/pricing/engine.test.ts` —
  `it('computes unit discounts with caps and floors')` asserts ₹0.01. The requirement says ₹1.
- The file header of `catalog.mapper.ts` still says "no promotion engine exists yet". That comment
  is out of date.

**Gap.** A customer sees the base price on listing and detail and a lower price in the cart. No
promotion label is shown. `API_DOCUMENTATION.md` already describes the target contract: §2.4
(line 118) says `minPrice`/`maxPrice` compare the effective price after promotion; §3.3 (line 398)
says `price.min/max` are effective prices; the examples show `promotionLabel`, `effectivePrice` and
`promotion { id, label }`. The code does not match these lines.

**Technical recommendation**

- **Reuse the engine; do not write a second price rule.** Add one catalogue helper (for example in
  `src/modules/promotions/`) that, for the product ids of one page, calls the existing
  `loadProductContexts` and `loadActivePromotions` once, then calls `selectBestPromotion` per
  variant with `quantity: 1`. `priceCart` calls the same function, so the listing price equals the
  cart unit price before coupon by construction.
- **Files / functions:** `catalog.service.ts` `list`, `related`, `detail` / `mapDetail`,
  `autocomplete`; `catalog.mapper.ts` `mapCard` (effective `price.min/max`, `promotionLabel`,
  `discountPercentMax`, `matchedVariants.unitPrice`); `wishlist.mapper.ts` and
  `recently-viewed.service.ts` (both reuse `mapCard`, so they must receive the same input or the
  same product shows two prices). Label source: the promotion `name`, as `cart.mapper.ts` does.
- **Data needed:** none new. Promotions, targets, category paths, brands and collections are
  already loaded by `pricing.loader.ts`.
- **DB / schema impact:** none for display. Filtering and sorting by effective price is different:
  `products.min_selling_price` is the base price. Doing that correctly needs either a maintained
  effective-price column (schema change plus a job) or in-memory filtering (breaks pagination).
  Recommendation: decide this separately.
- **API contract impact:** no new fields. `effectivePrice`, `promotion` and `price.promotionLabel`
  already exist in the response and in the API document; only their values change.
- **Performance:** the helper adds a fixed number of queries per page (one for product context, up
  to five for category parents, one for promotions). It must not query per product (no N+1).
  Matching is in memory.
- **Caching:** the catalogue modules I read set no cache headers. If a cache is added later,
  FR-PRM-003 requires promotion start and end to take effect within 1 minute.
- **Consistency and security risks:**
  - a promotion can end between page view and add-to-cart; the cart then shows a higher price;
  - the open DEC-06-impl discrepancy (an expired promotion can be revived by an edit) would also
    appear on listings;
  - only `id` and label may be exposed, never priority or targets; DRAFT, PAUSED, EXPIRED and
    deleted promotions must never show (`isPromotionEffective` already enforces this);
  - changing the floor from ₹0.01 to ₹1 changes cart and checkout totals, so it needs its own
    explicit approval.
- **Tests required:** mapper unit tests (effective min/max, label, discount percent against MRP);
  a parity test that the detail `effectivePrice` equals the `priceCart` result for the same
  fixture; integration tests (mocked) for PRODUCT, CATEGORY with descendants, BRAND and COLLECTION
  promotions, best-of-two selection, and no promotion for DRAFT / PAUSED / EXPIRED / deleted; a
  query-count assertion; a floor test if ₹1 is adopted; later a real-database check.

**Proposed acceptance criteria**

1. For a variant with an effective promotion, `GET /products/:slug` returns `effectivePrice` equal
   to selling price minus the unit discount from `selectBestPromotion`, and
   `promotion: { id, label }`. `sellingPrice` and `mrp` are unchanged so the UI can strike through.
2. `GET /products` returns `price.min/max` computed from effective prices and a non-null
   `promotionLabel` when at least one variant is promoted.
3. Without an effective promotion the responses are identical to today.
4. For the same variant at the same instant, the detail `effectivePrice` equals the cart line's
   unit price after promotion.
5. DRAFT, PAUSED, EXPIRED, deleted and out-of-window promotions never change a catalogue price.
6. One listing request issues a fixed number of promotion queries, independent of page size.
7. The effective price is never below the approved floor (₹1 if the owner confirms the `[PROPOSED]`
   value; today the engine floor is ₹0.01).
8. Every endpoint that returns a listing card shows the same price for the same product.

**Estimated size:** M (display on listing, detail, related, autocomplete, wishlist, recently
viewed). L if price filter, sort and facets must also use the effective price.

**Decision needed from the owner:** implement now or formally defer; whether the ₹1 floor is
confirmed and whether it also applies to cart and checkout; whether price filter / sort / facets
are in scope; the label wording.

### B.2 FR-PL-013 — search by brand, category and attribute values

**Requirement** (line 323, priority M, source `[CONFIRMED]`):

> Product search over name, SKU (exact), brand, category, attribute values; minimum 2 characters.

Acceptance note: "Search "jhumka" matches "Oxidised Jhumkas"."

**Current behaviour (code evidence)**

- `src/modules/catalog/catalog.service.ts` `buildWhere` (lines 163–173): `q` matches product
  `name`, `searchKeywords`, `shortDescription` (all `contains`) and an ACTIVE variant SKU
  (`startsWith` the normalised code).
- `autocomplete` (lines 448–494): products by name, keywords and SKU prefix. Categories and brands
  are matched by name only as separate suggestion lists; they are not used to find products.
- Minimum length 2 is enforced (`catalog.schemas.ts` lines 100, 123, 142).
- `relevance` sort is by pin and units sold; there is no text ranking.
- Tests: `tests/integration/modules/products/catalog.test.ts` —
  `it('ranks exact SKU matches first and validates q length')` (autocomplete only). I found no test
  that asserts the search clause of `GET /products?q=`.

**Gap.** Searching for a brand name, a category name or an attribute value (for example a material
or gemstone) finds a product only if the same word is also in its name, keywords or short
description. The acceptance example is satisfied by the name match (case behaviour depends on the
MySQL collation and is not verified).

**Technical recommendation**

- **Files / functions:** extend the `OR` list in `buildWhere` with: brand name `contains` (brand
  active and not deleted); category name `contains` (category active and not deleted);
  product-level attribute value `contains`; ACTIVE-variant attribute value `contains`. Apply the
  same list to `autocomplete` so both searches agree. Facets use `buildWhere`, so their counts
  follow automatically.
- **Data needed:** none new (`brands.name`, `categories.name`, `attribute_values.value`).
- **DB / schema impact:** none for correctness. `contains` across joined tables cannot use an
  index. This is acceptable for a small catalogue (the code already assumes one: `FACET_ROW_CAP`).
  A full-text index or a denormalised search column would be a schema change, which is not
  approved.
- **API contract impact:** no parameter or shape change. Result sets become larger.
- **Risks:**
  - looser matching with no ranking can push weak matches up;
  - inactive or deleted brands, categories and attribute values must not match;
  - attributes that are not filterable and not shown on the detail page should not be searchable,
    so internal values cannot be probed;
  - the public endpoint gets a heavier query (rate-limit classes already exist);
  - how `%` and `_` in `q` are treated should be confirmed by a test.
- **Tests required:** integration tests (mocked) asserting each new branch, visibility of results,
  the 2-character minimum, and exclusion of inactive / deleted masters; an autocomplete parity
  test; later a real-database test for case-insensitive matching.

**Proposed acceptance criteria**

1. `GET /products?q=<text>` returns a visible product when `<text>` (2–100 characters) is contained
   in its name, its active brand's name, its active category's name, or the value of an active
   attribute value linked to the product or to one of its ACTIVE variants; or equals / prefixes an
   ACTIVE variant SKU.
2. Inactive or deleted brands, categories and attribute values never produce a match.
3. `q` shorter than 2 characters returns 422 (unchanged).
4. `GET /search/autocomplete` finds products by the same fields.
5. "jhumka" matches "Oxidised Jhumkas" (unchanged).
6. Facet counts for a search use the same match rule.

**Estimated size:** M (S for the bare extension with tests; L with full-text search or a
denormalised index, which needs a schema change).

**Decision needed from the owner:** implement (which variant) or formally defer; whether prefix SKU
matching is acceptable where the requirement says "exact"; whether a category match should include
parent categories; whether multi-word queries must match word by word.

### B.3 FR-TAX-013 — HSN-wise tax summary on the invoice PDF

**Requirement** (line 553, priority M, source `[CONFIRMED]`, no acceptance note):

> Invoice tax breakdown per line and per component, HSN summary.

**A tax professional must confirm the compliance requirement (together with RD-01) before a final
decision. This report does not state what the law requires.**

**Current behaviour (code evidence)**

- `src/modules/invoices/invoices.pdf.ts` `renderInvoicePdf` prints one table row per ledger group
  with columns `#`, `Description`, `HSN`, `Qty`, `Rate %`, `Taxable`, one amount column per tax
  component present, and `Total` (lines 426–491). Below the table it prints one totals line
  (taxable total, component totals, round off), the grand total and the amount in words
  (lines 493–514). There is no block grouped by HSN and no block grouped by rate.
- `loadInvoiceDocument` builds the lines from `tax_transactions` through
  `invoices.ledger.ts` `groupsFromRows`. Shipping rows carry the HSN of the related item, or, in
  the fallback, the first item's HSN or the placeholder `'0000'` (`residualShipping`).
- Test: `tests/unit/modules/invoices/invoices.test.ts` —
  `it('renders a PDF whose metadata carries the document number')`. It checks the `%PDF-` header
  and the invoice number only. No test asserts the printed content.
- A period-level HSN summary exists as the report `gst-hsn`
  (`src/modules/reports/reports.gst.ts` `runGstHsn`). It is exercised only by
  `it('runs every one of the 20 report keys (empty data) for a Superadmin')` and permission tests.

**Facts the owner and the tax professional should see**

- `project-documentation/06-workflows/TAX_AND_GST_WORKFLOWS.md` §16.3 (fields "to be verified with
  CA") lists "HSN code per line" and has no HSN-summary item. The §16.4 layout shows a "Tax summary
  by rate" line, not an HSN summary. The PDF has neither summary.
- The requirement text does not say whether "HSN summary" means a block on each invoice or the
  periodic report.
- UQC is not in the approved schema (`hsn_codes` has no `uqc` column; noted in the header of
  `invoices.pdf.ts` and in `reports.gst.ts`).
- RD-01 (`docs/PHASE4-REMAINING-DECISIONS.md`) covers only the CGST/SGST odd-paisa question. It
  contains no HSN-summary question yet.

**Gap.** No HSN-wise summary on the invoice or credit-note PDF, and no test of PDF content.

**Technical recommendation (only if the tax professional and the owner ask for it)**

- **Files / functions:** add a pure function (for example in `invoices.ledger.ts`) that groups the
  document's groups by HSN and rate and returns taxable value, each component amount and total tax;
  render it as a small table in `renderInvoicePdf` after the line table, for invoices and credit
  notes.
- **Data needed:** already present on `tax_transactions` (`hsn_code`, `rate`, `taxable_value`,
  component amounts).
- **DB / schema impact:** none, unless the summary must show UQC; that needs a new column, which
  is a schema change and is not approved.
- **API contract impact:** none (same endpoints; only the PDF content changes).
- **Risks:**
  - the summary must add up exactly to the invoice totals, so it must sum stored rows and never
    recompute tax;
  - how shipping and COD-fee rows are assigned to an HSN, and the `'0000'` placeholder, need the
    tax professional's view;
  - PDFs are rendered on demand, so a re-download of an already issued invoice would show the new
    block (the stored data does not change);
  - page overflow on long invoices.
- **Tests required:** unit tests for the grouping function (several HSNs, two rates under one HSN,
  intra-state and inter-state, shipping rows, credit note; totals equal the document totals); a PDF
  content test (PDFKit compresses page content, so the test needs uncompressed output or must
  assert the pure function plus a render smoke test).

**Proposed acceptance criteria (subject to the tax professional's answer)**

1. The tax invoice PDF contains an "HSN summary" table with one row per HSN and rate, showing
   taxable value, each tax component present and total tax.
2. The sum of the summary rows equals the invoice taxable total and each component total exactly.
3. Credit-note PDFs show the same summary for the credited amounts.
4. The treatment of shipping and COD-fee rows follows the tax professional's written answer.
5. A test asserts the summary values for a multi-HSN fixture.
6. No stored invoice number, amount or ledger row changes.

**Estimated size:** S (M if UQC, a schema change or a layout redesign is required).

**Decision needed from the owner:** first obtain the tax professional's written answer (add the
question to the RD-01 list). Then choose: implement on the PDF; accept the `gst-hsn` report as the
"HSN summary" and re-word the requirement; or formally defer.

---

## Part C — proposed text for the orchestrator

### C.1 Ready-to-paste matrix update rows (dated 2026-11-24)

Status letters follow the matrix legend (`T` implemented + tested (mocked), `P` partial).

| ID         | New status (2026-11-24)    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                               | Note                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-AD-008  | P (PARTIAL)                | `checkout.repository.ts` `reservationTtlMinutes` + `checkout.service.ts` `writeOrder`; `catalog.repository.ts` `loadNewArrivalDays` + `catalog.service.ts` `list` / `related` / `buildWhere`. Tests: `checkout.routes.test.ts` "FR-AD-008: honours checkout.reservation_ttl_minutes for the reservation TTL", "FR-AD-008: falls back to the configured TTL when the setting is missing or invalid"; `newArrivalDays.test.ts` (3 tests) | Implemented 2026-11-21 on the main paths. Still open: `payments.service.ts` `retryPayment` uses the env TTL; `recently-viewed.service.ts` `list` uses the 30-day default for the `NEW_ARRIVAL` badge. `wishlist.mapper.ts` also uses the default but returns no badges (no visible effect) |
| FR-ORD-006 | T (COMPLETE, mocked)       | `orders.service.ts` `listAdmin` (`items.some.sku contains q`). Test: `orders.branches.test.ts` "FR-ORD-006: q also matches the order-item SKU snapshot". Export: `POST /admin/reports/orders/export` (`reports.sales.ts` `runOrders`), `reports.test.ts` "streams a sync CSV with download headers, injection guard and an EXPORT audit (no re-auth)"                                                                                  | Implemented 2026-11-21. Export is the `orders` report with its own filters (no SKU / phone / AWB search): owner to confirm this satisfies "export". API document line 1235 not yet updated                                                                                                 |
| FR-INV-006 | T (COMPLETE, mocked)       | `inventory.schemas.ts` `TransactionsQuery.actorId`; `inventory.service.ts` `transactions`. Test: `inventory.routes.test.ts` "FR-INV-006: filters history by actor (actorId → created_by_id) alongside type/date"                                                                                                                                                                                                                       | Implemented 2026-11-21. System rows (no actor) cannot be selected by this filter. API document line 1205 not yet updated                                                                                                                                                                   |
| FR-SF-004  | T (COMPLETE, mocked)       | `collections.repository.ts` `listPublic` (`products.some` active member) + `collections.service.ts` `listPublic` count guard. Test: `collections.test.ts` "FR-SF-004: the public list hides collections with no active product; admin list does not"                                                                                                                                                                                   | Implemented 2026-11-21. `GET /collections/:slug` unchanged (not covered by the requirement wording). "Active product" = status ACTIVE and not deleted; it does not require published or an active variant                                                                                  |
| FR-PRM-004 | P — USER DECISION REQUIRED | `catalog.mapper.ts` `mapCard` (`promotionLabel: null`); `catalog.service.ts` `mapDetail` (`effectivePrice` = selling price, `promotion: null`). Engine floor is ₹0.01: `engine.test.ts` "computes unit discounts with caps and floors"                                                                                                                                                                                                 | Not implemented. Requirement source is `[PROPOSED]`; ₹1 floor `[PROPOSED]` and not met. Recommendation and acceptance criteria: `P4-MASTER-AGENT6` §B.1. Size M (L with effective-price filter / sort)                                                                                     |
| FR-PL-013  | P — USER DECISION REQUIRED | `catalog.service.ts` `buildWhere` / `autocomplete` (name, keywords, short description, SKU prefix). Test: `catalog.test.ts` "ranks exact SKU matches first and validates q length" (autocomplete only)                                                                                                                                                                                                                                 | Not implemented. No test found for the `GET /products?q=` clause. Recommendation and acceptance criteria: `P4-MASTER-AGENT6` §B.2. Size M                                                                                                                                                  |
| FR-TAX-013 | P — USER DECISION REQUIRED | `invoices.pdf.ts` `renderInvoicePdf` (per-line HSN and component amounts, totals line; no HSN or rate summary). Test: `invoices.test.ts` "renders a PDF whose metadata carries the document number" (content not asserted). Period report `gst-hsn` exists (`reports.gst.ts` `runGstHsn`)                                                                                                                                              | Not implemented. A tax professional must confirm what is required (with RD-01) before a decision. Recommendation and acceptance criteria: `P4-MASTER-AGENT6` §B.3. Size S (M with UQC / schema)                                                                                            |

If these rows are accepted, the matrix §1.3 counts would become: implemented + tested 218 (was 215),
partial 11 (was 14). The orchestrator should re-count before publishing.

### C.2 Other inaccuracies noticed (not edited by me)

| File                                                    | Section                                  | Problem                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`          | DEC-13, Recommendation (lines 293–295)   | The body still says "six small items". The 2026-11-21 note at the top corrects it to four, but the paragraph itself is unchanged                                                                                                                                   |
| `docs/PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`          | DEC-13, Group 3, FR-AD-008 row           | "Two settings not read" is out of date: both are read on the main paths; two leftovers remain (Part A.1)                                                                                                                                                           |
| `docs/PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`          | DEC-13, Groups 2 and 3, FR-PRM-004       | The requirement's source is `[PROPOSED]` and its ₹1 floor is marked `[PROPOSED]`. Group 2 ("[PROPOSED] portions") does not list it, and Group 3 does not mention it. The ₹1 floor is also not met by the engine (₹0.01)                                            |
| `docs/PHASE4-CONSOLIDATED-DECISION-PACKAGE.md`          | DEC-13, Group 3, FR-TAX-013 row          | "(with RD-01)": RD-01 contains only the odd-paisa question. No HSN-summary question has been written for the tax professional. The row also assumes "HSN summary" means the invoice PDF; `TAX_AND_GST_WORKFLOWS.md` §16.3–§16.4 show no HSN summary on the invoice |
| `docs/PHASE4-REMAINING-USER-DECISIONS.md`               | §2, DEC-13b                              | "only four were explicitly small (now implemented)" needs the qualifier that FR-AD-008 still has two leftovers                                                                                                                                                     |
| `docs/PHASE4-REMAINING-USER-DECISIONS.md`               | §2, DEC-07 / RD-01 row                   | Lists "HSN summary" under RD-01, but the RD-01 text has no such question                                                                                                                                                                                           |
| `docs/PHASE4-REMAINING-USER-DECISIONS.md`               | §3                                       | No proposed deferral record exists for FR-PRM-004, FR-PL-013 or FR-TAX-013. If the owner chooses "defer" under DEC-13b, a record in the DEF format would have to be drafted first                                                                                  |
| `docs/PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md`  | §FR-PRM-004 row (line 321) and §1.4      | Cites `catalog.mapper.ts` for `promotion: null`; that literal is in `catalog.service.ts` `mapDetail` (the mapper has `promotionLabel: null`). The cited engine test proves a ₹0.01 floor, not the ₹1 in the requirement                                            |
| `docs/PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md`  | §FR-PL-013 row (line 183)                | The cited test covers autocomplete only. No test was found for the listing search clause. The requirement says "SKU (exact)"; the code matches by prefix                                                                                                           |
| `docs/PHASE4-FR-MUST-API-TRACEABILITY-MATRIX-DRAFT.md`  | §1.4, FR-SF-005 ("no test", "≤ 30 days") | Side effect of the FR-AD-008 work: the `isNewArrival` filter now has tests (`newArrivalDays.test.ts`) and the window is configurable (default 30). The row can be re-assessed                                                                                      |
| `docs/PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`           | Lines 133–176                            | Still lists the four implemented items as open gaps (related document, outside the two decision documents)                                                                                                                                                         |
| `project-documentation/04-backend/API_DOCUMENTATION.md` | Lines 342, 1205, 1235                    | Canonical document not yet aligned with the 2026-11-21 changes: collections list rule, `actorId` parameter, SKU in admin order search. Lines 118 and 398 describe effective (promoted) prices that the code does not return (FR-PRM-004)                           |

---

## Method and limits

- **Method:** static reading of the requirement rows, the three decision / matrix documents, the API
  and tax workflow documents, the source files named above and the test files named above. Text
  search was limited to `src/`, `tests/`, `prisma/schema.prisma`, `docs/` and
  `project-documentation/`.
- **Not done:** no test, build, type-check, Prisma, database, network or Git command was run. No
  `.env` file was opened or searched. The only command that wrote anything was Prettier on this
  file.
- **Evidence strength:** every test cited runs against a mocked Prisma client. A cited test shows
  that the code builds the expected query or response in that setting. It does not prove behaviour
  on MySQL (collation, indexes, concurrency), with real providers, or in production.
- **Test names** were read from the files on 2026-11-24. Other agents were editing tests at the same
  time, so names and line numbers should be re-checked before they are used as gate evidence.
- **"No test found"** means my searches did not find one; it is not proof that none exists.
- **OpenAPI:** I did not read the generated OpenAPI document. Statements about it rely on Agent 4's
  report.
- **Legal:** nothing in this report is tax or legal advice.
