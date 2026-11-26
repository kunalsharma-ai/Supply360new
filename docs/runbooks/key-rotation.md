# Key rotation

Rotate on schedule (yearly), when someone with access leaves, or at once when a value may have leaked.

## Field encryption key (`FIELD_ENCRYPTION_KEY`)

It seals TOTP secrets, SampTrek API keys and webhook and callback secrets, MADP client secrets and SampIntel service
tokens (AES-256-GCM with a per-value context). The API opens values with the current key and then
`FIELD_ENCRYPTION_KEY_PREVIOUS`, so rotation needs no downtime:

1. Generate a key: `openssl rand -base64 32`. Store it in the secret manager.
2. Deploy with `FIELD_ENCRYPTION_KEY=<new>` and `FIELD_ENCRYPTION_KEY_PREVIOUS=<old>`. New values seal with the new key;
   old values still open.
3. Re-seal every stored value, as the owner role:
   `DATABASE_ADMIN_URL=... FIELD_ENCRYPTION_KEY=<new> FIELD_ENCRYPTION_KEY_PREVIOUS=<old> pnpm --filter @s360/api rotate:reseal`.
   It runs in one transaction, prints counts per column, and is safe to run twice. If any value opens with neither key
   it stops and changes nothing.
4. Deploy without `FIELD_ENCRYPTION_KEY_PREVIOUS`. Destroy the old key once backups sealed with it have aged out.

Drill (2026-11-26, restored copy of the local database): 21 TOTP secrets, 2 webhook secrets and 2 callback secrets
re-sealed; a second run re-sealed 0; every value then opened with the new key alone.

## Session secret (`SESSION_SECRET`)

Changing it signs everyone out. Participation links are signed with `PARTICIPATION_TOKEN_SECRET`, or with
`SESSION_SECRET` when that is unset, so in that case rotating it also breaks every invitation link already sent.
Set `PARTICIPATION_TOKEN_SECRET` explicitly in production so the two can be rotated separately, and rotate the
participation key only between fieldwork windows.

## Metrics token (`METRICS_TOKEN`)

Update the Prometheus scrape config and the API together; there is no overlap window, so expect one missed scrape.

## Integration secrets

- **SampTrek webhook secret:** `POST /sources/:id/rotate-secret` returns the new secret once; give it to SampTrek's
  team and watch the webhook inbox for accepted deliveries.
- **SampTrek API key, MADP client secret, SampIntel service token:** issue a new one with the owning system, save it
  on the connection page in Supply360 (it is sealed at once), then revoke the old one there.
