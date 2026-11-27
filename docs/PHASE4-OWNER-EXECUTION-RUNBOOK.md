# Phase 4 — Owner Execution Runbook

| Field  | Value                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| Date   | 2026-11-24                                                                                                     |
| Nature | Ordered instructions for operations **only the owner can execute**. Nothing here was executed                  |
| Rule   | One operation at a time. Each needs its own authorization before it starts and its own acceptance after review |

This runbook does not replace the authoritative procedures. It gives the order, the document to
follow, the evidence to capture and the stop conditions. Where the authoritative procedure and this
runbook differ, the authoritative procedure wins.

## 0. Rules for every operation

**Never put in a report, a chat message, a ticket or a commit:**

- passwords, password hashes, authentication strings;
- connection URLs or any part of one;
- the contents of `.env`, `.env.migration` or any other environment file;
- tokens, keys, certificates, dump files.

You may state that a file exists and give its size and hash. If a `SHOW GRANTS` line contains an
authentication clause, delete that clause and keep the privilege line. Source:
`INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` §1.

**Stop and report, instead of continuing, when** any command exits non-zero, any output differs
from the expected output, or a step would need a secret to be printed. Never repair a failed check
by widening a grant, by changing a target database, or by re-running until it passes. Source: the
same checklist §5.

**The assistant's role:** it reviews the redacted output you paste and tells you whether the step
matches. It does not connect to the database, run Git, read environment files or deploy.

## Names used in this runbook — read first

Your closure brief lists "G7 migration execution" and "G8 seed execution". In the authoritative
roadmap (`INCREMENT-B-MASTER-ROADMAP-G2-G8.md`) the gates are:

| Gate | What it is                                                                    |
| ---- | ----------------------------------------------------------------------------- |
| G2   | Backup and restore drill for `ecommerce_dev`                                  |
| G3   | Least-privilege migration identity                                            |
| F5   | Readiness review before G7 (prepared by the assistant, decided by you)        |
| G7   | Baseline migration on the empty **scratch** database `ecommerce_migrate_test` |
| G8   | Baseline migration on **`ecommerce_dev`**                                     |

**Seed execution is not G8.** It is a separate step after G8 with its own authorization. This
runbook therefore has a step 4 (G8, migration on `ecommerce_dev`) and a step 4b (seeds).

These database gates share the names "G7" and "G8" with the Phase 7 and Phase 8 exit gates in
`IMPLEMENTATION_ROADMAP.md`. They are different things (open documentation item DOC-11).

## Order

```text
1  G2 drill ──► 2  G3 identity ──► F5 review ──► 3  G7 scratch migration
                                                      │
                                                      ├──► 5  DEC-12 real-database tests (on ecommerce_test)
                                                      └──► 4  G8 migration on ecommerce_dev ──► 4b seeds

6  Git push / pull request (CI)        independent; can be done first
7  npm audit                           independent; can be done first
8  Hosting and staging                 after DEC-08; staging needs 1–4b
9  Client written approval             after G4 criteria 1–4
10 Production release approval         not a Phase 4 step
```

---

## 1. G2 — backup and restore drill

