# Phase 4 — Remaining User Decisions and User-Only Actions

| Field    | Value                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Document | P4-REMAINING-USER-01                                                                                    |
| Date     | 2026-11-21                                                                                              |
| Purpose  | Everything that only you can decide or execute. Decisions already taken on 2026-11-21 (D-62 … D-66, PROJECT_CONTEXT §17.8) are not repeated |

## 1. Batch 9 acceptance — nine-risk acknowledgement checklist

Source: `PHASE4-BATCH9-UPDATED-FINAL-ACCEPTANCE-REVIEW.md` §10 (wording verbatim) and §13. To record
**Batch 9: ACCEPTED — OFFLINE MOCKED SCOPE ONLY**, please confirm each line, e.g. "Batch 9:
acknowledge RK-01 … RK-13, accept".

| ☐ | ID    | Risk (verbatim)                                                                                         | Note (2026-11-21)                                                                     |
| - | ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ☐ | RK-01 | Single worker by discipline only; no lock / runtime enforcement                                         | Unchanged                                                                             |
| ☐ | RK-02 | Two workers duplicate every scheduled job                                                               | Unchanged                                                                             |
| ☐ | RK-03 | Forced termination can leave notifications in `SENDING`; no auto-recovery                               | Unchanged                                                                             |
| ☐ | RK-04 | M-1: refund stays `PROCESSING` after an interruption; no auto-recovery; undefined recovery if no refund was issued | Now **five** code paths (admin retry added). Manual procedure documented (D-64, runbook §9.1) |
| ☐ | RK-05 | Premature "refund initiated" notifications (flows 2, 3)                                                 | Unchanged                                                                             |
| ☐ | RK-06 | 60 s forced exit can interrupt a running job / post-commit side effects                                 | Unchanged                                                                             |
| ☐ | RK-07 | M-2: registry → job signal wiring has no test                                                           | Addressed by Batch 10 WP10-1 (see the final report); Batch 10 itself still needs acceptance |
| ☐ | RK-08 | No real OS-signal integration test                                                                      | Unchanged                                                                             |
| ☐ | RK-09 | No real MySQL / two-process concurrency test                                                            | Harness prepared, not executed (DEC-12)                                               |
| ☐ | RK-10 | No production / deployment verification                                                                | Unchanged                                                                             |
| ☐ | RK-13 | Low unit coverage of `worker.ts` / `bootstrap.ts` exit paths (L-5)                                      | Unchanged                                                                             |

The acceptance would cover offline mocked scope only. It would not cover MySQL, real integrations,
production or multi-server operation.

## 2. Open decisions

