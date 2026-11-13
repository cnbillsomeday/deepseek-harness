#!/usr/bin/env bash
# Runs once when the Codespace is created. Keeps the image build out of the
# critical path by installing dsh from npm instead of building the monorepo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_VERSION="${DSH_VERSION:-latest}"

echo "[setup] repo: $REPO_ROOT"
echo "[setup] installing @deepseek-ai/dsh@${DSH_VERSION}"

npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" --no-fund --no-audit

mkdir -p /workspaces/scratch
cat > /workspaces/scratch/.gitignore <<'EOF'
*
!.gitignore
EOF

# Warm the profile so the first real run does not pay template setup cost.
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" dsh --profile headless --help >/dev/null 2>&1 || true

echo "[setup] dsh: $(dsh --version 2>/dev/null || echo unknown)"
echo "[setup] done"
