#!/usr/bin/env bash
# Runs once when the Codespace is created. Keeps the image build out of the
# critical path by installing dsh from npm instead of building the monorepo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_VERSION="${DSH_VERSION:-latest}"

echo "[setup] repo: $REPO_ROOT"
echo "[setup] installing @deepseek-ai/dsh@${DSH_VERSION}"

npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" --no-fund --no-audit

# cloudflared: outbound tunnel so the Worker does not depend on GitHub's
# port-forwarding visibility, which resets to private on every restart.
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL -o /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
fi
cloudflared --version

mkdir -p /workspaces/scratch
cat > /workspaces/scratch/.gitignore <<'EOF'
*
!.gitignore
EOF

# Warm the profile so the first real run does not pay template setup cost.
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" dsh --profile headless --help >/dev/null 2>&1 || true

echo "[setup] dsh: $(dsh --version 2>/dev/null || echo unknown)"
echo "[setup] done"