| Aspect                  | Detail                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state           | Step 0 PASS (2026-11-19). Step 1 not verified. Not accepted                                                                                                                                                   |
| Prerequisites           | MySQL 8.4 service running; `ecommerce_dev` exists; privileged local access; Windows PowerShell 5.1                                                                                                            |
| Authoritative documents | `G2-USER-EXECUTION-GUIDE.md` (Steps 0–11); procedure `INCREMENT-B-G2-BACKUP-RESTORE-DRILL.md`; evidence rows G2-01 … G2-22 in `INCREMENT-B-G2-G3-EVIDENCE-CHECKLIST.md` §2; progress in `G2-EXECUTION-LOG.md` |
| Next action             | Step 1 of the guide ("Set up the session, guards and helpers"). It connects to nothing and asks for no password. Send the two output lines (dump file path, evidence directory) for review before Step 2      |
| What it changes         | Creates a dump file outside the repository. Creates, fills and drops the scratch database `ecommerce_restore_check`. Reads `ecommerce_dev`; never writes to it                                                |
| Evidence to capture     | Per step, as the guide lists: dump exists, size, SHA-256, exit code 0, completion marker, guard scan clean, source and scratch object counts reconciled, source unchanged, scratch dropped                    |
| Do not expose           | The admin password (typed only at the prompt), the dump file, any connection string                                                                                                                           |
| Success                 | Every evidence row G2-01 … G2-22 complete and consistent; reconciliation "match"; `ecommerce_dev` unchanged. Then **your** recorded decision "G2 ACCEPTED"                                                    |
| Failure                 | A line starting `G2 STOP:`, a non-zero exit, a missing or empty dump, no completion marker, `CREATE DATABASE` or `USE` found by the guard scan, the scratch database already existing, a count mismatch       |
| Stopping safely         | Stop at once. Keep the evidence folder. Do not restore into `ecommerce_dev`, do not change the target, do not retry. Report the failing step; a new drill starts only after review                            |

## 2. G3 — restricted database identity

| Aspect                  | Detail                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state           | Not accepted. Procedure v1.2.1 independently reviewed. Not executed                                                                                                                                                                                                                                                                    |
| Prerequisites           | Your **separate explicit approval of the exact privileged operation**; fresh read-only preconditions taken immediately before execution. G3 can be prepared independently of G2, but G7 needs both                                                                                                                                     |
| Authoritative documents | `INCREMENT-B-G3-CASE-A-EXECUTION-PROCEDURE.md` v1.2.1 (privileged execution: §2 preconditions, §3 SQL-mode gate, §4 SQL payload, §5 PowerShell procedure, §6 read-only verification, §7 partial failure); `INCREMENT-B-G3-MIGRATION-CONNECTION.md` (migration configuration); evidence rows G3-01 … G3-15 in the evidence checklist §3 |
| What it changes         | Creates one MySQL user and grants it the approved privilege set on `` `ecommerce_dev`.* `` only. Creates the git-ignored migration environment file (you create it; its contents are never shared)                                                                                                                                     |
| Evidence to capture     | Redacted `SHOW GRANTS` showing the approved set on `ecommerce_dev.*` only; proof that the runtime user `ecommerce_app` is unchanged; the migration file exists with no byte-order mark; the offline guard passes and the wrong-target test aborts                                                                                      |
| Do not expose           | The new user's password; the admin password; the contents of the migration environment file; any authentication clause in `SHOW GRANTS`                                                                                                                                                                                                |
| Success                 | Exact privilege scope confirmed, nothing global, no `GRANT OPTION`, `ecommerce_app` unchanged, guard fail-closed. Then your recorded decision "G3 ACCEPTED". **G3 acceptance does not authorize G7 or G8**                                                                                                                             |
| Failure                 | Any precondition or stop condition; the identity already exists; any privilege outside the approved list; `*.*`; a change to `ecommerce_app`; an ambiguous result                                                                                                                                                                      |
| Stopping safely         | Stop. Capture read-only evidence only. No automatic cleanup, retry, drop or grant correction: any corrective privileged action needs a separate review and approval (procedure §7)                                                                                                                                                     |

## 3. G7 — baseline migration on the scratch database

