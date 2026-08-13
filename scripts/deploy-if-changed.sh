#!/usr/bin/env bash
# Cron en el VPS: detecta pushes a origin/main y ejecuta deploy-vps-remote.sh.
set -euo pipefail
cd /opt/whatsapp-chatbot
git fetch origin main -q
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" == "$REMOTE" ]]; then
  exit 0
fi
echo "$(date -Is) auto-deploy: ${LOCAL:0:7} -> ${REMOTE:0:7}"
exec bash scripts/deploy-vps-remote.sh
