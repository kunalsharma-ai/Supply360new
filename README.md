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

## Load test

`apps/api/src/scripts/load-test.ts` creates a throwaway `loadtest-*` tenant with 20 Tenant Admin accounts, signs
them all in with MFA, then runs a weighted read/write mix (40% `/auth/me`, 20% `/users`, 20% `/audit`, 15%
`/notifications`, 5% `PUT /settings/tenant`) at several concurrency levels and prints throughput, errors, status
codes and p50/p95/p99 latency. It refuses to run with `NODE_ENV=production`.

```sh
# The API's per-address limits would (correctly) reject a single-machine load run, so raise them for this run only.
LOGIN_RATE_LIMIT=1000 API_RATE_LIMIT=10000000 pnpm --filter @s360/api start
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/supply360 \
  pnpm --filter @s360/api load-test -- --levels 10,50,100 --duration 15
```

Flags: `--base`, `--users`, `--levels`, `--duration`, `--json`.

## Phase 2: SampTrek project ingestion

- **Sources** (`/sources`, screen *SampTrek Integration*): a connection is FIXTURE (labelled sample projects shaped
  exactly like SampTrek's public API) or LIVE (`pjx_` key with `projects:read sessions:read quotas:read`, sealed at
  rest). Supply360 never calls SampTrek's write endpoints.
- **Polling and backfill**: `POST /sources/:id/sync` (`{"full":true}` for a backfill) and a poller every
  `SOURCE_POLL_SECONDS`, guarded by a Postgres advisory lock. The `updatedSince` checkpoint only moves after a clean run.
- **Signed webhooks**: `POST /api/v1/webhooks/samptrek/:tenant/:connection`, verified with SampTrek's
  `X-Projexa-Signature` (HMAC-SHA256 of `{timestamp}.{raw body}`, ±300 s). One inbox row per event id, so duplicates are
  counted and never reprocessed. Bad signatures are counted, not stored.
- **Versions**: a new project version is kept whenever the agreed content changes; progress counters update in place.
  Prices, other vendors' links and e-mail addresses are dropped on the way in.
- **Lifecycle**: `imported → ready → live ⇄ paused → closed`. SampTrek always wins: HOLD forces `source_hold`, CLOSED
  or INVOICED forces `closed`, and coming back from a hold lands on `paused`. Dispatch is allowed only when the project
  is `live` here and LIVE at SampTrek (`dispatchAllowed`). Launch checks need an approved entry link per market.
- **Redirects**: `GET /api/v1/r/:tenant/:project/:outcome?uid={respondent_uid}` for SampTrek's eight outcomes. The
  arrival is recorded as unverified and the respondent always lands on `/done/:outcome`, so it cannot be an open
  redirect.
- The demo seed creates a FIXTURE connection and imports its projects. It needs the same `FIELD_ENCRYPTION_KEY` as the
  API.
