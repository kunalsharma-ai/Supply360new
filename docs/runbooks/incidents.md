# Incidents

## Severity

| Sev | Example | Response |
|---|---|---|
| 1 | Invitations going to the wrong audience, data visible across tenants, production down | Act now, page the owner |
| 2 | Scheduler failing for a tenant, SampTrek webhooks rejected, reconciliation stuck | Same working day |
| 3 | One page broken, slow reports | Next planned release |

## First five minutes

1. **Stop harm before diagnosing.** For anything touching invitations, use the emergency stop on `/automation` (with a reason)
   (it is recorded in the audit log; nothing is sent until it is turned off, and nothing is deleted). For one project, pause it on its page.
2. Note the time, the tenant and a correlation id from the failing request or the audit log.
3. Check `/api/v1/health`, the 5xx rate and `s360_scheduler_last_success_timestamp_seconds`.

## Common cases

- **Database unreachable:** `/health/ready` answers 503 and the load balancer drains the instance. Check Postgres
  first; the API recovers by itself when the database answers again.
- **SampTrek webhooks rejected (401):** usually a rotated or mismatched signing secret. Compare the source's webhook
  inbox (`/sources/:id`) and rotate the secret with SampTrek's team if needed ([key-rotation.md](key-rotation.md)).
- **MADP refusing reservations:** Supply360 holds refs only through MADP and never edits panel data. Keep the project
  paused and raise it with the MADP owners.
- **Suspected cross-tenant exposure:** Sev 1. Halt affected tenants, keep logs and the audit trail, and do not delete
  rows. Row-level security is enforced in Postgres for the `s360_app` role; check `DATABASE_URL` is not an owner role.
- **Secret leaked:** rotate it now ([key-rotation.md](key-rotation.md)), then review the audit log for its use.

## Afterwards

Write a short review within five working days: timeline, impact (tenants, projects, invitations), cause, what stopped
it and the follow-up changes. Keep it free of respondent data.
