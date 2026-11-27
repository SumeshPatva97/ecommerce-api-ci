# Phase 4 — API Contract Conformance Audit

| Field      | Value                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document   | P4-CONTRACT-AUDIT-01                                                                                                                                       |
| Date       | 2026-11-24                                                                                                                                                 |
| Compared   | `project-documentation/04-backend/API_DOCUMENTATION.md` (the API document) against the route, schema, service and mapper source of `ecommerce-api`         |
| Method     | Reading and text search only, by two independent read-only reviews (customer / public half and admin half). Nothing was executed for the comparison itself |
| Scope      | G4 criterion 1: "all endpoints in API_DOCUMENTATION implemented or formally deferred"                                                                      |
| Identifier | `CA1-nn` and `CA2-nn` are **temporary audit references of this document**. They are not decision IDs and carry no approval status                          |
| Status     | Evidence and open questions. **This document approves nothing.** Phase 4 remains IN PROGRESS — NOT APPROVED. G4 is NOT MET                                 |

## 1. Result in short

| Question                                                                  | Result                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Documented operations checked                                             | 248 (68 customer, public, webhook and health; 180 admin)                                                      |
| Documented operations with a registered route of that method and path     | 248 of 248                                                                                                    |
| Documented operations without a route                                     | The four formally deferred operations only (D6, D7), and the signed report-export download (known FR-RPT-011) |
| Registered routes that the API document does not describe                 | 0                                                                                                             |
| Audience guard (public, customer, signed webhook) as documented           | 68 of 68                                                                                                      |
| Admin permission key as documented (route tables and the §7 matrix)       | 180 of 180                                                                                                    |
| Places where the code is **weaker** than the document on authorization    | 0 found                                                                                                       |
| Places where the code is **stricter** on re-authentication                | 8 operations (CA2-01 to CA2-03)                                                                               |
| Operations with at least one confirmed difference in request or behaviour | 62 (23 customer / public, 39 admin), from 57 findings                                                         |

**Clarification 2026-11-27 (independent read-only audit; the table above is kept as written on 2026-11-24).** The first three rows of the table must be read as follows. The number 248 is the number of operations in the generated OpenAPI specification (`docs/openapi/openapi.json`), which is produced from the registered routes. It is not a count of everything the API document describes.

- **Operations in the OpenAPI specification:** 248 (180 admin; 68 customer, public, webhook and health). Recounted on 2026-11-27; unchanged.
- **Of these, operations with an implemented route:** 248, because the specification is generated from the routes. All 248 are also described in the API document: 236 are written there as method and path, and 12 get-by-ID routes are covered by combined notation such as `GET/PATCH/DELETE …/:id`.
- **Items the API document describes that have no route (5):** the four formally deferred operations — `POST /webhooks/email`, `POST /webhooks/whatsapp` and `GET /webhooks/whatsapp` (DEF-A1, D6), and `GET /api/v1/openapi.json` (D7) — and one signed report-export download URL that appears only in a response example (related to FR-RPT-011; no approved deferral covers it).
- **Not independently verified:** the figure "62 operations with at least one confirmed difference" in the last row; the code side of rows CA1-26 and CA2-06 (not re-checked); the code side of rows CA1-11, CA1-12, CA1-27, CA2-21, CA2-22, CA2-23, CA2-24, CA2-25 and CA2-29 (re-checked in part); findings TW-03 and TW-04; and the response DTOs listed in §2. Nothing was executed for the 2026-11-27 check.

Route presence is not contract conformance. The 57 recorded differences are unchanged, and 32 of them still await the owner's decision (§4).

This is an independent second check of the method-and-path comparison recorded in
`PHASE4-G4-CRITERIA-AND-EVIDENCE-MATRIX.md` §2 and §11, and the first comparison that goes below
method and path. It is still a reading exercise: it does not prove behaviour on MySQL, with real
providers, in CI or in a deployment.

## 2. Limits of the comparison

- **Not compared field by field:** coupon and promotion response DTOs, shipment and shipping-method
  DTOs, CMS DTOs, notification templates and logs, staff user and role DTOs, settings groups and
  keys, per-report columns, dashboard payloads.