| Aspect                  | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current state           | Not started. Not authorized                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Prerequisites           | **G2 ACCEPTED, G3 ACCEPTED, F5 READY** (ask the assistant to prepare the F5 readiness report from your evidence; you decide it). The reviewed baseline SQL with the confirmed SHA-256 recorded in the roadmap. The scratch database `ecommerce_migrate_test` created by you and confirmed empty. A temporary grant for the migration identity on that scratch database only. The migration configuration targeting `ecommerce_migrate_test`. Then your **explicit G7 authorization** |
| Authoritative documents | `INCREMENT-B-MASTER-ROADMAP-G2-G8.md` "Gate G7"; `INCREMENT-B-G7-READINESS-REVIEW.md` §4 (pre-flight: target-name check, target guard, hash check, status, then deploy); evidence checklist §3.1                                                                                                                                                                                                                                                                                     |
| What it changes         | The scratch database only                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Evidence to capture     | Proof of the target (`MIGRATION_EXPECTED_DATABASE=ecommerce_migrate_test` and the actual target); the empty pre-state; redacted command outputs; post-state objects, constraints and migration history; probe results; confirmation that `ecommerce_dev` did not change; revocation of the scratch grant                                                                                                                                                                             |
| Do not expose           | The migration connection URL; the contents of the migration environment file                                                                                                                                                                                                                                                                                                                                                                                                         |
| Success                 | Baseline applied to `ecommerce_migrate_test` only, all verifications and probes pass. Then your recorded decision "G7 PASS". **G7 PASS does not authorize G8**                                                                                                                                                                                                                                                                                                                       |
| Failure                 | Target or hash mismatch; an unexpected pending migration; a connection or command error; a failed probe; any sign that another database was touched                                                                                                                                                                                                                                                                                                                                  |
| Stopping safely         | Stop. No retry, reset, drop or re-create. Never "fix" an access error by pointing the configuration at a database the identity can already reach. Keep the evidence; nothing is applied to `ecommerce_dev`                                                                                                                                                                                                                                                                           |

## 4. G8 — baseline migration on `ecommerce_dev`

| Aspect                  | Detail                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state           | Not started. Not authorized                                                                                                                                                                                                                                                                                          |
| Prerequisites           | **G7 PASS**. A **fresh** backup of `ecommerce_dev` taken and verified (repeat the G2 method). The scratch grant revoked. The migration configuration switched to `ecommerce_dev` and its target verified without sharing contents. Then your **explicit G8 authorization, stating that G8 modifies `ecommerce_dev`** |
| Authoritative documents | Roadmap "Gate G8"; `INCREMENT-B-G7-READINESS-REVIEW.md` §5                                                                                                                                                                                                                                                           |
| What it changes         | The schema of `ecommerce_dev`                                                                                                                                                                                                                                                                                        |
| Evidence to capture     | The approval package (target, migration file and hash, expected object counts, backup evidence, exact command, success criteria, recovery); post-run migration history, objects and constraints, Prisma status, tests, health check, the runtime user still DML-only                                                 |
| Do not expose           | Connection URLs, environment-file contents, the backup file                                                                                                                                                                                                                                                          |
| Success                 | The approved baseline applied to `ecommerce_dev` only; every verification passes. Then your recorded decision "G8 PASS"                                                                                                                                                                                              |
| Failure                 | Any identity, target, hash or backup mismatch; a command failure; any unexpected schema or data change                                                                                                                                                                                                               |
| Stopping safely         | Stop immediately. Follow the reviewed recovery plan (restore from the pre-G8 backup). Never run an automatic reset or repair                                                                                                                                                                                         |

## 4b. Seed execution and the first Superadmin (after G8)

| Aspect              | Detail                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state       | Not authorized. **No step-by-step seed procedure document exists yet.** The package has the scripts `db:seed` and `cli:superadmin`; that is not a reviewed procedure                                                                                                |
| Prerequisites       | G8 PASS. A written seed procedure prepared by the assistant and approved by you (which seeds, in which order, with which identity, how to verify, how to undo). Your explicit authorization                                                                         |
| Known facts         | The notification-template seed is **not** wired into the seed index, because the template wording is not approved and every WhatsApp template is a draft. Seeds never overwrite existing template rows. The settings seed has not run, so code defaults apply today |
| Evidence to capture | Row counts per seeded table before and after; that a second run changes nothing; the Superadmin created (identifier only)                                                                                                                                           |
| Do not expose       | The Superadmin password or any reset link; connection URLs                                                                                                                                                                                                          |
| Success             | Expected rows present; a second run is a no-op; sign-in works for the Superadmin                                                                                                                                                                                    |
| Failure / stop      | Any error, any unexpected row count. Stop; do not delete rows by hand; report                                                                                                                                                                                       |