| ID            | Decision                                                                 | Options / recommendation                                                                                                                                                                       | Blocks                         |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| ACC-02        | Accept Batch 9                                                           | §1                                                                                                                                                                                             | Batch register, G4 package     |
| ACC-B10       | Accept Batch 10 (after its evidence)                                     | Evidence in `PHASE4-AUTONOMOUS-COMPLETION-FINAL-REPORT.md`                                                                                                                                      | Batch register                 |
| DEC-12        | Authorize real-database execution of the six concurrency tests          | Procedure: `tests/db/README.md`. Recommendation: authorize **after G7 PASS**                                                                                                                    | G4 criterion 2 (6 P1 cases)    |
| DEC-13a       | Approve formal deferrals (§3)                                            | Recommendation: approve Groups 1 and 2                                                                                                                                                         | G4 criteria 1 and 2            |
| DEC-13b       | FR-PRM-004 (promotional price on listing / detail), FR-PL-013 (search by brand / category / attributes), FR-TAX-013 (HSN summary) | Implement or defer. The package wrongly said "six small items"; only four were explicitly small (now implemented). Recommendation: implement FR-PRM-004; get the tax professional's view on FR-TAX-013; defer FR-PL-013 or implement as a medium item | G4 criterion 2 |
| DEC-13c       | FR-NTF-005 logging of direct auth e-mails                                | Log direct sends in the notification log, or accept them unlogged                                                                                                                              | G4 criterion 2                 |
| DEC-06-impl   | Align promotions with D-63 (EXPIRED is final)                            | **Discrepancy:** an update made while the stored status is still ACTIVE / SCHEDULED but past `ends_at` (before the 1-minute activation job writes EXPIRED) can extend `ends_at` and revive it (`promotions.service.ts` `update` → `scheduleStatus`). **Proposed narrow fix:** reject date / status edits when `effectiveStatus(before, now) === 'EXPIRED'` (409 `INVALID_STATE_TRANSITION`), with a test. Authorize? | D-63 consistency               |
| DEC-05-next   | "Re-submit gateway refund" action                                        | Proposal only (D-64). Needs a payment vendor (OQ-06) for the idempotency and provider-contract verification                                                                                     | IMP-08                         |
| DEC-07 / RD-01 | Tax professional: odd-paisa split, round-off, HSN summary              | GST-08 / GST-12 tests follow the provisional rule                                                                                                                                               | Tax correctness                |
| DEC-08        | Hosting (§4)                                                             | You choose                                                                                                                                                                                     | Staging releases (deliverable) |
| DEC-10        | `.env.example` comment                                                   | Recommendation B (keep the block, refresh the comment); needs your one-time explicit permission to open and edit only that file                                                                 | DOC-10                         |
| DEC-18        | Node line (22 only vs 22 + 24)                                           | CI uses 22; local evidence is 24                                                                                                                                                               | QA-04                          |
| USR-06        | Push a branch so CI runs                                                 | Needed for CI evidence on Node 22                                                                                                                                                              | QA-04                          |
| DC-04         | TC-008: is the SUPERADMIN-stamped service audit row enough, or must a dedicated bypass event exist? | Confirm interpretation                                                                                                                                       | TC-008                         |

## 3. Formal deferral records (proposed — not deferred until you approve)

| Ref    | Requirement / item                                    | Exact gap                                                   | Reason                                                     | Security / business impact                                           | Dependency                       | Future phase / acceptance criterion                                                         | G4 effect |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- | --------- |
| DEF-A1 | PROJECT_CONTEXT §8.1 `POST /webhooks/email`, `/webhooks/whatsapp`; FR-NTF-005 (part) | Endpoints absent                                            | Vendor unknown; signature schemes unknown (OQ-08)          | No delivery / bounce status                                          | OQ-08 vendor                     | Phase 7: signed webhooks verified with vendor sandbox; delivery status recorded             | Criterion 1 |
| DEF-A2 | FR-RPT-011 async exports (> 10k rows); TC-065          | Queued, never processed; no private storage                 | Needs a queue and storage beyond D-61                      | Large exports unavailable (≤ 10k sync works)                         | Redis / storage decision         | Async job processes, a signed link is delivered, authorization re-checked                   | Criterion 2 |
| DEF-A3 | MFA recovery codes (RD-03 SCP-1)                       | Not implemented                                             | Needs a schema change                                      | A staff member who loses their MFA device needs a manual reset       | Schema decision                  | Codes generated, hashed, one-time, audited                                                  | Criterion 2 |
| DEF-A4 | FR-AUTH-007 CAPTCHA                                    | No-op provider                                              | Vendor (OQ-71 / D-48)                                      | Bot defence relies on rate limits                                    | Vendor                           | CAPTCHA verified on register / login / reset                                                | Criterion 2 |
| DEF-A5 | FR-AUTH-010 breached-password API                      | Offline list only                                           | External service                                           | Weaker screening                                                     | Vendor / network policy          | k-anonymity breach check with graceful fallback                                             | Criterion 2 |
| DEF-B1 | FR-PL-015 "[PROPOSED]" out-of-stock sorted last        | No availability sort                                        | Proposed-only portion                                      | Merchandising only                                                   | —                                | Listing sorts in-stock first unless a filter is applied                                     | Criterion 2 |
| DEF-B2 | FR-INV-004 "[PROPOSED bulk]" CSV upload                | JSON bulk only                                              | Proposed-only portion                                      | Operational convenience                                              | Admin UI (Phase 6)               | CSV validated row by row, audited                                                           | Criterion 2 |
| DEF-B3 | FR-PV-012 "[PROPOSED]" 15 images / 10 MB / JPG-PNG-WebP | 30 images; size / format not server-checked                 | Proposed-only limits; API doc proposes 30                  | Upload abuse limited by Cloudinary signed uploads                    | Cloudinary verification (EXT-04) | Limits enforced server-side; the agreed number recorded                                     | Criterion 2 |