- **Not traced end to end:** notification emission, audit rows beyond the actions named in the
  document, CORS allow-list behaviour, JWT internals, tax arithmetic of the §3.9 example,
  `capturePayment` / `failPayment` bodies, inventory reserve and release internals.
- **Not read:** the database seed (so which settings are public is unknown), the schemas inside
  `docs/openapi/openapi.json` (it was used to enumerate operations only), the tests.
- **Orchestrator re-verification:** the rows marked "re-verified" in §4 were checked again in the
  source by the orchestrator before anything was written to a canonical document. The other rows
  rest on the reviewing agent's file and line evidence.

## 3. Classification and disposition

| Class         | Meaning                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| CODE-DEVIATES | The document is specific and the code does something else                                                           |
| DOC-STALE     | The code is deliberate: it follows a later recorded decision, the approved schema, or the stricter of two documents |
| AMBIGUOUS     | It cannot be told from the documents which side is intended                                                         |
| UNDOCUMENTED  | A registered route the document does not describe (none found)                                                      |

| Disposition    | Meaning                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| FIXED          | Corrected in code on 2026-11-24 with a regression test                                                       |
| NOTED          | Recorded as a dated implementation note in `API_DOCUMENTATION.md` §11. The contract text itself is unchanged |
| AWAITING OWNER | A contract, business or security choice. Nothing was changed                                                 |
| KNOWN          | Already covered by an existing item, named in the row                                                        |

## 4. Findings

### 4.1 Customer, public, webhook and health API (document §2, §3, §5, §6)

