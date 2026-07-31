#!/bin/sh
set -e

# Empty volume (new machine, or the volume died): pull the latest replica first.
# Fly refuses to boot the machine if the volume fails to mount, so a missing
# file here really is an empty volume, not a missing mount.
if [ ! -f "$DATABASE_PATH" ]; then
  echo "DATABASE MISSING at $DATABASE_PATH - restoring from R2 replica" >&2
  litestream restore -if-replica-exists "$DATABASE_PATH"
fi

exec litestream replicate -exec "node build"
