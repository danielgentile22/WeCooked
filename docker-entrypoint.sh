#!/bin/sh
set -e

# Empty volume (new machine, or the volume died): pull the latest replica first.
if [ ! -f "$DATABASE_PATH" ]; then
  litestream restore -if-replica-exists "$DATABASE_PATH"
fi

exec litestream replicate -exec "node build"
