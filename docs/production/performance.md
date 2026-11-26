# Performance report

All numbers are measured with `pnpm --filter @s360/api load-test` on one 4-core sandbox with the API and Postgres 18
on the same machine, the per-address rate limits raised for the run (`LOGIN_RATE_LIMIT=1000
API_RATE_LIMIT=10000000`) and the scheduler off. They are a baseline for comparing phases, not a capacity promise
for production hardware. No number here is estimated.

## Phase 8 run (2026-11-26, with metrics middleware and production hardening on)

Sign-in with MFA, 19 at once: p50 1,160 ms, p95 1,289 ms (Argon2id password hashing is deliberately slow).

Mixed API traffic (dashboards, projects, fieldwork, forecasts, Copilot):

| Users | req/s | Requests | Errors | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|
| 10 | 347 | 5,216 | 0 | 22.9 | 69.5 | 125.6 |
| 50 | 385 | 5,841 | 0 | 91.5 | 479.5 | 792.4 |
| 100 | 366 | 5,603 | 0 | 222.5 | 768.4 | 1,102.8 |

Respondent click path (2,275 invitations; batches of up to 5,000 sent in 398 / 282 / 240 ms):

| Users | req/s | Requests | Errors | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|
| 10 | 570 | 8,554 | 0 | 16.4 | 26.9 | 35.0 |
| 50 | 549 | 8,259 | 0 | 86.7 | 124.5 | 149.6 |
| 100 | 533 | 8,061 | 0 | 185.5 | 234.8 | 262.4 |

Signed SampTrek S2S callbacks (80%) with fieldwork reads (20%):

| Users | req/s | Requests | Errors | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|
| 10 | 445 | 6,682 | 0 | 19.0 | 43.1 | 55.3 |
| 50 | 428 | 6,451 | 0 | 111.4 | 165.2 | 191.6 |
| 100 | 432 | 6,551 | 0 | 225.9 | 286.5 | 303.2 |

## Trend across phases (mixed traffic, req/s at 10 / 50 / 100 users, 0 errors in every run)

| Phase | Mix | req/s |
|---|---|---|
| 1 | Platform reads | about 740 |
| 2 | + SampTrek ingestion | about 650 |
| 3 | + audience and quotas | about 425 to 450 |
| 6 | + SampIntel link | 333 to 403 |
| 7 | + forecasts and Copilot | 347 / 387 / 381 |
| 8 | Same as 7, hardening on | 347 / 385 / 366 |

The click path held 500 to 580 req/s from Phase 4 to Phase 8, and callbacks 414 to 468 req/s from Phase 5.
Phase 8's metrics middleware and production checks cost nothing measurable against Phase 7.

## What limits it, and what to do at scale

- The API and Postgres share 4 cores here, so throughput flattens past 50 users and latency grows with queueing.
  Separate database hardware and more API instances (the API is stateless) are the first steps.
- Reserve and release on one project are serialised by the project row lock (about 21 pairs/s). That is by design so
  quotas cannot be oversold; spread load across projects rather than lifting the lock.
- Mixed-traffic p95 at 100 users (768 ms) is above the 500 ms alert threshold in operations.md on this box. Re-measure
  on production-sized hardware in staging before setting service levels.
