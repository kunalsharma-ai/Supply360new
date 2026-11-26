#!/usr/bin/env bash
# Logical backup of the Supply360 database. Custom format, compressed, with a sha256 next to it.
# Usage: DATABASE_ADMIN_URL=postgres://... scripts/backup.sh [out-dir]
# Run it as the admin role: RLS hides rows from the app role, so a backup taken as s360_api would be partial.
set -euo pipefail
: "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL (the owner role, not the app role)}"
out="${1:-./backups}"
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out/supply360-$stamp.dump"
pg_dump --format=custom --compress=zstd:6 --no-owner --no-privileges --file="$file" "$DATABASE_ADMIN_URL"
sha256sum "$file" > "$file.sha256"
# Check that the archive is readable before calling it a backup.
pg_restore --list "$file" > /dev/null
echo "backup ok: $file ($(du -h "$file" | cut -f1))"