## 5. DEC-12 — real-MySQL concurrency tests

| Aspect                 | Detail                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state          | Harness prepared, never executed. DEC-12 not decided                                                                                                                                                                                                                      |
| Prerequisites          | Your DEC-12 authorization; G2, G3, F5 and G7 passed; an empty database named exactly `ecommerce_test` with the baseline applied; a test-only user with `SELECT, INSERT, UPDATE, DELETE` on that database and nothing else; the default suite green                        |
| Authoritative document | `tests/db/README.md` (nine steps). It is the only procedure                                                                                                                                                                                                               |
| Recommended order      | README Step 4 first (prove the guard refuses with no variables). Then one scenario at a time: TC-030, then **TC-041** (it decides the predicted coupon defect), then TC-048, TC-051, TC-045, TC-004. The README lists TC-041 later; running it second is a recommendation |
| What it changes        | Deletes and inserts rows **inside `ecommerce_test` only**. No schema change. `ecommerce_dev` is never involved                                                                                                                                                            |
| Evidence to capture    | The line `[DEC-12] guard passed: database "ecommerce_test", loopback host: true, …`; one `[DEC-12][TC-xxx] {…}` line per iteration; the Vitest summary; the MySQL version and isolation level from the preflight                                                          |
| Do not expose          | `DB_TEST_DATABASE_URL` (enter it with the hidden prompt in README Step 5; never echo it); the test user's password                                                                                                                                                        |
| Success                | Each scenario's invariants hold on every iteration. Then your acceptance of the evidence                                                                                                                                                                                  |
| Failure                | A failed assertion is a **finding**, not something to work around. It may be a product defect or a harness mistake; only the evidence lines tell which. The scenarios have never run, so expect to review the first run of each carefully                                 |
| Stopping safely        | Stop after the failing scenario. Keep its evidence lines. Do not weaken an assertion, raise an iteration count or re-run until green. Remove the session variables (README Step 9). If a run was interrupted, empty the database with the cleanup script as the test user |

_(Clarification 2026-11-27, row "Recommended order": the words "TC-041 (it decides the predicted coupon defect)" mean that TC-041 produces the evidence about the predicted coupon defect. TC-041 is an evidence-producing test scenario. It is not an owner decision and not an authorization mechanism. The owner makes any decision, including any coupon-hardening decision, after reviewing the TC-041 evidence. The execution sequence, prerequisites, authorization requirements and test procedure are unchanged.)_

**Update 2026-11-27 — DEC-12 is decided as an evidence requirement; execution is still not authorized.** The table above is kept as written.

- **Decided (owner, received 2026-11-27):** real MySQL verification is required for G4. The six scenarios (TC-004, TC-030, TC-041, TC-045, TC-048, TC-051) must pass against `ecommerce_test` and produce reviewable evidence before G4 acceptance. Failures must be investigated, classified and resolved through separately authorized work.
- **"Current state" row:** read "DEC-12 not decided" as the position before 2026-11-27. The harness is still prepared and never executed (status: PREPARED — NOT EXECUTED).
- **"Prerequisites" row:** "Your DEC-12 authorization" means your separate explicit authorization to run the scenarios. DEC-12 itself does not give it. The other prerequisites are unchanged: G2, G3, F5 and G7 passed; an empty `ecommerce_test` with the baseline applied; the test-only user.
- **Nothing in this runbook is authorized by DEC-12:** not G2 backup or restore, G3 migrator-user or privilege operations, the G7 scratch-database migration, the G8 migration against `ecommerce_dev`, the scenario run, seeds, or any database user, grant, schema or data change. Only the owner executes these procedures.
- **G2:** existing authorization and status unchanged (user execution in progress, not accepted). G2 is independent of DEC-12.
- **Iteration count:** not decided. Neither the harness default of 3 nor the testing-strategy values of 5 and 20 is selected. A separate decision is needed before the run.
- **"Recommended order" row:** still a recommendation only.
- **Coupon hardening:** NOT AUTHORIZED; to be considered separately after the TC-041 evidence has been reviewed. A passing or failing result does not authorize a code change.
- **Not part of DEC-12:** GST-15 (separate owner decision required), the proposed Batch 12 suite (open, not addressed), G8, seeds, staging and production database operations.
- **G7 PASS (clarification 2026-11-27):** G7 PASS is a prerequisite before any of the six scenarios is executed. G7 PASS alone does not authorize scenario execution: your separate explicit written authorization is also required.
- **TC-041 (clarification 2026-11-27):** TC-041 is the real-database evidence scenario for requirement FR-CPN-008 and its acceptance criterion AC-03. It has not been executed. Coupon hardening remains NOT AUTHORIZED until the TC-041 evidence has been reviewed and a separate owner decision is made.

