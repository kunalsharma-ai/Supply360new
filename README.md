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

After the mix it also runs the click path on its own (Phase 4) and SampTrek's signed S2S callbacks with live
fieldwork reads (Phase 5).

## Phase 2: SampTrek project ingestion

- **Sources** (`/sources`, screen _SampTrek Integration_): a connection is FIXTURE (labelled sample projects shaped
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

## Phase 3: audience and quotas from MADP

- **MADP connection** (`/integrations/madp`): FIXTURE uses a labelled DEMO population of 6,000 fictional people across
  Turn2Opinion, MFR and MHO, many in more than one panel. LIVE calls MADP's Supply360 service API with its exact
  signing (`x-madp-client`, `x-madp-timestamp`, `x-madp-nonce`, `x-madp-signature: v1=…`), a fresh nonce per call and an
  `idempotency-key` on reservations. The client secret is sealed at rest. LIVE has only been run against a local stub
  that verifies signatures the way MADP does, because no service client has been issued yet.
- **Audience Finder, Filter and Segments** (`/audience/*`): counts from MADP. Supply360 plans with `uniquePeople`, which
  counts a person in two panels once; memberships are shown beside it, never added up. Special-category (health)
  attributes are never offered and are refused by the API.
- **Quota cells** come from SampTrek's `GET /projects/{ref}/quotas` for Supply360's own markets; a market without cells
  gets one whole-market cell. A person maps each cell to MADP criteria with exactly one panel (MADP issues one reference
  per panel membership, so one panel per project keeps anyone from being invited twice). A change to a cell's conditions at
  SampTrek clears its mapping.
- **Allocation** (`/allocation`): proportional, equal or manual split of Supply360's market target per SampTrek group, and a
  cap on people held per cell.
- **Reservations** (`/quotas`): MADP match then reserve, under the project row lock, so concurrent requests never hold more
  than a cell's cap; a unique (project, reference) index means one reference is never held twice. Every selection is kept
  as an immutable snapshot. Launch and Resume now need every open cell mapped and holding people.
- Known MADP gaps: no attribute values list, no nested filter groups, no person-level key in match, no dispatch or
  delivery callbacks yet.

## Phase 4: invitations, reminders, scheduling, router and execution modes

- **Execution policy** (`/automation`): per project, a person sets the mode (manual, semi-automatic, automatic), batch
  size, daily maximum, review interval, quiet hours in a time zone, reminder times, allowed panels, link validity and
  the refusal level at which automation escalates. Nothing has a default value: no policy, no sending. Automatic mode
  needs `execution.approve`. Changing the mode cancels batches the system proposed under the old mode and keeps every
  invitation, reminder and audit record.
- **Batches** (`/invitations`, `/schedule`): every send happens under the project row lock and rechecks, in order, the
  tenant emergency stop, the project and market (live here and at SampTrek, entry link approved), the cell, quiet hours,
  the daily maximum and MADP consent, then authorises with MADP (`invitations/authorize`, idempotency key per request).
  One invitation per MADP reference per project (unique index). Hand-off to delivery is a second step with an
  idempotency key per invitation, so a crash or a concurrent send never sends twice. People MADP refuses leave the hold.
- **Delivery**: MADP has no send endpoint yet. FIXTURE uses a labelled DEMO channel that sends nothing anywhere. LIVE
  answers "unavailable", so the batch stops as blocked, a person is notified, and automation stops proposing.
- **Reminders** (`/reminders`): planned at send time from the policy, only for people who have not clicked. Each one locks
  its invitation row and rechecks the project, quiet hours and consent; a click locks the same row and cancels every
  pending reminder, so a click and a reminder can never both win.
- **Survey router** (`GET /api/v1/i/{tenant}/{token}`, `/router`): the token is 44 URL-safe characters (invitation id and
  an HMAC), carries no personal data and is never stored. Link scanners (HEAD, no user agent, known gateways) are
  recorded as prefetch, never as clicks. A click goes to the approved entry link with the token as SampTrek's `[UID]`;
  expired, closed and forged links go to plain pages. Clicks reach MADP through an outbox (`participation/events`, event
  id per click).
- **Scheduler**: every `DISPATCH_TICK_SECONDS` (advisory lock, one instance at a time) it runs semi-automatic and
  automatic planning, due batches, due reminders and the click outbox.
- **Emergency stop**: `PUT /execution/kill-switch` (`execution.emergency_stop`) halts all sending and reminders for the
  tenant until lifted.

## Phase 5: participation, live fieldwork, quality, reconciliation, rewards, recontact and reinvite

- **Outcomes only from verified sources.** SampTrek's vendor S2S callback (`GET /api/v1/s2s/samptrek/{tenant}/{connection}?uid={uid}&status={status}`,
  shown on the source as its callback URL template) is verified with the vendor callback secret: hex HMAC-SHA256 of
  `{X-Projexa-Timestamp}.{full URL}.{body}`, within 5 minutes. A LIVE connection needs SampTrek's secret pasted in
  (`PUT /sources/{id}/callback-secret`); a bad signature is a 401 and counted on the connection. SampTrek's sessions API
  (`GET /projects/{ref}/sessions`, scope `sessions:read`) is the source of record at reconciliation. A click is never a
  start, and an outcome never invents a start time. Revenue and payout in sessions are dropped.
