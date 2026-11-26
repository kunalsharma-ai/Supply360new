# Production readiness checklist

Status on 2026-11-26 (Phase 8). "Done" means built and checked in this repository; "Needs owner" means it depends on
infrastructure or a decision outside the code. **Production has not been deployed.** That needs Kunal's approval
through [../runbooks/deployment.md](../runbooks/deployment.md).

| Area | Item | Status |
|---|---|---|
| Configuration | API refuses to start in production with unsafe settings (insecure cookie, http origins, example values, owner DB role, load-test rate limits, shared participation key) | Done |
| Configuration | Every setting documented in `.env.example` | Done |
| Health | `/health/live` and `/health/ready` (503 when the database is unreachable); compose healthcheck uses readiness | Done |
| Observability | Prometheus metrics behind a bearer token, route-pattern labels only; scheduler run, duration and last-success metrics | Done |
| Observability | JSON logs in production with correlation ids | Done |
| Observability | Alert rules and dashboards in the monitoring stack | Needs owner (thresholds are in operations.md) |
| Security | Nonce-based CSP, HSTS over https, frame denial, nosniff, referrer and permissions policies on the web app; strict CSP on the API | Done |
| Security | Row-level security on every tenant table, app role separate from owner role | Done (since Phase 1) |
| Security | Dependency audit clean; CI fails on moderate or worse advisories | Done |
| Security | Field encryption key rotation without downtime, drilled | Done |
| Security | External penetration test | Needs owner |
| Data | Backup and restore scripts, restore drill passed | Done |
| Data | Nightly backup schedule, off-host storage, point-in-time recovery | Needs owner |
| Release | Tag-only image build with SBOM and provenance; no automatic deploy | Done |
| Release | Staging environment matching production | Needs owner |
| Performance | Load checks every phase, measured numbers in performance.md | Done |
| Accessibility | axe (WCAG 2.0 A/AA and 2.2 AA) on 36 page states in the browser checks, keyboard navigation checks | Done |
| Accessibility | Manual screen reader pass (NVDA, VoiceOver) | Needs owner |
| Integrations | SampTrek and MADP LIVE adapters behind approval; FIXTURE data clearly labelled | Done |
| Integrations | MADP send-invitations endpoint | Blocked: MADP does not offer it yet, so live batches stop safely |
| Integrations | SampCloud | Blocked: repository location not provided |
| Runbooks | Deployment, operations, incidents, key rotation, backup and restore | Done |
