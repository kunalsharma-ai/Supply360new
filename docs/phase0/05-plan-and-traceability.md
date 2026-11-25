# Phase 0 · Implementation plan and requirements traceability

## Plan (vertical slices; each phase ends with a report of what is built, tests, blockers)

| Phase                  | Supply360                                                                                                                                                                       | SampIntel AI                                                                                                                 | Gate before moving on                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1 Foundations          | Monorepo, Docker Compose (Postgres, Redis, Temporal, OIDC), tenants/users/roles, RLS, audit log, design system with 4 themes, shell (sidebar, command palette, breadcrumbs), CI | Same foundation, separate repo and DB                                                                                        | Cross-tenant tests and CI green                                          |
| 2 Ingestion            | SampTrek adapter (FIXTURE + LIVE), signed inbox, polling/backfill, project versions, lifecycle state machine, launch validation, redirect endpoints                             | —                                                                                                                            | Duplicate webhook → one project; source pause stops dispatch             |
| 3 Audience             | MADP client (HMAC), metadata-driven filter builder, counts, unique vs memberships, selection snapshots, quotas, reservations, allocation editor                                 | —                                                                                                                            | Overlap counts once; concurrent reservations never oversupply            |
| 4 Dispatch             | Invitation batches, tokens, reminders (Temporal timers), manual/semi/auto modes, approvals, kill switches, FIXTURE delivery adapter                                             | —                                                                                                                            | Click cancels reminders incl. concurrent jobs; consent withdrawal blocks |
| 5 Events & recon       | Participation event log, live funnel (SSE), IR/LOI, quality flags, reconciliation, reward events (proposed MADP API)                                                            | —                                                                                                                            | Out-of-order/duplicate events don't inflate; recon/rewards idempotent    |
| 6 SampIntel            | Supply360 "Human / Synthetic / Both separate" toggle via scoped API                                                                                                             | Authorization Centre, scenarios, execution engine, synthetic engine, model gateway + budgets, IP intelligence, audits, Excel | Revoked auth stops QA; unapproved URL blocked; budget enforced           |
| 7 Intelligence         | Copilot (typed queries), delivery predictions, automation policies, reports/exports                                                                                             | Regression/model comparison reports                                                                                          | Semi-auto approval enforced; exports labelled and safe                   |
| 8 Production readiness | Perf/load (targets agreed from real volumes), security review, a11y, runbooks, backup/restore drill, deployment docs                                                            | Same                                                                                                                         | No production deploy without Kunal's approval                            |

Every phase uses FIXTURE adapters for anything not yet verified live. Real invitations, external writes and
production deploys wait for Kunal's explicit approval.

## Traceability — Supply360 (35 modules)

