#!/usr/bin/env bash
# Runs on every Codespace start. Starts the bridge, then exposes it through a
# Cloudflare quick tunnel and registers the resulting URL with the Worker.
# Idempotent: never leaves two bridges or two tunnels running.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=/tmp/dsh-bridge.log
TUNNEL_LOG=/tmp/cloudflared.log
WORKER_URL="${WORKER_URL:-https://dsh-remote.cnbill.workers.dev}"
PORT="${BRIDGE_PORT:-8788}"

# postStartCommand does not always receive Codespaces secret env vars; the
# same values are materialised in the shared env file, so fall back to it.
if [ -z "${BRIDGE_TOKEN:-}" ] && [ -f /workspaces/.codespaces/shared/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /workspaces/.codespaces/shared/.env
  set +a
fi

if [ -z "${BRIDGE_TOKEN:-}" ]; then
  echo "[bridge] BRIDGE_TOKEN is not set; refusing to start an unauthenticated listener" >&2
  exit 1
fi

mkdir -p "${DSH_WORKSPACE:-/workspaces/scratch}"

# ---- bridge ----
if pgrep -f "$REPO_ROOT/bridge/server.js" >/dev/null 2>&1; then
  echo "[bridge] already running"
else
  setsid nohup node "$REPO_ROOT/bridge/server.js" >>"$LOG" 2>&1 </dev/null &
  echo "[bridge] started (detached)"
fi

for _ in $(seq 1 30); do
  if curl -fsS -H "X-Token: ${BRIDGE_TOKEN}" "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "[bridge] healthy"
    break
  fi
  sleep 1
done

if ! curl -fsS -H "X-Token: ${BRIDGE_TOKEN}" "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[bridge] failed to become healthy; tail of $LOG:" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
fi

# ---- tunnel ----
if ! pgrep -f "cloudflared tunnel --url" >/dev/null 2>&1; then
  : >"$TUNNEL_LOG"
  setsid nohup cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate >>"$TUNNEL_LOG" 2>&1 </dev/null &
  echo "[tunnel] started (detached)"
fi

URL=""
for _ in $(seq 1 45); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "[tunnel] no public url; tail of $TUNNEL_LOG:" >&2
  tail -n 30 "$TUNNEL_LOG" >&2 || true
  exit 1
fi

echo "[tunnel] $URL"

for _ in $(seq 1 10); do
  if curl -fsS --max-time 10 -H "X-Token: ${BRIDGE_TOKEN}" "${URL}/health" >/dev/null 2>&1; then
    echo "[tunnel] reachable"
    break
  fi
  sleep 2
done

curl -fsS --max-time 15 -X POST \
  -H "X-Token: ${BRIDGE_TOKEN}" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"${URL}\"}" \
  "${WORKER_URL}/api/register" >/dev/null && echo "[tunnel] registered"
