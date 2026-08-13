#!/usr/bin/env bash
set -euo pipefail
cd /opt/whatsapp-chatbot-951

cleanup() {
  systemctl start whatsapp-chatbot-951 2>/dev/null || true
}
trap cleanup EXIT

exec 200>/var/lock/whatsapp-chatbot-951-deploy.lock
flock -n 200 || { echo "Deploy Lara ya en curso; saliendo."; exit 0; }

systemctl stop whatsapp-chatbot-951 || true
for _ in 1 2 3 4 5; do
  systemctl is-active --quiet whatsapp-chatbot-951 && sleep 1 || break
done
sleep 1

git fetch origin
git reset --hard origin/main

if [ -d node_modules ]; then
  PREV="node_modules._deploy_$$"
  mv node_modules "$PREV"
  rm -rf "$PREV" &
fi
npm ci
npm run build
systemctl start whatsapp-chatbot-951
trap - EXIT

if grep -q '^SCRAPE_ENABLED=1' .env 2>/dev/null; then
  npm run scrape || echo "WARN: scrape falló; Lara sigue con catálogo anterior."
else
  echo "SCRAPE_ENABLED≠1: usando PROPERTIES_DATABASE_PATH compartido con Leo."
fi