## 6. Git push so that CI runs

| Aspect              | Detail                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state       | No CI run is recorded. The assistant has not run any Git command and has not looked at the remote                                                                                                                                                                                                                                                        |
| Important           | `.github/workflows/ci.yml` runs only on a **push to `main` or `develop`**, or on a **pull request that targets `main` or `develop`**. Pushing some other branch runs nothing. The safe route is a new branch plus a pull request                                                                                                                         |
| Prerequisites       | You have confirmed which remote repository is intended (`git remote -v`). The working tree has been reviewed by you. Local gates are green (they are, as of 2026-11-24)                                                                                                                                                                                  |
| Before committing   | 1. `git status` — read the full list. 2. Confirm no environment file is staged or untracked-but-not-ignored: `git check-ignore -v .env` must print a rule; `.env.migration` likewise. 3. `git diff --cached --name-only` after staging — the list must contain no `.env*` file other than the `*.example` templates, no dump, no `coverage/`, no `dist/` |
| Steps               | Create a branch; commit; push the branch; open a pull request to `develop` (or `main`). Do not push directly to `main`                                                                                                                                                                                                                                   |
| Evidence to capture | The pull-request link, the run link of workflow "CI (ecommerce-api)", job `quality`, its result, and the Node version it printed (22.x)                                                                                                                                                                                                                  |
| Do not expose       | Nothing secret belongs in the commit. CI uses placeholders only; do not add repository secrets for this run                                                                                                                                                                                                                                              |
| Success             | Job `quality` green on Node 22: `prisma validate`, `prisma generate`, `format:check`, `lint`, `typecheck`, `build`, `openapi:check`, `npm test`                                                                                                                                                                                                          |
| Failure             | A red step. Possible causes, not yet observed: a Node 22 difference (local runs use 24.12.0), or line endings on Linux in `format:check`                                                                                                                                                                                                                 |
| Stopping safely     | Leave the pull request open and unmerged. Copy the failing step's log (it contains no secrets). Do not force-push, do not rewrite history, do not disable a check. If a secret was committed by mistake: stop, do not push further, rotate that secret, and ask before any history rewrite                                                               |

## 7. `npm audit`

| Aspect              | Detail                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current state       | Last recorded 2026-11-19: production dependencies 0 findings, development dependencies 8 moderate. Not re-run since (it needs the network)           |
| Prerequisites       | Network access to the npm registry; `npm ci` already done                                                                                            |
| Commands            | `npm audit --omit=dev` (what ships) and `npm audit` (everything). Read-only                                                                          |
| Evidence to capture | Date, Node and npm versions, the count by severity for each command, and the advisory identifiers for anything high or critical                      |
| Do not expose       | Nothing sensitive is produced                                                                                                                        |
| Success             | No high or critical finding in production dependencies. Development-only moderates are recorded and reviewed                                         |
| Failure             | A high or critical finding in a production dependency. Treat it as a defect to classify under D-62                                                   |
| Stopping safely     | **Do not run `npm audit fix`, and never `--force`.** Any fix changes `package.json` or the lockfile and needs your authorization and a full gate run |

