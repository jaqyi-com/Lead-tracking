#!/usr/bin/env bash
# Nightly logical backup on top of the managed provider's PITR. Encrypted, sent offsite.
#   DATABASE_URL=... BACKUP_BUCKET=s3://... AGE_RECIPIENT=age1... ./backup.sh
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="/tmp/lead_os-$STAMP.dump"
pg_dump --format=custom --no-owner "$DATABASE_URL" -f "$FILE"
age -r "$AGE_RECIPIENT" -o "$FILE.age" "$FILE"
aws s3 cp "$FILE.age" "$BACKUP_BUCKET/lead_os-$STAMP.dump.age" --only-show-errors
rm -f "$FILE" "$FILE.age"
echo "backup $STAMP uploaded"
# Restore drill (do this on staging before go-live — Phase 5 gate):
#   age -d -i key.txt lead_os-<stamp>.dump.age > x.dump && pg_restore --clean --no-owner -d "$STAGING_DATABASE_URL" x.dump
