# Supply360

Human sample supply and fieldwork automation for the Sampledge ecosystem. Supply360 imports projects from SampTrek,
finds and selects audiences through MADP (the source of truth for people, consent and rewards), runs invitations and
reminders in manual, semi-automatic or automatic mode, tracks participation, and reconciles results. It never stores
names, contact details, answers or health data: only opaque audience references, counts and operational events.

SampIntel AI (authorized synthetic survey QA) is a separate application in its own repository.

> **Status: Phase 1 (foundations).** Tenants, sign-in with required two-step verification, eleven roles, row-level
> tenant isolation, an append-only audit log, settings, notifications, the design system with four themes and the app
> shell. No source system is connected yet; modules from later phases open a status page instead of a mock.
> Plan and traceability: [`docs/phase0/05-plan-and-traceability.md`](docs/phase0/05-plan-and-traceability.md).

## Quick start

Requirements: Node 26.13.1 LTS, pnpm 12.23.0, Docker (or PostgreSQL 18 and Redis 8).

```bash
cp .env.example .env                       # fill every CHANGE-ME (commands for secrets are in the file)
docker compose up -d postgres redis
pnpm install
pnpm build
# one-time: the API's login role (row-level security applies to it)
docker compose exec postgres psql -U postgres -d supply360 -c "create role s360_api login password '<S360_API_DB_PASSWORD>'"
pnpm db:migrate
docker compose exec postgres psql -U postgres -d supply360 -c "grant s360_app to s360_api"
pnpm db:seed:demo                          # optional: DEMO tenant `demo`, one fictional account per role
pnpm dev                                   # web http://localhost:3000 · API http://localhost:4000/api/v1
```

Sign in to the DEMO workspace as `tenant_admin@demo.example.invalid` with `S360_DEMO_PASSWORD`. The first sign-in
asks you to enrol an authenticator app. For a real workspace:

```bash
S360_ADMIN_PASSWORD='a-long-password-1' pnpm --filter @s360/api tenant:create \
  --slug acme --name "Acme Research" --admin-email you@acme.example --admin-name "Your Name"
```

Everything in containers: `docker compose --profile app up --build`.

## Tests

```bash
pnpm test                 # unit: role matrix, sealing, theme contrast, module registry
pnpm test:integration     # API against real Postgres; each run creates and drops its own database
pnpm --filter @s360/web e2e   # browser test + axe accessibility on a running stack (E2E_PASSWORD=…)
```

The integration suite covers the spec's acceptance test "tenant A cannot access tenant B data" through the API and
directly in the database, plus MFA, lockout, session revocation, role escalation and the append-only audit log.

## Layout

```
apps/api            NestJS 12 API (auth, users, audit, settings, notifications), OpenAPI at /api/v1/openapi.json
apps/web            Next.js 16 App Router, Tailwind 4, Radix, cmdk; four themes; e2e/smoke.mjs
packages/contracts  zod schemas: roles and permissions, auth, users, problem details (single source of API types)
packages/db         Drizzle schema, SQL migrations (0001_rls.sql = row-level security), tenant-scoped transactions
docs/phase0         Audit, integration capability matrix, ADRs, threat model, plan and module traceability
```

## Security model (Phase 1)

- The API connects as a role in `s360_app`, which is not a table owner, so Postgres row-level security filters every
  tenant table by `app.tenant_id`, set per transaction from the signed session. Missing tenant = no rows.
- `tenants` is read-only for the app; tenants are created only by the `tenant:create` CLI with the owner role.
- Two-step sign-in is required; TOTP secrets are sealed with AES-256-GCM; a code is accepted once.
- Session cookie: httpOnly, SameSite=Strict, holds only a signed session id; revocation is immediate.
- Writes require the `x-s360-csrf` header. Errors are RFC 9457 problem details with a correlation id.

## Versions

Pinned exactly, latest stable as of 2026-11-25, no prereleases. See ADR-002 in
[`docs/phase0/03-architecture-and-adrs.md`](docs/phase0/03-architecture-and-adrs.md). Prisma was not used because its
`latest` tag is a release candidate.