- **Participation events** (`/participation`) are append-only, one per dedupe key, applied under the invitation row
  lock: retries, replays and two sources reporting the same thing never count twice, in any order. The first final
  outcome sticks; a partial gives way to a final one; a disagreeing callback only raises a flag, while the sessions API
  overrides and flags. Outcomes and starts go to MADP through an outbox (`participation/events`, stable event ids), and
  any outcome cancels pending reminders.
- **Send stops**: the send-time checks now also stop at the field end date, when a cell has its allocation of
  completes, and when Supply360's vendor target in a market is reached.
- **Live, IR and LOI** (`/live`, `/ir`, `/loi`): funnel, outcomes, per-market and per-cell progress. Incidence is
  completes ÷ (completes + terminates), with quota fulls and security outcomes shown beside it. LOI uses only start
  times a source reported.
- **Quality** (`/quality`): speeders (under the policy's `speederPercent` of the expected LOI), disagreeing sources,
  SampTrek duplicate or security outcomes, and client decisions on non-completes are flagged for a person to accept or
  dismiss with a reason. A flag never rejects anyone.
- **Reconciliation** (`/reconciliation`): pulls the project's sessions, fills what callbacks missed, applies the
  client's final approve or reject, and stores the differences (unverified at source, mismatches, missing at source,
  unknown respondents). Idempotent; the scheduler also reconciles live projects every `RECONCILE_MINUTES` (default 30).
- **Rewards** (`/rewards`): one reward event per client-approved complete, idempotency key `s360-reward-{invitation}`.
  FIXTURE MADP acknowledges it and credits nothing. LIVE answers "unavailable": MADP has no reward endpoint, and
  Supply360 never credits a wallet.
- **Recontact** (`/invitations/recontact`): find people who took part before by when (a week, a month, a year back or a
  custom range), earlier project, outcome, client approval and market, then pick them one by one or select everyone
  matching, and hold them for a quota cell of another project through MADP (`origin = recontact`). Only people on the
  cell's panel and in its market qualify, never anyone already invited to the project, never past the cell's cap. They
  are then invited by that project's mode, so automatic mode mails them within its limits.
- **Reinvite**: people who did not finish (never opened, never started, started without an outcome, partial, technical
  error) can be picked or selected by kind and sent their same link again. Every reinvite rechecks the emergency stop,
  the project, cell, quiet hours, the daily maximum and MADP consent; each person at most 3 times, a day apart. Final
  outcomes are never reinvited. MADP still has no send endpoint, so LIVE reinvites stop safely as unavailable.
- **FIXTURE simulators** (outside production): play a respondent (opens their link through the real router, then a
  signed callback through the real verification path) and play the client approving or rejecting completes.

## Phase 8: production readiness

- **Start-up guards:** with `NODE_ENV=production` the API refuses to start on unsafe settings and lists each one
  (insecure cookies, http origins, example values, the owner database role, load-test rate limits, a missing
  `PARTICIPATION_TOKEN_SECRET`).
- **Health and metrics:** `/api/v1/health/live`, `/api/v1/health/ready` (503 without the database), and Prometheus
  metrics at `/api/v1/metrics` behind `METRICS_TOKEN`. JSON logs in production.
- **Web security headers:** per-request nonce Content-Security-Policy (`src/proxy.ts`), HSTS over https.
- **Data:** `scripts/backup.sh` and `scripts/restore.sh` (restore only into an empty database). Field encryption
  key rotation with `FIELD_ENCRYPTION_KEY_PREVIOUS` and `pnpm --filter @s360/api rotate:reseal`.
- **Release:** pushing a `vX.Y.Z` tag builds and pushes images with SBOM and provenance. Nothing deploys
  automatically.
- **Docs:** [runbooks](docs/runbooks/README.md) and [production reports](docs/production/readiness-checklist.md)
  (readiness checklist, security review, accessibility, performance).

## Production containers

`deploy/docker-compose.prod.yml`: the `supply-360` NGINX proxy routes `/api/` to the API and the rest to the web app; no
container publishes a port; containers talk over the private `supply` network and only the proxy joins the external
`publicweb` network. See [deploy/README.md](deploy/README.md).