| Ref    | Where                                   | Difference                                                                                                                                                                               | Class                  | Disposition                                                                   |
| ------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| CA1-01 | §5 webhooks                             | The document says the payment and shipping webhooks are implemented and names real providers. Only mock adapters exist; in production the mock is refused (webhooks 404, verify 503)     | DOC-STALE              | NOTED (re-verified). Real providers are Phase 7 (FR-PAY-001)                  |
| CA1-02 | `GET /settings/public`                  | Documented as a fixed flat object. The code returns the public settings grouped by settings group, with no fixed key set                                                                 | CODE-DEVIATES          | AWAITING OWNER                                                                |
| CA1-03 | OTP send / verify                       | Only `VERIFY_PHONE` over `WHATSAPP` is accepted; other purposes and channels return 422 `NOT_SUPPORTED`. Verify never signs in                                                           | DOC-STALE (D-41, D-46) | NOTED (re-verified)                                                           |
| CA1-04 | `POST /auth/verify-email`               | Body is `{ token }` only; the `{ email, otp }` form is rejected                                                                                                                          | DOC-STALE (D-41)       | NOTED (re-verified)                                                           |
| CA1-05 | Login, `sf_rt` cookie                   | Login accepts `rememberMe` (default false). Without it `sf_rt` is a session cookie                                                                                                       | DOC-STALE (D-51)       | NOTED (re-verified)                                                           |
| CA1-06 | `POST /auth/refresh`, `/auth/logout`    | Both also require the `X-Client` header naming the application, as AUTHENTICATION_AUTHORIZATION §16.2 says; the API document calls the header diagnostic only                            | DOC-STALE              | NOTED (re-verified)                                                           |
| CA1-07 | `GET /cms/home`                         | Sections are `{ key, type, title, content }` with the schema's section types; product rails are not resolved to listing cards. Marked provisional in the code (OQ-50)                    | CODE-DEVIATES          | AWAITING OWNER (OQ-50)                                                        |
| CA1-08 | `GET /banners`                          | Placements are those of the approved schema (`HOME_HERO`, `ANNOUNCEMENT`, `HOME_PROMO_STRIP`, `HOME_MID`, `CATEGORY_TOP`, `MEGA_MENU`, `CART`); `subtitle` and `ctaLabel` have no column | DOC-STALE              | NOTED (re-verified)                                                           |
| CA1-09 | `ETag` / `If-None-Match` on public GETs | The ETag covered the whole body, which contains a per-request `requestId`, so it changed on every response and 304 could not happen                                                      | CODE-DEVIATES          | **FIXED** — §5                                                                |
| CA1-10 | Rate-limit classes                      | Stricter classes exist that §2.8 does not list: `profile-write` 30/min, `review-create` 5/h, `coupon-apply` 10 per 10 min, `checkout-order` 5/min                                        | DOC-STALE (OQ-109)     | NOTED (re-verified)                                                           |
| CA1-11 | Webhook rate limit                      | The general limiter (default 300/min per IP) runs before the webhook router, so the documented 600/min webhook class is not reached                                                      | CODE-DEVIATES          | AWAITING OWNER (the limits are marked proposed; a change would relax a limit) |
| CA1-12 | Change password                         | Accepts `signOutOtherDevices` (default true). Sends `PASSWORD_CHANGED` only, no `SECURITY_ALERT`; two documents disagree on the alert                                                    | DOC-STALE / AMBIGUOUS  | AWAITING OWNER for the alert                                                  |
| CA1-13 | Refresh with an expired token           | Returns 401 `TOKEN_EXPIRED`, as AUTHENTICATION_AUTHORIZATION says and the tests assert; the API document says `UNAUTHENTICATED`                                                          | DOC-STALE              | NOTED (re-verified)                                                           |
| CA1-14 | Refresh grace window                    | Grace also needs the same user-agent fingerprint and a live in-memory entry (single instance, D-38)                                                                                      | DOC-STALE              | NOTED (re-verified)                                                           |
| CA1-15 | Wrong token audience                    | Returns 401 `UNAUTHENTICATED`, not 403 `FORBIDDEN` / `WRONG_AUDIENCE`. Same finding as CA2-04. Access is denied either way                                                               | AMBIGUOUS              | AWAITING OWNER                                                                |
| CA1-16 | `maxPurchasable` on listing and detail  | Uses a constant 5. Cart and checkout read the `checkout.max_qty_per_line` setting, so they can disagree if the setting is not 5                                                          | CODE-DEVIATES          | AWAITING OWNER — same kind as FR-AD-008 (decision D2)                         |
| CA1-17 | `pricesIncludeTax` on product detail    | Constant `true`; cart and checkout read the tax settings                                                                                                                                 | CODE-DEVIATES          | AWAITING OWNER — same kind as FR-AD-008 (decision D2); OQ-21                  |
| CA1-18 | `sizeGuideBlockKey` on product detail   | Always `null`; category detail resolves it                                                                                                                                               | CODE-DEVIATES          | AWAITING OWNER (OQ-44, OQ-90)                                                 |
| CA1-19 | `rejectionReason` in `GET /me/reviews`  | Always `null`: the approved schema has no column for it                                                                                                                                  | CODE-DEVIATES          | AWAITING OWNER (schema)                                                       |
| CA1-20 | `estimatedDelivery` in order tracking   | Always `null`: the approved schema has no expected-delivery column (see §6)                                                                                                              | CODE-DEVIATES          | AWAITING OWNER (schema)                                                       |
| CA1-21 | Autocomplete `suggestions`              | Always `[]`: there is no search-term store                                                                                                                                               | CODE-DEVIATES          | AWAITING OWNER                                                                |
| CA1-22 | `GET /health/ready`                     | The only check is named `database`; there is no `redis` check (Redis deferred, D-38). A 503 adds `Retry-After: 5`                                                                        | DOC-STALE              | NOTED (re-verified)                                                           |
| CA1-23 | Public `Cache-Control`                  | Not set on `/settings/public`, `/shipping/serviceability`, `/shipping/methods`                                                                                                           | AMBIGUOUS              | AWAITING OWNER                                                                |
| CA1-24 | `X-API-Version` response header         | Never set                                                                                                                                                                                | CODE-DEVIATES          | AWAITING OWNER (the version value is not defined)                             |
| CA1-25 | Pincode that cannot be verified         | Checkout proceeds with a `SERVICEABILITY_UNVERIFIED` issue; only an explicit "not serviceable" blocks                                                                                    | AMBIGUOUS              | AWAITING OWNER                                                                |
| CA1-26 | `actions.canRetryPayment`               | True for any unpaid order; it ignores the 60-minute window and the attempt limit that the retry endpoint enforces                                                                        | AMBIGUOUS              | AWAITING OWNER                                                                |
| CA1-27 | Extra optional request fields           | `captchaToken` on register, login, resend-verification and forgot-password (D-48); `district`, `companyName` on addresses; `consentTextVersion` on preferences                           | DOC-STALE              | NOTED (`captchaToken` re-verified)                                            |
| CA1-28 | `PATCH /me` phone change                | Clears the verified flag only; no OTP is sent automatically                                                                                                                              | AMBIGUOUS              | AWAITING OWNER                                                                |

