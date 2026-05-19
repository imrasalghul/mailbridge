#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

SPAMD_PID=""
MAILBRIDGE_PID=""
CLOUDFLARED_PID=""
SHUTTING_DOWN=0
SPAMASSASSIN_MODE="${SPAMASSASSIN_MODE:-local}"

log() {
  echo "[entrypoint] $*"
}

wait_for_spamd() {
  local host="${SPAMD_HOST:-127.0.0.1}"
  local port="${SPAMD_PORT:-783}"
  local attempts="${SPAMD_STARTUP_ATTEMPTS:-30}"

  for attempt in $(seq 1 "$attempts"); do
    if timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"; printf "PING SPAMC/1.5\r\n\r\n" >&3; IFS= read -r response <&3; [[ "$response" == SPAMD/* ]]' _ "$host" "$port" 2>/dev/null; then
      log "SpamAssassin is accepting connections on ${host}:${port}"
      return 0
    fi

    if ! kill -0 "$SPAMD_PID" 2>/dev/null; then
      echo "[entrypoint] SpamAssassin exited before accepting connections" >&2
      return 1
    fi

    log "Waiting for SpamAssassin on ${host}:${port} (${attempt}/${attempts})"
    sleep 1
  done

  echo "[entrypoint] SpamAssassin did not accept connections on ${host}:${port} after ${attempts}s" >&2
  return 1
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

mkdir -p "${DATA_DIR:-/app/data}" "${DATA_DIR:-/app/data}/queue" "$(dirname "${SECRETS_DB_PATH:-/app/secrets/secrets.db}")"

resolve_spamd_bin() {
  if [[ -n "${SPAMD_BIN:-}" ]] && [[ -x "${SPAMD_BIN}" ]]; then
    printf '%s\n' "${SPAMD_BIN}"
    return 0
  fi

  if command -v spamd >/dev/null 2>&1; then
    command -v spamd
    return 0
  fi

  if [[ -x /usr/sbin/spamd ]]; then
    printf '%s\n' "/usr/sbin/spamd"
    return 0
  fi

  return 1
}

case "${SPAMASSASSIN_MODE}" in
  local)
    if ! SPAMD_BIN="$(resolve_spamd_bin)"; then
      echo "[entrypoint] spamd was not found in PATH or /usr/sbin. Verify the image includes the SpamAssassin daemon." >&2
      exit 127
    fi

    log "Starting SpamAssassin"
    "${SPAMD_BIN}" \
      --create-prefs \
      --helper-home-dir \
      --listen 127.0.0.1 \
      --max-children 5 \
      --syslog=stderr \
      --port "${SPAMD_PORT:-783}" &
    SPAMD_PID=$!

    if ! wait_for_spamd; then
      stop_all
      exit 1
    fi
    ;;
  postmark)
    log "Using Postmark SpamCheck for SpamAssassin scoring; local spamd will not be started"
    ;;
  *)
    echo "[entrypoint] Unsupported SPAMASSASSIN_MODE=${SPAMASSASSIN_MODE}. Use local or postmark." >&2
    exit 2
    ;;
esac

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

REQUIRED_PIDS=("$MAILBRIDGE_PID")
if [[ -n "$SPAMD_PID" ]]; then
  REQUIRED_PIDS+=("$SPAMD_PID")
fi
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
