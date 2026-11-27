# Phase 4 Master Completion — Agent 4: OpenAPI Contract (WP10-4)

| Field       | Value                                                |
| ----------- | ---------------------------------------------------- |
| Document ID | P4-MASTER-AGENT4                                     |
| Date        | 2026-11-24                                           |
| Executed by | Orchestrator                                         |
| Evidence    | Generated specification, contract tests, drift check |

## Status

| Work package                            | Status           |
| --------------------------------------- | ---------------- |
| WP10-4 Content types for file downloads | ALREADY COMPLETE |

The generator change, the regenerated `docs/openapi/openapi.json` and the tests date from
2026-11-21. Nothing was changed in this run.

## Verification

Documented `200` media types in the current `docs/openapi/openapi.json`, compared with the route
code:

| Operation                                | Route code sends                                                                                | Specification `200`                                                                                                          | Match |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| `POST /admin/audit-logs/export`          | `text/csv; charset=utf-8` (`audit.routes.ts`)                                                   | `text/csv`                                                                                                                   | Yes   |
| `POST /admin/barcodes/labels`            | `application/pdf` (`barcodes.routes.ts`)                                                        | `application/pdf`                                                                                                            | Yes   |
| `GET /admin/orders/{orderId}/invoice`    | `application/pdf` (`orders.routes.ts` `sendPdf`)                                                | `application/pdf`                                                                                                            | Yes   |
| `GET /me/orders/{orderNumber}/invoice`   | `application/pdf` (`orders.routes.ts` `sendPdf`)                                                | `application/pdf`                                                                                                            | Yes   |
| `POST /admin/reports/{reportKey}/export` | CSV / XLSX / PDF by format (`reports.routes.ts`, `lib/export/types.ts`); `202` JSON when queued | `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/pdf`; `202` `application/json` | Yes   |

**Other facts:**

- Total operations: 248 (unchanged).
- The inventory history operation documents the new optional `actorId` parameter (FR-INV-006).
- No route or runtime behaviour was changed by WP10-4.

## Checks executed today

| Command                                             | Result                                         |
| --------------------------------------------------- | ---------------------------------------------- |
| `npm run openapi:check`                             | Pass ("openapi.json is up to date")            |
| `npx vitest run tests/unit/scripts/openapi.test.ts` | Pass (8 tests, including the two WP10-4 tests) |

## Defect outside the approved five operations (not changed)

**DC-05 (proposed S4, documentation contract):** `GET /admin/product-variants/{variantId}/barcode`
sends `image/png` or `image/svg+xml`, but the specification documents `application/json`. It is not
one of the five approved operations. Correcting it needs authorization (a one-entry addition to
`FILE_DOWNLOADS` plus regeneration).
