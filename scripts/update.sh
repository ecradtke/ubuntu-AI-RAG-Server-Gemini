#!/usr/bin/env bash
# Pull the latest code, install Node.js deps, refresh units, and restart services.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
cd "$BASE_DIR"

log "Pulling latest code..."
git pull --ff-only

log "Updating web dependencies and building React portal..."
if command -v npm >/dev/null 2>&1; then
  npm install
  npm run build || true
else
  warn "npm not found. Please install Node.js: sudo apt-get install -y nodejs npm"
fi

"$BASE_DIR/scripts/install.sh" --units-only
sudo systemctl restart k13-web.service
sudo systemctl try-restart k13-qdrant.service
ok "Updated. Check with: ./scripts/k13ctl.sh status"
