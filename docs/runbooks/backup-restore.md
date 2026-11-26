# Backup and restore

## Backups

`scripts/backup.sh` takes a custom-format, zstd-compressed `pg_dump` as the owner role (`DATABASE_ADMIN_URL`; the app
role would only see what row-level security allows), writes a `.sha256` beside it and checks the archive lists.
Run it nightly and before every production deployment; keep 30 daily and 12 monthly copies in storage that the
database hosts cannot delete. Use the `pg_dump` that matches the server's major version (18); run it in the
`postgres:18` image when the host's client is older.

If the managed database offers point-in-time recovery, keep it on as well; the dumps are the portable copy.

## Restore

`scripts/restore.sh` only restores into a new, empty database and refuses anything else:

```
createdb supply360_restore
TARGET_ADMIN_URL=postgres://owner@host/supply360_restore scripts/restore.sh backups/supply360-<stamp>.dump
```

It verifies the checksum, creates the `s360_app` role if the cluster lacks it, restores, and prints row counts and the
number of tables with row-level security. Then run migrations (idempotent) and grant `s360_app` to the login role.

## Drill

Quarterly, restore the latest nightly backup into a scratch database and compare counts with production.
Drill on 2026-11-26 (local Postgres 18.7): backup of 2.1 MB in 0.4 s; restore in 0.9 s; tenants 2/2, projects 8/8,
audit_logs 3,226/3,226 matched the source; 33 tables with row-level security; migrations re-ran cleanly; a second
restore into the now non-empty database was refused.
