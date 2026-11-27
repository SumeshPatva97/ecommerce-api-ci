# Phase 4 Autonomous Completion Agent — Operating Instructions

| Field     | Value                                                                  |
| --------- | ---------------------------------------------------------------------- |
| Document  | P4-AGENT-01                                                            |
| Created   | 2026-11-20                                                             |
| Authority | Owner instruction "Phase 4 — Autonomous Completion Agent" (2026-11-20) |
| Nature    | Reusable instruction document. **Not a persistent agent** (see §1)     |

## 1. Capability statement

The Claude Code environment used for this project can start **task-scoped subagents** inside a
session. It cannot create a **persistent** agent that survives across sessions. No persistent agent
has been created.

This document is the agent definition. Any session (or subagent) continuing Phase 4 must:

1. read this document;
2. read the live status tracker `docs/PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`;
3. read the source-of-truth roadmap `docs/PHASE4-MASTER-COMPLETION-ROADMAP.md`;
4. resume from the "Next eligible tasks" list.

## 2. Sources of truth (no competing roadmap)

| Purpose                      | Document                                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task inventory and IDs       | `docs/PHASE4-MASTER-COMPLETION-ROADMAP.md` (P4-MASTER-ROADMAP-01)                                                                                                                                                                                                                      |
| Live status of those IDs     | `docs/PHASE4-AUTONOMOUS-COMPLETION-STATUS.md`                                                                                                                                                                                                                                          |
| Headline project status      | `docs/PHASE3-PHASE4-MASTER-PROGRESS-REPORT.md` §1                                                                                                                                                                                                                                      |
| Phase plan and G4 definition | `project-documentation/10-project-management/IMPLEMENTATION_ROADMAP.md` (Phase 4 rows). _(Canonical location, verified 2026-11-24. From 2026-11-21 until 2026-11-24 the file sat in `02-architecture/`; it was moved back on the owner's authorization and its content is unchanged.)_ |
| Open decisions               | `docs/PHASE4-REMAINING-DECISIONS.md` and roadmap §4-G                                                                                                                                                                                                                                  |
| Database gates               | `docs/INCREMENT-B-MASTER-ROADMAP-G2-G8.md`, `docs/G2-EXECUTION-LOG.md`                                                                                                                                                                                                                 |

New tasks are recorded in the status tracker with a reference to the roadmap ID they refine. They are
never added to a second roadmap.

## 3. Execution loop

1. Read the tracker and roadmap. Pick the highest-priority task whose dependencies are met.
2. Check authorization. Proceed only if the task is (a) already explicitly approved, or
   (b) documentation-only planning or evidence assembly, reversible, needing no new decision.
3. Read the relevant review / acceptance criteria and the current code.
4. Execute only the authorized scope.
5. Validate. Safe offline gates: `format:check`, `lint`, `typecheck`, `openapi:check`. Run tests and
   `build` only when the task authorizes code or test changes (they write caches / `dist`).
6. Verify the changed-file list (modification-time scan; Git is not authorized).
7. Write the task report (scope, files, tests, commands, results, limitations, deferrals, security
   impact, acceptance-criteria results).
8. Update the status tracker (and authoritative status documents only when the evidence supports it).
9. Continue with the next eligible task.

## 4. Mandatory stop-and-ask conditions (pause only the affected task)

- a new business or architecture decision;
- work beyond existing authorization (e.g. any Batch 10 implementation before DEC-04);
- destructive or irreversible operations;
- database, external-provider or production access;
- credentials, secrets or account permissions;
- user-only procedures (G2, G3, G7, G8, seeds, Git push / CI);
- any acceptance or approval (batches, gates, G4) — **these belong to the user only**;
- contradictory or insufficient evidence;
- a discovered security or data-integrity issue.

When asking, state:

- the exact decision;
- why it is needed;
- the options and their consequences;
- the recommendation;
- the blocked task.

Silence is never approval.

## 5. Hard boundaries

- **Secrets.** Never open, read, print, copy or modify `.env`, `.env.*` or other secret / credential
  files. Exclude them from searches. Do not investigate their timestamps.
- **Git.** No Git commands and no `.git` access, unless a specific Git task is authorized.
- **External systems.** No MySQL, Redis, gateways, couriers, SMTP, hosting or external accounts
  without task-specific authorization and safeguards.
- **Database.** No migrations, seeds, account or privilege changes.
- **Canonical documents.** Never run Prettier on `project-documentation/`; edit surgically and keep
  LF line endings.
- **Evidence.** Never mark a batch, gate or phase accepted or passed. Never treat mocked tests as
  MySQL, provider or production evidence. Never modify a file just to satisfy an expected count.
- **History.** Preserve historical reports; correct with dated notes.

## 6. Priorities (dependency order)

1. Batch 9 acceptance: present the risk acknowledgement; update status only after explicit user
   acceptance.
2. Batch 10:
   - technical review and proposal (done: `PHASE4-BATCH10-TECHNICAL-REVIEW-AND-PROPOSAL.md`);
   - implementation only after DEC-04.
3. Remaining decisions (roadmap §4-G): present each with a recommendation. Never implement an
   undecided item.
4. G4 evidence:
   - FR "Must" traceability (QA-02 / QA-03);
   - security self-assessment (SEC-01);
   - defect register (SEC-02, needs DEC-14);
   - deferral register (DEC-13);
   - runbook (DOC-09 / SEC-05);
   - refreshed G4 report (DOC-08).
5. Database gates G2 → G8: user-executed, one step at a time, evidence verified before any status
   change.
6. CI / staging: needs user authorization (Git push, hosting decision OQ-34).
7. Final G4 package (ACC-01): prepare only when its inputs exist. G4 approval is the user's alone.
