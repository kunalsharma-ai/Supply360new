# Security review (Phase 8)

Scope: the Supply360 API and web app on `main` plus the Phase 8 branch. Method: review of each control against the
Phase 0 threat model ([../phase0/04-threat-model.md](../phase0/04-threat-model.md)), automated tests, and the browser
checks. Not in scope: infrastructure that does not exist yet (network, WAF, secret manager) and an external
penetration test, which should follow before go-live.

## Controls and how they are checked

| Threat | Control | Checked by |
|---|---|---|
| Cross-tenant data access | Postgres row-level security keyed on `app.tenant_id` for every tenant table; requests run as `s360_app` member role; production refuses an owner role | Integration tests per module; config tests |
| Session theft | httpOnly, SameSite=Strict, Secure cookies; sessions stored server-side and revocable; 12 h TTL | Platform tests |
| CSRF | SameSite=Strict plus a required custom header on writes | Platform test "refuses writes without the CSRF header" |
| Credential stuffing | Per-address sign-in throttle (production cap 30/min), account lockout, mandatory TOTP MFA | Platform tests |
| XSS | React escaping; nonce-based CSP with `strict-dynamic`, no inline script without the nonce; API answers with `default-src 'none'` | e2e CSP checks |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` | e2e CSP check |
| Forged webhooks and callbacks | HMAC signatures with timestamps and replay windows (SampTrek), MADP request signing, idempotency keys | Ingestion and fieldwork tests |
| Secrets at rest | AES-256-GCM with per-value context; key rotation with re-seal | Sealer unit tests; rotation drill |
| Secrets in transit or logs | Secrets returned once at creation, never in logs or audit details; metrics labels are route patterns | Code review; metrics test checks no ids in labels |
| Spreadsheet formula injection | Export cells that start with `= + - @` are neutralised | Report render tests |
| Survey fraud and fabricated outcomes | Supply360 never fabricates dispositions or credits rewards; synthetic QA never counts in human quotas, IR, rewards, invoices or delivery; Copilot refuses proxy, antidetect, CAPTCHA and IP rotation requests and runs no SQL or commands | SampIntel link tests; Copilot parser tests |
| Unapproved sends | Manual mode by default, emergency stop, `synthetic_qa_only` projects blocked at the send gate | Execution tests |
| Vulnerable dependencies | Exact pinned versions; `pnpm audit` clean; CI audit job | CI |
| Supply chain of images | Images built only from tags, with SBOM and provenance | Release workflow |

## Findings fixed in this phase

1. `uuid` below 11.1.1 through ExcelJS (GHSA-w5hq-g745-h8pq, moderate): overridden to 11.1.1; ExcelJS output
   checked.
2. `esbuild` 0.24 or older through drizzle-kit (GHSA-67mh-4wv8-2f99, moderate, development only): overridden to
   0.28.2; `drizzle-kit generate` checked.
3. The web app had no Content-Security-Policy: added a per-request nonce policy.
4. Production could start with a shared session and participation key: now refused.
5. No way to rotate the field encryption key without breaking sealed values: added previous-key support and a
   re-seal script.

## Open items

- External penetration test before go-live.
- `style-src 'unsafe-inline'` remains, because the UI library sets inline styles; scripts are fully nonce-bound.
- Secret manager integration (values are read from the environment today).