## 4. DEC-08 — hosting comparison (factual; you decide)

Source: `project-documentation/09-deployment/DEPLOYMENT_ARCHITECTURE.md` §3 (prices are indicative
and must be verified). Adapted to the current architecture: API plus exactly one worker, MySQL 8, no
Redis yet.

| Criterion              | DigitalOcean Bangalore                                          | AWS Mumbai (ap-south-1)                                                    |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Fit                    | App Platform service + worker (count 1), Managed MySQL 8, Spaces | ECS Fargate `api` + `worker` (desired 1), RDS MySQL 8, S3, Secrets Manager |
| Indicative cost (prod) | ~USD 120–250 / month                                            | ~USD 250–500 / month                                                       |
| Backups / PITR         | Managed MySQL daily backups + PITR within retention             | RDS automated backups 14–35 days + PITR; snapshot copy                     |
| Disaster recovery      | Single Indian region; off-site copies needed                    | Second Indian region (Hyderabad) for snapshot copies                       |
| Security               | Cloud firewall; Cloudflare in front recommended; app-level env secrets | IAM, Secrets Manager, WAF + Shield Standard, private subnets          |
| Ops complexity         | Low–medium                                                      | Medium–high (IAM / VPC; mitigated with IaC)                                |
| Scalability            | High for this project's scale                                   | Very high                                                                  |

**Assumptions:**

- launch scale, small ops team;
- staging can be smaller than production;
- single API instance until shared rate-limit / session storage is decided (D-38).

**Recommendation:**

- **DigitalOcean** if cost and simplicity dominate;
- **AWS** if compliance, DR across two Indian regions and long-term scale dominate.

I will not create accounts, purchase or deploy.

## 5. User-only gate actions

**G2 (backup / restore drill) — next step: Step 1, non-destructive.**

1. Open Windows PowerShell 5.1 on your machine.
2. Run exactly the block in `docs/G2-USER-EXECUTION-GUIDE.md` **lines 52–88**. Change `$adminUser`
   only if your MySQL admin account is not `root`.
3. **What it does:**
   - defines paths and fixed names (`ecommerce_dev` source, `ecommerce_restore_check` target);
   - refuses unsafe values;
   - creates `C:\db-backups\ecommerce` and an evidence folder.

   It does **not** connect to MySQL and asks for no password.
4. **Expected output:** two lines,
   `dump file : C:\db-backups\ecommerce\ecommerce_dev_<timestamp>_G2.sql` and
   `evidence dir : …\G2_evidence_<timestamp>`.
5. **Stop** if any line starts with `G2 STOP:`.
6. Send me the two lines (no secrets). I will verify them and give you Step 2 (read-only counts; the
   password is typed only in your terminal, never in chat).

**G3 (migration identity):**

- The procedure `INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` v1.2.1 was independently reviewed.
- It **needs your explicit approval to execute** after G2 passes.
- Evidence required: checklist G3-01 … G3-15 (`INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md`), with
  `SHOW GRANTS` output redacted.

**After that:** F5 readiness review (by me, from the evidence), then G7 and G8 (each needs explicit
authorization), then seeds and the Superadmin CLI (USR-05).

**CI:** push a branch / open a PR so `ci.yml` runs on Node 22 (USR-06). I do not run Git.
