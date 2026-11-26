# Operations

## Health

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /api/v1/health/live` | The process answers | Liveness probe: restart if it fails |
| `GET /api/v1/health/ready` | The database answers within 2 s (503 otherwise) | Readiness probe and load balancer |
| `GET /api/v1/health` | Status, database and version | People and dashboards |

## Metrics

`GET /api/v1/metrics` serves Prometheus text when called with `Authorization: Bearer $METRICS_TOKEN`; without the
token it answers 401, and with no token configured it answers 404. The supply-360 proxy never serves it publicly;
scrape `http://api:4000/api/v1/metrics` from the `supply` network. Route labels are route patterns
(`/api/v1/projects/:id`), never raw paths, so ids never become label values.

| Metric | Alert when |
|---|---|
| `s360_http_requests_total{status}` | 5xx above 1% of requests for 5 minutes |
| `s360_http_request_duration_seconds` | p95 above 500 ms for 10 minutes |
| `s360_scheduler_runs_total{result}` | any `failed`, or `tenant_error` on three runs in a row |
| `s360_scheduler_last_success_timestamp_seconds` | older than 5 × `DISPATCH_TICK_SECONDS` |
| `s360_process_*`, `s360_nodejs_*` | resident memory or event loop lag rising steadily |

## Logs

Production logs are one JSON object per line (`LOG_FORMAT=json`, the production default) with the `supply360-api`
context. Every request has an `x-correlation-id`, which the audit log stores too; search by it to follow one action
through the API, the audit log and the scheduler. Logs never contain secrets, tokens, respondent refs or answers.

## Scheduler

One instance at a time runs the scheduler (Postgres advisory lock). Each pass, per active tenant: due invitation
batches and reminders, fieldwork ticks, reconciliation every `RECONCILE_MINUTES`, delivery forecasts once an hour per
active project, and expiry of report files older than 24 hours. `DISPATCH_TICK_SECONDS=0` turns it off (use that on
extra instances only if you want to be explicit; the lock already makes it safe).

## Scaling

The API is stateless (sessions are rows in Postgres), so add instances behind the load balancer. The measured
single-box numbers are in [../production/performance.md](../production/performance.md). Postgres is the limit first:
watch connection count (each instance's pool is 10) and slow queries before adding API instances.

## Routine

- Daily: check the alerts above are quiet and the nightly backup exists with its `.sha256`.
- Weekly: `pnpm audit` on `main` (CI also fails pull requests on moderate or worse advisories).
- Quarterly: restore drill ([backup-restore.md](backup-restore.md)) and review of tenant admins and service tokens.