| #   | Module                       | Phase                   | Depends on (source capability)                    | Status                      |
| --- | ---------------------------- | ----------------------- | ------------------------------------------------- | --------------------------- |
| 1   | Global Command Centre        | 1 shell, 5 data         | —                                                 | Planned                     |
| 2   | Super Admin                  | 1                       | —                                                 | Planned                     |
| 3   | Samptrek Integration         | 2                       | SampTrek public API + webhooks ✅, vendor link 🔶 | Planned                     |
| 4   | SampCloud Integration        | 2 (interface + fixture) | ⛔ repo not found                                 | Blocked                     |
| 5   | MADP Integration             | 3                       | MADP Supply360 API ✅ DEMO                        | Planned                     |
| 6   | Project Execution Centre     | 2, 4                    | —                                                 | Planned                     |
| 7   | Global Audience Finder       | 3                       | `counts`, `geo` ✅                                | Planned                     |
| 8   | Dynamic Audience Filter      | 3                       | attribute metadata 🔶, nested logic 🔶            | Planned (degrades)          |
| 9   | Audience Segmentation        | 3                       | `match` ✅                                        | Planned                     |
| 10  | AI Audience Intelligence     | 7                       | history from 5                                    | Planned                     |
| 11  | AI Delivery Intelligence     | 7                       | history from 5                                    | Planned                     |
| 12  | Smart Sample Allocation      | 3                       | —                                                 | Planned                     |
| 13  | Quota Management             | 3                       | SampTrek quotas ✅                                | Planned                     |
| 14  | Survey Invitation Engine     | 4                       | MADP dispatch ❌                                  | Planned (fixture delivery)  |
| 15  | Automatic Reminder Engine    | 4                       | MADP dispatch ❌                                  | Planned (fixture delivery)  |
| 16  | Scheduling Engine            | 4                       | —                                                 | Planned                     |
| 17  | Survey Router                | 4                       | SampTrek vendor link 🔶                           | Planned                     |
| 18  | Participation Tracker        | 5                       | S2S callbacks ✅                                  | Planned                     |
| 19  | Redirect Management          | 2                       | SampTrek redirects ✅                             | Planned                     |
| 20  | Live Fieldwork Monitoring    | 5                       | —                                                 | Planned                     |
| 21  | IR Intelligence              | 5                       | —                                                 | Planned                     |
| 22  | LOI Intelligence             | 5                       | —                                                 | Planned                     |
| 23  | Quality Intelligence         | 5                       | —                                                 | Planned                     |
| 24  | AI Supply Copilot            | 7                       | —                                                 | Planned                     |
| 25  | Workflow Automation          | 4, 7                    | —                                                 | Planned                     |
| 26  | SampIntel AI Integration     | 6                       | —                                                 | Planned                     |
| 27  | Project Reconciliation       | 5                       | SampTrek session approval ✅                      | Planned                     |
| 28  | Reward Event Synchronization | 5                       | MADP reward events ❌                             | Planned (proposed contract) |
| 29  | Reports and Analytics        | 7                       | —                                                 | Planned                     |
| 30  | Notifications Centre         | 1, 5                    | —                                                 | Planned                     |
| 31  | API and Webhook Management   | 2                       | —                                                 | Planned                     |
| 32  | User and Role Management     | 1                       | —                                                 | Planned                     |
| 33  | Security Centre              | 1, 8                    | —                                                 | Planned                     |
| 34  | Activity and Audit Logs      | 1                       | —                                                 | Planned                     |
| 35  | System Settings              | 1                       | —                                                 | Planned                     |

## Traceability — SampIntel AI (19 modules)

| #   | Module                        | Phase | Depends on                              | Status  |
| --- | ----------------------------- | ----- | --------------------------------------- | ------- |
| 1   | Super Admin                   | 1     | —                                       | Planned |
| 2   | Samptrek Integration          | 6     | SampTrek `projects:read`, test links ✅ | Planned |
| 3   | AI Execution Engine           | 6     | —                                       | Planned |
| 4   | Synthetic Data Engine         | 6     | —                                       | Planned |
| 5   | Gate Survey Manager           | 6     | SampTrek gate config (read)             | Planned |
| 6   | Client Survey Manager         | 6     | Authorization ❌ (built locally)        | Planned |
| 7   | Scheduling Engine             | 6     | —                                       | Planned |
| 8   | Interval Controller           | 6     | —                                       | Planned |
| 9   | IR Management                 | 6     | —                                       | Planned |
| 10  | LOI Monitoring                | 6     | —                                       | Planned |
| 11  | IP Intelligence               | 6     | permitted network metadata only         | Planned |
| 12  | Security Centre               | 1, 8  | —                                       | Planned |
| 13  | Response Audit                | 6     | —                                       | Planned |
| 14  | Quality Control               | 6     | —                                       | Planned |
| 15  | Excel Reporting               | 6     | —                                       | Planned |
| 16  | AI API Management             | 6     | provider keys (Kunal)                   | Planned |
| 17  | AI API Cost/Budget Management | 6     | —                                       | Planned |
| 18  | Authorization Centre          | 6     | —                                       | Planned |
| 19  | Activity Logs and Settings    | 1     | —                                       | Planned |

## Acceptance tests → phase

Duplicate webhook (2) · source pause (2) · new MADP attribute (3) · overlap unique (3) · consent withdrawal (4) ·
click cancels reminders (4) · out-of-order events (5) · concurrent reservations (3) · mode changes preserve records
(4) · semi-auto approval (4) · auto caps/escalation (4) · missing API pauses safely (2–4) · recon/rewards idempotent
(5) · tenant isolation (1) · synthetic isolation (6) · revoked auth (6) · unapproved URL (6) · model budget (6) ·
exports safe (7) · keyboard/mobile (1, 8) · backup restore (8).
