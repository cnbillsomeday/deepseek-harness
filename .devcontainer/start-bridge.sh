#!/usr/bin/env bash
# Runs on every Codespace start. Idempotent: never leaves two bridges running.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=/tmp/dsh-bridge.log

if pgrep -f "$REPO_ROOT/bridge/server.js" >/dev/null 2>&1; then
  echo "[bridge] already running"
  exit 0
fi

if [ -z "${BRIDGE_TOKEN:-}" ]; then
  echo "[bridge] BRIDGE_TOKEN is not set; refusing to start an unauthenticated listener" >&2
  exit 1
fi

mkdir -p "${DSH_WORKSPACE:-/workspaces/scratch}"

nohup node "$REPO_ROOT/bridge/server.js" >>"$LOG" 2>&1 &
echo "[bridge] started pid=$! log=$LOG"

for _ in $(seq 1 30); do
  if curl -fsS -H "X-Token: ${BRIDGE_TOKEN}" "http://127.0.0.1:${BRIDGE_PORT:-8788}/health" >/dev/null 2>&1; then
    echo "[bridge] healthy"
    exit 0
  fi
  sleep 1
done

echo "[bridge] failed to become healthy; tail of $LOG:" >&2
tail -n 40 "$LOG" >&2 || true
exit 1