### 4.2 Admin API (document §4, §7)

| Ref    | Where                                              | Difference                                                                                                                                            | Class                 | Disposition                                                |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------- |
| CA2-01 | HSN code create, update, delete                    | Require re-authentication; the document marks re-authentication only for rates, assignments and settings                                              | DOC-STALE (R-15)      | NOTED (re-verified)                                        |
| CA2-02 | `PATCH /admin/users/:userId`, staff session revoke | Both require re-authentication. R-15 names session revocation; it does not name the profile update                                                    | DOC-STALE / AMBIGUOUS | NOTED (re-verified); the profile update is AWAITING OWNER  |
| CA2-03 | Role create, update, delete                        | Require re-authentication                                                                                                                             | DOC-STALE (R-15)      | NOTED (re-verified)                                        |
| CA2-04 | Customer token on `/admin/*`                       | 401 `UNAUTHENTICATED`, not 403 `WRONG_AUDIENCE` (see CA1-15)                                                                                          | AMBIGUOUS             | AWAITING OWNER                                             |
| CA2-05 | `PERMISSION_DENIED` body                           | No `details[0].meta.required`; the required keys go to the audit row only. The reports module does return it                                          | CODE-DEVIATES         | AWAITING OWNER (shape for guards that need several keys)   |
| CA2-06 | `low-stock` report                                 | Also needs `inventory.view`; the document lists that only for `inventory-valuation`                                                                   | AMBIGUOUS             | AWAITING OWNER                                             |
| CA2-07 | `POST /admin/users`                                | Accepts `isSuperadmin` (Superadmin only, audited); `roleIds` may then be empty. Not documented                                                        | AMBIGUOUS             | AWAITING OWNER                                             |
| CA2-08 | Admin order cancel                                 | Allowed from `CONFIRMED`, `PROCESSING`, `PACKED` only; the document also allows the two unpaid states                                                 | CODE-DEVIATES         | KNOWN — RD-04                                              |
| CA2-09 | `initialStock` on product and variant create       | Never applied; the response carries an `INITIAL_STOCK_NOT_APPLIED` warning. The document says it creates a stock-in movement                          | CODE-DEVIATES         | AWAITING OWNER                                             |
| CA2-10 | Refund approval and restock                        | Approval moves no stock; the per-line `restock` flag becomes one refund-level flag. The code follows ADMIN_WORKFLOWS §11.3, so two documents conflict | DOC-STALE             | AWAITING OWNER                                             |
| CA2-11 | Image registration                                 | Only the folder prefix is checked; no check of format, size or dimensions with Cloudinary                                                             | CODE-DEVIATES         | KNOWN — FR-PV-012, control FU-05, proposed deferral DEF-B3 |
| CA2-12 | Image delete                                       | The Cloudinary asset is not destroyed                                                                                                                 | CODE-DEVIATES         | AWAITING OWNER (needs the provider; Phase 7)               |
| CA2-13 | Audit-log export                                   | CSV only; above 10 000 rows it returns 422 `EXPORT_TOO_LARGE` instead of queuing                                                                      | CODE-DEVIATES         | AWAITING OWNER (related to FR-RPT-011)                     |
| CA2-14 | Tax rate body                                      | `name`, `ratePercent`, `status` only; `effectiveFrom` / `effectiveTo` are rejected (dates live on assignments)                                        | DOC-STALE             | NOTED (re-verified)                                        |
| CA2-15 | Promotion body                                     | `description` and `bannerLabel` are rejected (no columns); `includeDescendants` is accepted                                                           | DOC-STALE             | NOTED (re-verified)                                        |
| CA2-16 | Banner body                                        | Takes `desktopImageUrl` / `mobileImageUrl`; `subtitle`, `ctaLabel` and the public-id fields are rejected                                              | DOC-STALE             | NOTED (re-verified)                                        |
| CA2-17 | Shipment `PATCH`                                   | `trackingUrl` is rejected; a note-only update is rejected                                                                                             | DOC-STALE             | NOTED (re-verified)                                        |
| CA2-18 | `PATCH /admin/settings`                            | Body is `{ changes: [{ key, value, version }], reason? }` with a required per-key version                                                             | DOC-STALE             | NOTED (re-verified)                                        |
| CA2-19 | Attribute key field                                | Named `code` (the approved schema column), immutable; `slug` is rejected                                                                              | DOC-STALE             | NOTED (re-verified)                                        |
| CA2-20 | Notification resend                                | Body `{ reason, channel? }` is required; limit is 3 per notification per 24 h; status 201, or 200 on a 60-second replay                               | DOC-STALE             | NOTED (re-verified for the body)                           |
| CA2-21 | Tax assignment update and delete                   | After an assignment has started only `effectiveTo` may change, and delete returns 409                                                                 | CODE-DEVIATES         | AWAITING OWNER (stricter, undocumented)                    |
| CA2-22 | Superadmin approving an own refund                 | Needs a `note`, else 422 `JUSTIFICATION_REQUIRED`                                                                                                     | CODE-DEVIATES         | AWAITING OWNER (stricter, undocumented)                    |
| CA2-23 | Variant delete                                     | Also blocked for the last active variant and for a variant with order or stock history (marked provisional)                                           | CODE-DEVIATES         | AWAITING OWNER                                             |
| CA2-24 | Variant generation                                 | Extra cap of 100 combinations per request; extra 422 `AXIS_MISMATCH`                                                                                  | CODE-DEVIATES         | AWAITING OWNER                                             |
| CA2-25 | `DELETE /admin/auth/sessions/:sessionId`           | Returns 200 with a body, as §2.2 requires; the route table says 204                                                                                   | DOC-STALE             | NOTED (re-verified)                                        |
| CA2-26 | Change-password audit row                          | Action `UPDATE`, event `auth.password_changed`; the document says `PASSWORD_RESET`, `auth.password_change`                                            | CODE-DEVIATES         | AWAITING OWNER                                             |
| CA2-27 | Label PDF rate class                               | Uses `barcode-labels`, not `admin-export`; the code comment asks for owner review                                                                     | AMBIGUOUS             | AWAITING OWNER                                             |
| CA2-28 | Product slug change                                | The old slug is not kept as a redirect (the document marks that as proposed)                                                                          | DOC-STALE             | AWAITING OWNER                                             |
| CA2-29 | Product status transitions, SKU lock               | Transitions are restricted; SKU is locked by stock movements or orders, not by barcode printing                                                       | AMBIGUOUS             | AWAITING OWNER                                             |

