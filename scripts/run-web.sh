#!/usr/bin/env bash
# systemd ExecStart for k13-web: React web portal
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
load_k13_env

cd "$BASE_DIR"

# Ensure common binary search paths are available in systemd
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -d "${HOME:-}/.nvm" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

WEB_PORT="$(env_get WEB_PORT 3000)"
WEB_HOST="$(env_get WEB_HOST 0.0.0.0)"

# Check if Node / npm is installed
if ! command -v npm >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  die "Node.js and npm are required to run k13-web. Install via: sudo apt-get install -y nodejs npm"
fi

# If node_modules does not exist, run npm install
if [[ ! -d "$BASE_DIR/node_modules" ]]; then
  log "Installing frontend dependencies..."
  npm install
fi

# Prefer local vite binary directly if available
VITE_BIN="$BASE_DIR/node_modules/.bin/vite"
if [[ -x "$VITE_BIN" ]]; then
  exec "$VITE_BIN" --host "$WEB_HOST" --port "$WEB_PORT"
else
  exec npx vite --host "$WEB_HOST" --port "$WEB_PORT"
fi