## 8. Hosting selection and staging

| Aspect                  | Detail                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current state           | DEC-08 open. No staging environment exists                                                                                                                                                                                                                                                                                                 |
| Prerequisites           | Your DEC-08 choice (comparison: `PHASE4-REMAINING-USER-DECISIONS.md` §4). For a database-backed staging: the migration path proven (steps 1–4) and a seed procedure (4b)                                                                                                                                                                   |
| Authoritative documents | `operations/CI-CD-AND-DEPLOYMENT-PREPARATION.md` §3 (environment variables), §4 (staging prerequisites), §7 (pre-deployment checklist, eight groups); `operations/DEPLOYMENT_AND_OPERATIONS.md` (process model, start commands)                                                                                                            |
| Rules that must hold    | One API instance and **exactly one** worker (no lock exists). `NODE_ENV=staging`. Both webhook secrets set (unset means public test values). A deliberate decision on `PASSWORD_PEPPER` before the first accounts. Managed-database backups switched on. The Dockerfile is a scaffold that has never been built: review it before using it |
| Evidence to capture     | The completed §7 checklist; health-check responses; the worker's start line and heartbeat; one smoke test per §7.7; the backup configuration                                                                                                                                                                                               |
| Do not expose           | Every secret value. Record variable **names** and "set / not set" only                                                                                                                                                                                                                                                                     |
| Success                 | Readiness returns 200; the worker logs its heartbeat; the smoke tests pass; a restore from a staging backup has been rehearsed                                                                                                                                                                                                             |
| Failure                 | The process exits at start-up naming a variable (a configuration error); readiness returns 503; two workers running                                                                                                                                                                                                                        |
| Stopping safely         | Stop the worker first, then the API. Do not point staging at `ecommerce_dev` or at any database with real data. Staging uses the mock payment gateway: never take real orders on it                                                                                                                                                        |

## 9. Client written approval of G4

| Aspect              | Detail                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisites       | G4 criteria 1–4 each closed with evidence or an approved deferral (`PHASE4-G4-CRITERIA-AND-EVIDENCE-MATRIX.md`)                                                                                                                                 |
| What to present     | The evidence matrix; the master completion report; the approved deferral list; the accepted security self-assessment; the defect register with severities; the statement that all test evidence is mocked unless the real-database run was done |
| Evidence to capture | A dated, signed or e-mailed written approval naming Phase 4 / Gate G4 and the list of accepted deferrals and known limitations                                                                                                                  |
| Do not expose       | No credentials or environment contents in the package                                                                                                                                                                                           |
| Success             | Written approval received and filed; only then may Phase 4 be recorded as approved                                                                                                                                                              |
| Failure             | Approval withheld or conditional. Record the conditions as open items; Phase 4 stays IN PROGRESS — NOT APPROVED                                                                                                                                 |

## 10. Final production release approval

This is **not** a Phase 4 step and cannot be given now. It is listed so that it is not confused
with G4.

| Aspect                                | Detail                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preconditions that do not exist today | A real payment provider (only the mock exists); real e-mail, WhatsApp, courier and media providers; a refund-recovery action tested against the provider; backups with a rehearsed restore; monitoring and alerting; a CI history on the supported Node line; user-acceptance testing; legal and tax sign-off                        |
| Authoritative documents               | `IMPLEMENTATION_ROADMAP.md` (later phases and their gates); `TESTING_STRATEGY.md` release criteria ("0 open S1/S2", sign-off by the client product owner, tax professional and legal)                                                                                                                                                |
| Until then                            | Production readiness is NOT ESTABLISHED. No production environment should be started. _(Updated 2026-11-24: the refusal of the mock payment provider in production was removed from the list above; it was implemented under D1 and is tested with mocks. A production process now exits at start-up until a real provider exists.)_ |