## 5. Defect fixed in this audit — CA1-09

| Item         | Detail                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract     | API document §2.5: `If-None-Match` / `ETag` on public catalog and CMS GETs                                                                                                                 |
| Defect       | Express computed the ETag over the whole JSON body. The body holds a per-request `requestId`, so no two responses shared an ETag and a conditional request always received 200             |
| Severity     | Proposed S4 (performance and bandwidth; no security or data effect). Not a P0 / P1                                                                                                         |
| Fix          | `src/core/http/publicCache.ts` (new): routes marked publicly cacheable get a weak ETag computed from `data` and `meta` only. `src/core/http/envelope.ts` sets it; Express then answers 304 |
| Also changed | `src/modules/catalog-common/catalog.http.ts` and `src/modules/catalog/index.ts` now use the shared helper. Private responses are unchanged                                                 |
| Test         | `tests/integration/publicCacheEtag.test.ts`, four cases. Before the fix two failed ("same ETag" and "304"); after the fix all four pass                                                    |
| Limits       | Mocked database. The generated OpenAPI specification does not list the 304 response. Product detail for a signed-in customer stays uncached, as before                                     |

## 6. Related finding from the schema-structure tests

`project-documentation/05-database/DATABASE_DESIGN.md` describes two things that are in neither
`prisma/schema.prisma` nor the reviewed baseline migration:

