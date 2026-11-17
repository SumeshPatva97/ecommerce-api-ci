# Deployment & Operations (B0-c Scaffold)

**Status:** scaffold/in-progress documentation. Not a complete production runbook. Validate all steps in target environment.

## 1. Application

- Service: `ecommerce-api` (Node.js + Express, TypeScript build -> `dist/`)
- Health: `GET /health/live` (liveness), `GET /health/ready` (readiness; extend with DB/provider checks when implemented)
- Default port: `4000` (configurable via `PORT`)
- Process model: stateless HTTP API; background jobs TBD per approved architecture (Redis deferred D-38)

## 2. Configuration & secrets

- All config via environment variables validated in `src/core/config/env.ts`; see `.env.example`.
- **Never commit real credentials.** Use hosting secret manager / CI secrets (OQ-34 pending for final choices).
- Required (current): `NODE_ENV`, `APP_TIMEZONE=Asia/Kolkata`, `TZ=UTC`, `API_BASE_URL`, `STOREFRONT_URL`, `ADMIN_URL`, `CORS_ORIGINS`, `DATABASE_URL` (placeholder in dev; real secret in runtime).
- Future: JWT secrets/keys, provider keys (payment/email/WhatsApp/Cloudinary), webhook secrets, etc. — add only when implemented and documented.

## 3. Database (MySQL 8, Prisma)

- Access only via `ecommerce-api`/Prisma (approved architecture).
- B0-b Part 2 pending: install/configure MySQL 8, apply reviewed migrations (incl. SQL-only constraints/indexes), idempotent seeds, verify structures/constraints, test repeatability. **No migrations applied in repo yet.**
- Backups/recovery: define RPO/RTO, automate logical/physical backups, test restore drills, protect credentials, encrypt backups at rest/in transit per policy — **procedure to be executed/verified in B0-b Part 2+**.

## 4. Build & runtime

- Install: `npm ci`
- Build: `npm run build` (outputs `dist/`)
- Start: `node dist/server.js`
- Prisma: offline schema valid (`prisma validate`); generate client/migrations and wire runtime adapter in B0-b Part 2+.
- Dockerfile scaffold provided (`ecommerce-api/Dockerfile`); validate build/runtime, non-root, healthchecks, and secret injection before use.

## 5. CI

- Workflow scaffold: `.github/workflows/ci.yml` (format, lint, typecheck, build, test, offline `prisma validate`). Add DB service/integration/migration jobs when available.

## 6. Observability & logging

- Structured logging (pino) with request IDs and redaction in foundation; extend per-module logs/metrics/traces and error monitoring integration as implemented.
- Do not log secrets/PII/sensitive tokens.

## 7. Security operations (summary)

- Enforce HTTPS/TLS in non-local envs, least-privilege DB users, secret rotation, dependency monitoring, and incident response per approved security guidelines. See `SECURITY_SELF_ASSESSMENT.md`.

## 8. Rollback / change management

- Use versioned migrations (expand/contract), tested rollback/restore procedures, and staged deploys; do not perform destructive DB changes without backups and approval.
