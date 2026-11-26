# Deployment

CI (`.github/workflows/ci.yml`) tests every pull request. Pushing a `vX.Y.Z` tag runs `release.yml`, which builds the
API and web images, pushes them to GHCR with an SBOM and provenance, and prints their digests. **No workflow deploys.**
A person runs the steps below with an approved change record.

## 1. Change record (before anything else)

- Version tag and the two image digests from the release job summary.
- What changes for users, which migrations run (`packages/db/migrations/`), and whether any are not backward compatible.
- Approver: for production, Kunal (or the person he names). Record the approval in the change before step 3.
- Rollback plan: the previous digests, and whether the migrations allow running the previous image (see step 5).

## 2. Staging

1. Deploy the same digests to staging with production-like settings (`NODE_ENV=production`).
2. The API refuses to start with unsafe settings and lists each problem. Fix the configuration, never the check.
3. Run `pnpm --filter @s360/web e2e` against staging with a staging test account, and `pnpm --filter @s360/api load-test`
   against staging only (never production). Attach both results to the change record.

## Container layout

Production runs `deploy/docker-compose.prod.yml` ([deploy/README.md](../../deploy/README.md)): the `supply-360` NGINX
proxy is the only container on the external `publicweb` network, routes `/api/` to the API and everything else to the
web app, and no container publishes a port. Containers talk over the private `supply` network.

## 3. Production (only with the recorded approval)

1. Take a backup: `scripts/backup.sh` (see [backup-restore.md](backup-restore.md)). Note the file name in the change.
2. Run migrations once, as the owner role: the `migrate` container (`node packages/db/dist/migrate.js` with
   `DATABASE_ADMIN_URL`). Migrations are forward-only and idempotent.
3. Roll the API: start new instances, wait for `GET /api/v1/health/ready` to answer 200, then drain old ones.
   The scheduler takes a Postgres advisory lock, so only one instance runs ticks at a time during the overlap.
4. Roll the web app the same way (`GET /login` answers 200).
5. Check: `/api/v1/health` reports the new version; `s360_http_requests_total{status=~"5.."}` stays flat;
   `s360_scheduler_last_success_timestamp_seconds` advances within two scheduler intervals.

## Required production settings

`NODE_ENV=production`, `COOKIE_SECURE=true`, `PARTICIPATION_TOKEN_SECRET` (32+ chars, separate from the session secret), https `WEB_ORIGIN` and `PUBLIC_BASE_URL`, `DATABASE_URL` as the
`s360_api` login role (member of `s360_app`, so row-level security applies), `DATABASE_ADMIN_URL` only for the migrate
job and scripts, `SESSION_SECRET` (32+ chars), `FIELD_ENCRYPTION_KEY` (32 bytes, base64), `METRICS_TOKEN` (32+
chars), `LOGIN_RATE_LIMIT` 30 or less, `TRUST_PROXY_HOPS` equal to the number of proxies in front of the API (2 with
the edge proxy and supply-360). Put the web app behind TLS and forward `X-Forwarded-Proto: https` so HSTS and
`upgrade-insecure-requests` are sent.

## 4. Rollback

- Image only: redeploy the previous digests. Every migration so far only adds tables, columns and policies, so the
  previous image runs against the newer schema.
- Data damage: stop the API, restore the step 3.1 backup into a new database ([backup-restore.md](backup-restore.md)),
  point `DATABASE_URL` at it, start the previous image. Record what was lost between backup and restore.
