# Phase 0 · Repository audit (read-only)

Audited 2026-11-25 by shallow clone of each repository's default branch. Nothing was changed, built against live
systems, or deployed. "Verified" below means seen in source or in-repo documentation at the commit listed; nothing was
tested against a live deployment.

| Repository                                        | Commit                          | Stack seen                                                                                             | Role for Supply360 / SampIntel AI                                                                                                                                |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kunalsharma-ai/MADP`                             | `e613b0b`                       | NestJS 12, Drizzle + Postgres 18, MongoDB 8, Next.js 16, zod contracts, pnpm 12, Node 26.13.1          | **Source of truth** for people, consent, memberships, attributes, delivery and rewards. Already exposes a signed Supply360 service API (on DEMO data)            |
| `kunalsharma-ai/SampTrek` (formerly PROJEXA)      | `9990392`                       | NestJS 11, Prisma 6 on MongoDB, Next.js 15                                                             | **Project source**: projects, markets, quotas, vendor links, redirects, S2S callbacks, reconciliation                                                            |
| `kunalsharma-ai/turn2opinion`, `MFR`, `MHO`       | `040c9c8`, `05e5f9e`, `49cbc51` | Express/Mongoose panel backends (all three tenants run the T2O backend in production per MADP's audit) | Reached **only through MADP**. Supply360 never calls a panel directly                                                                                            |
| `kunalsharma-ai/supply360` (private)              | `b3ee764`                       | "Sampledge AI Research OS": NestJS 11 + Prisma 6 + MongoDB, Next.js 16, Tailwind 3                     | Earlier, much broader product (CRM, quotes, POs, invoices, vendor payments, client portal, newsletters). Most of it is **out of scope** under §2 of the new spec |
| `kunalsharma-ai/SampAudience` (formerly SAMPLEON) | `500b718`                       | Express + MongoDB                                                                                      | Earlier audience/invitation engine. Its role is what the new Supply360 spec describes; it predates MADP                                                          |
| **SampCloud**                                     | —                               | —                                                                                                      | **Not found** in the repositories this session can see. Blocked: needs a repo name or access                                                                     |

## 1. MADP (source of truth) — what exists

**Supply360 service API, `/api/v1/supply360/*`** (`docs/API_CONTRACTS.md` §4, `packages/contracts/src/supply360.ts`,
tested in `apps/api/test/supply360.test.ts` on DEMO data):

- Auth: per-client HMAC request signing (`x-madp-client`, `x-madp-timestamp` ±300 s, single-use `x-madp-nonce`,
  `x-madp-signature: v1=HMAC-SHA256(secret, "ts.nonce.METHOD.path.sha256(body)")`). Scopes, allowed panels,
  per-minute rate limit, `idempotency-key` on writes (same key + different body → 409). Refusals audited.
- `GET attributes` (categories and attribute keys; special-category keys only with `health.aggregate`).
- `POST counts` (unique people vs memberships, suppressed small cells, freshness, `dataMode`).
- `POST match` → pseudonymous `ref_…` per client, with exclusion counts; no refs below the minimum cell; health
  criteria refused. Applies active adult membership, terms, usable address, opt-out/bounce, contact caps and
  "held for another project".
- `POST/GET/DELETE reservations` (hold refs per project, ≤14 days, conflicting holds refused).
- `POST invitations/authorize` — re-checks each ref and **records** an invitation. **Sends nothing**.
- `POST participation/events` — `click, start, partial, complete, terminate, quota_full, quality_fail, duplicate,
security_reject, technical_error`; each `eventId` counts once. **Credits no rewards**.
- `POST consent/check` (`survey_invitation` | `email_marketing`), `GET integrations/health`.

**Filter model today:** `panels[]`, `categories[]`, `countries[]` (ISO-2), `verifiedEmailOnly`, and up to 10
`attributes: {key, values[]}` — AND across filters, OR within one filter. Panels are `t2o | mfr | mho`.

**Elsewhere in MADP (admin-session only, not service API):** communications templates/campaigns/automations with
frequency caps and quiet hours (`dryRun:false` returns 403 — nothing is ever sent), loyalty ledger and
`survey-approvals`, geo and overlap counts, consent and privacy centres.

**MADP status:** every panel connector is DEMO; no live panel has passed any acceptance column
(`docs/THREE_PANEL_ACCEPTANCE_MATRIX.md`). Live access blocked on per-panel credentials.

## 2. SampTrek (project source) — what exists

- **Public REST API** `/api/v1/public` with `pjx_` API keys and scopes `projects:read`, `projects:write`,
  `sessions:read`, `quotas:read` (`finance:read` exists; Supply360 must never request it). Cursor paging
  (`limit`≤200, `nextCursor`), `updatedSince` on projects, `outcomeSince` on sessions. 120 req/min per key, counted
  per process. OpenAPI at `/api/v1/public/openapi.json`.
- **Event webhooks** (HMAC `sha256=` of `ts.body`, stable event `id`, retries up to ~6 h): `session.completed`,
  `project.status_changed`, `alert.opened` (+ invoice/bill events we must not subscribe to).
- **Vendor model**: per-market vendor links with live/test entry links; opaque session tokens; 8 redirect statuses;
  macros `{uid} {status} {vendor_id} {country_code} {project_code}`; signed S2S vendor callbacks
  (`X-Idempotency-Key`, `X-Projexa-Signature`), retries and dead letter. **Supply360 can attach to a project as a
  SampTrek vendor** and receive verified outcomes through redirects + S2S callbacks without any SampTrek change.
- **SampAudience contract already in SampTrek** (`docs/SAMPLEON_INTEGRATION.md`): `project.created` event (signed,
  outbox, `Idempotency-Key`), `POST …/sampleon/audience-requests`, quota-cell → profile-attribute mapping, approved
  changes sync, progress events into `POST /api/v1/integrations/sampleon/events`
  (`X-Sampledge-Client/Timestamp/Signature v1`).
- Project status: `DRAFT, TEST, LIVE, HOLD, CLOSED, INVOICED`; per-market `DRAFT, TEST, LIVE, HOLD, CLOSED`;
  approval `PENDING, APPROVED, REJECTED, NOT_APPLICABLE`. Quota cells per market from gate/prescreener answers.

## 3. Panels (T2O, MFR, MHO)

Covered by MADP's audits (`MADP/docs/REPOSITORY_AUDIT_{T2O,MFR,MHO}.md`, `INTEGRATION_GAP_ANALYSIS.md`); I did not
re-audit them because the spec routes every panel interaction through MADP. Relevant findings that affect us:
no scoped service credential, no outbound webhooks, MHO answers are special-category, consent spread across fields.

## 4. Existing `supply360` and `SampAudience` repositories

Both overlap with the new spec but conflict with it: `supply360` contains finance, CRM, quotes, invoices, vendor
payments, client portal and newsletters (excluded by §2), runs MongoDB as the transactional store and Tailwind 3;
`SampAudience` was designed when "SUPPLY360" meant the panel system that MADP now replaces, and runs Express. I
recommend new repositories (ADR-001) and reusing only ideas and tests from them, not code wholesale.
**This is Decision D1 for Kunal.**

## 5. What this audit did not verify

- Any live endpoint, credential, tenant host or production volume. All throughput/SLO targets wait for real numbers.
- SampCloud in any form.
- Whether MADP's DEMO Supply360 API is deployed anywhere.
