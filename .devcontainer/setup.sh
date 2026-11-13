#!/usr/bin/env bash
# Runs once when the Codespace is created. Keeps the image build out of the
# critical path by installing dsh from npm instead of building the monorepo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_VERSION="${DSH_VERSION:-latest}"

echo "[setup] repo: $REPO_ROOT"
echo "[setup] node: $(node -v) npm: $(npm -v)"
echo "[setup] installing @deepseek-ai/dsh@${DSH_VERSION}"

SUDO=""
if [ "$(id -u)" != "0" ]; then
  SUDO="sudo"
fi

$SUDO npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  --no-fund --no-audit

# cloudflared: outbound tunnel so the Worker does not depend on GitHub's
# port-forwarding visibility, which resets to private on every restart.
if ! command -v cloudflared >/dev/null 2>&1; then
  $SUDO curl -fsSL -o /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  $SUDO chmod +x /usr/local/bin/cloudflared
fi
cloudflared --version

mkdir -p "${DSH_WORKSPACE:-/workspaces/scratch}"
cat > "${DSH_WORKSPACE:-/workspaces/scratch}/.gitignore" <<'EOF'
*
!.gitignore
EOF

# Pick the model this deployment talks to. The relay is OpenAI/Anthropic
# compatible but the model id is not in dsh's built-in catalog, so pin it.
MODEL_ID="${DSH_MODEL:-deepseek-v4.1-flash}"
mkdir -p "$HOME/.dsh/profiles/headless"
cat > "$HOME/.dsh/profiles/headless/cordis.patch.yml" <<YAML
- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${MODEL_ID}
YAML
echo "[setup] model: ${MODEL_ID}"

# Warm the profile so the first real run does not pay template setup cost.
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" dsh --profile headless --help >/dev/null 2>&1 || true

echo "[setup] dsh: $(dsh --version 2>/dev/null || echo unknown)"
echo "[setup] done"