| Ref       | Document                                                         | Schema                          | Effect                                                                                  |
| --------- | ---------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| DB-DOC-01 | Line 1328: unique key `uq_refunds_provider (provider_refund_id)` | No such unique key on `refunds` | Nothing in the database stops two refund rows from carrying the same provider refund ID |
| DB-DOC-02 | Line 1406: `shipments.expected_delivery_date DATE`               | No such column                  | `estimatedDelivery` is always `null` (CA1-20)                                           |

Both are **AWAITING OWNER**: a schema change needs your approval (the route is a schema change
proposal), or the older design document needs a correction note. Whether the Phase 3 design
dropped them on purpose was not established. `DB-DOC-nn` are temporary audit references.

### 6.1 Findings from the test work of the same run

`TW-nn` are temporary audit references. Nothing here was changed in code.

| Ref   | Where                                        | Finding                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                        | Disposition                                                                                                      |
| ----- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| TW-01 | Barcode labels                               | The printed PDF keeps only the first 2 text lines on the A4 sheet and the first 3 on the thermal label, silently. `POST /admin/barcodes/preview` returns all lines with no warning, so the MRP line shown in the preview is not printed on A4 with the default fields | `src/modules/barcodes/barcodes.render.ts` line 128; `barcodes.service.ts` line 252. Label content is marked provisional (OQ-40)                                 | AWAITING OWNER (OQ-40; which lines a label must carry, including MRP, is a business and possibly legal question) |
| TW-02 | `payments` report                            | Success rate is computed as (captured + partially refunded + refunded) / (that + failed). REPORTING_AND_ANALYTICS line 314 says captured / (captured + failed). The code comment says the choice is deliberate                                                        | `src/modules/reports/reports.payments.ts` lines 105–107, 129–131. With 5 captured, 1 refunded, 2 failed the API returns 75.00; the document formula gives 71.43 | AWAITING OWNER                                                                                                   |
| TW-03 | `promotions` report                          | The totals row sums per-promotion distinct order counts, so an order with lines under two promotions would count twice in the total. Read from the code; not reproducible with mocked SQL                                                                             | `src/modules/reports/reports.marketing.ts` line 171                                                                                                             | AWAITING OWNER                                                                                                   |
| TW-04 | `coupons` report                             | `redemptions` counts redeemed and released usages; the report document's column text says redeemed only, while its calculation note matches the code                                                                                                                  | `reports.marketing.ts` lines 88–94                                                                                                                              | AWAITING OWNER (document wording)                                                                                |
| TW-05 | Stored payment webhooks                      | Card-like fields are redacted by key name. Data under a key that does not match the list would be stored as received                                                                                                                                                  | `src/modules/payments/payments.capture.ts` lines 168–172; `src/lib/redact.ts` lines 12–13                                                                       | AWAITING OWNER (review with the real provider's payload, Phase 7)                                                |
| TW-06 | `POST /me/orders/:orderNumber/retry-payment` | No body schema: unknown body fields are ignored, not rejected. `providerPayload` on `/payments/verify` is a free-form record that is accepted and never read                                                                                                          | `src/modules/payments/payments.routes.ts` lines 44–56; `payments.schemas.ts` line 22                                                                            | AWAITING OWNER (low)                                                                                             |
| TW-07 | Product detail SEO title                     | Falls back to the plain product name; the API document example shows "name \| brand"                                                                                                                                                                                  | `src/modules/catalog/catalog.service.ts` line 689                                                                                                               | AWAITING OWNER (low)                                                                                             |

### 6.2 UNCLASSIFIED OBSERVATION — Error-path cache headers (recorded 2026-11-27)

Recorded on 2026-11-27 from a read-only reading of the source. Nothing was executed: the behaviour below was not observed in a running process or in a test. This entry has no audit reference and no decision ID.

**What the source shows.**

- The default for every response is `Cache-Control: no-store` (`src/core/middleware/security.ts` lines 30–35, mounted in `src/app.ts` line 56).
- `publicCache` replaces it with `Cache-Control: public, max-age=60, stale-while-revalidate=300` and passes the request on (`src/core/http/publicCache.ts` lines 13 and 18–27). It does this before the later stages of the route have run.
- The final error middleware sends the error envelope with the status of the error. It adds only headers carried by the error itself and does not reset `Cache-Control` (`src/core/middleware/errorHandler.ts` lines 53–72).
- A validation failure reaches it as `VALIDATION_ERROR`, HTTP 422 (`src/core/middleware/validate.ts` line 56; `src/core/errors/errorCodes.ts` line 6). `NOT_FOUND` is HTTP 404 (`errorCodes.ts` line 13).
- So an error raised after `publicCache` has run is sent with the public cache header still set.

**Routes where this applies (all under `/api/v1`).**

- `publicCache` runs before validation, so a 422 and a 404 both keep the header:
  - `GET /categories/:slug` — `src/modules/categories/categories.routes.ts` lines 105–111; not-found raised in `categories.service.ts` lines 596–605.
  - `GET /collections/:slug` — `src/modules/collections/collections.routes.ts` lines 88–94; `collections.service.ts` lines 290–292.
  - `GET /cms/pages/:slug` — `src/modules/cms/cms.routes.ts` lines 42–50; `cms.service.ts` lines 479–483.
  - `GET /products/:slug/reviews` — `src/modules/reviews/reviews.routes.ts` lines 61–74; `reviews.service.ts` lines 293–300.
- `publicCache` runs before validation, and only the 422 case was identified: `GET /categories` (`categories.routes.ts` lines 98–104), `GET /collections` (`collections.routes.ts` lines 81–87) and `GET /banners` (`cms.routes.ts` lines 51–60).
- Validation runs before `publicCache`, so a 422 does not carry the header, but a 404 raised by the handler does:
  - `GET /products` and `GET /products/facets` with an unknown category — `src/modules/catalog/index.ts` lines 38–57; `catalog.service.ts` lines 101–106.
  - `GET /products/:slug/related` — `src/modules/catalog/index.ts` lines 72–83; `catalog.service.ts` line 406.
- Not affected, as read: `GET /products/:slug` marks the response as cacheable only after the product has been found (`src/modules/catalog/index.ts` line 68). On each of these routes the rate limiter runs before `publicCache`, so a 429 is sent before the header is set.
- For `GET /brands`, `GET /cms/home` and `GET /search/autocomplete`, no 404 or 422 raised after `publicCache` was identified.

By the same mechanism, any other error raised after `publicCache` has run, including an unexpected 5xx, would be sent in the same way. This was not examined route by route.

**Not established.**

- The behaviour was not executed or observed. A search of `tests/` found no assertion on the `Cache-Control` header of an error response for these routes.
- The effect on a browser, a proxy or a CDN was not assessed.
- `API_DOCUMENTATION.md` §2.5 gives this header "on public GETs" and does not say what an error response should carry. Whether the behaviour differs from the contract is therefore not established.
- No `ETag` is added to these responses: `ok()` sets it only for a 200 (`src/core/http/envelope.ts` line 47).

**Standing of this entry.**

- This is an observation requiring owner / security review.
- No severity has been assigned.
- It is not yet classified as a P0 / P1 or S1 / S2 defect.
- No remediation decision has been made.
- No fix has been implemented. No source or test file was changed for this entry.
- This entry does not establish that G4 criterion 3 is met.

## 7. What this means for G4 criterion 1

- **Presence:** every documented operation is implemented or formally deferred, and no undocumented
  route exists. This is now confirmed by a second, independent check that read the route files.
- **Shape:** 57 differences are recorded. One is fixed, 22 are noted as implementation notes where
  the code follows a recorded decision or the approved schema, two are known items, and 32 need
  your decision.
- **Position:** criterion 1 is **not marked met**. The owner has to decide whether presence is
  sufficient, and how the open contract rows are to be handled (correct the code, or accept the
  implementation and update the document).
