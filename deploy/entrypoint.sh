#!/bin/sh
set -eu
if [ ! -s /run/secrets/dashboard_password_hash ]; then
  echo 'Dashboard password hash secret is missing.' >&2
  exit 1
fi
export DASHBOARD_PASSWORD_HASH="$(cat /run/secrets/dashboard_password_hash)"
# Keep Node as the direct init child so SIGTERM reaches its shutdown handler.
# Xvfb chooses an unused local display; its TCP listener remains disabled.
display_file=/tmp/autosocial-display-number
Xvfb -displayfd 3 -screen 0 1440x1000x24 -nolisten tcp 3>"$display_file" &
xvfb_pid=$!
attempts=0
while [ ! -s "$display_file" ]; do
  kill -0 "$xvfb_pid" || exit 1
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 50 ]; then echo 'Virtual display did not start.' >&2; exit 1; fi
  sleep 0.1
done
export DISPLAY=":$(cat "$display_file")"
exec node /app/src/dashboard-server.js
