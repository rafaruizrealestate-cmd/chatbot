#!/usr/bin/env bash
# Pegar en la sesión SSH del VPS (root@srv1536508) y pulsar Enter.
set -euo pipefail
cd /opt/whatsapp-chatbot
git fetch origin -q 2>/dev/null || true
git log -1 --oneline
if [[ -x scripts/audit-vps.sh ]]; then
  HOURS=350 bash scripts/audit-vps.sh 2>&1 | tee /tmp/audit-350h.log
else
  echo "WARN: scripts/audit-vps.sh no existe; git pull o despliega main"
  HOURS=350 DB=./data/chatbot.db
  sqlite3 -json "$DB" "SELECT datetime('now') AS now_utc, datetime('now', '-350 hours') AS since_utc;"
  sqlite3 -json "$DB" "SELECT role, COUNT(*) AS n FROM conversations WHERE timestamp >= datetime('now', '-350 hours') GROUP BY role;"
  sqlite3 -json "$DB" "SELECT COALESCE(origin,'(sin)') AS origin, intent, COUNT(*) AS n FROM lead_notifications WHERE created_at >= datetime('now', '-350 hours') GROUP BY origin, intent;"
fi
echo "=== LISTO: salida en /tmp/audit-350h.log ==="
