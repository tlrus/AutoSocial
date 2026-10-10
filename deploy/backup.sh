#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Briefly quiesce the sole writer to avoid mixed JSON/media snapshots.
was_running="$(docker compose ps --status running -q autosocial)"
docker compose stop autosocial
resume() {
  if [ -n "$was_running" ]; then docker compose start autosocial >/dev/null; fi
}
trap resume EXIT
docker compose --profile ops run --rm --no-deps backup
# No automatic deletion. Copy encrypted backups off this server when a destination is approved.
