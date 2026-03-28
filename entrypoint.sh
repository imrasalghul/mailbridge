#!/usr/bin/env bash
set -Eeuo pipefail

SPAMD_PID=""
MAILBRIDGE_PID=""
CLOUDFLARED_PID=""
SHUTTING_DOWN=0

log() {
  echo "[entrypoint] $*"
}

stop_pid() {
  local pid="${1:-}"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

stop_all() {
  stop_pid "$MAILBRIDGE_PID"
  stop_pid "$CLOUDFLARED_PID"
  stop_pid "$SPAMD_PID"

  wait "$MAILBRIDGE_PID" 2>/dev/null || true
  wait "$CLOUDFLARED_PID" 2>/dev/null || true
  wait "$SPAMD_PID" 2>/dev/null || true
}

graceful_shutdown() {
  SHUTTING_DOWN=1
  log "Shutdown requested, stopping processes"
  stop_all
  exit 0
}

trap graceful_shutdown SIGINT SIGTERM

log "Starting SpamAssassin"
spamd \
  --create-prefs \
  --helper-home-dir \
  --listen 127.0.0.1 \
  --max-children 5 \
  --port "${SPAMD_PORT:-783}" &
SPAMD_PID=$!

if [[ "${CLOUDFLARED_ENABLED:-false}" =~ ^([Tt][Rr][Uu][Ee]|1|[Yy][Ee][Ss])$ ]]; then
  if [[ -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]]; then
    echo "[entrypoint] CLOUDFLARED_ENABLED is true but CLOUDFLARED_TUNNEL_TOKEN is not set" >&2
    stop_all
    exit 1
  fi

  log "Starting cloudflared tunnel"
  cloudflared tunnel \
    --no-autoupdate \
    --loglevel "${CLOUDFLARED_LOGLEVEL:-info}" \
    run \
    --token "${CLOUDFLARED_TUNNEL_TOKEN}" &
  CLOUDFLARED_PID=$!
fi

log "Starting Mailbridge"
node server.js &
MAILBRIDGE_PID=$!

REQUIRED_PIDS=("$SPAMD_PID" "$MAILBRIDGE_PID")
if [[ -n "$CLOUDFLARED_PID" ]]; then
  REQUIRED_PIDS+=("$CLOUDFLARED_PID")
fi

while true; do
  set +e
  wait -n "${REQUIRED_PIDS[@]}"
  EXIT_CODE=$?
  set -e

  if [[ "$SHUTTING_DOWN" -eq 1 ]]; then
    exit 0
  fi

  EXITED_PID=""
  for pid in "${REQUIRED_PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      EXITED_PID="$pid"
      break
    fi
  done

  if [[ -n "$EXITED_PID" ]]; then
    echo "[entrypoint] Required process $EXITED_PID exited with status $EXIT_CODE" >&2
  else
    echo "[entrypoint] A required process exited with status $EXIT_CODE" >&2
  fi

  stop_all
  exit "${EXIT_CODE:-1}"
done
