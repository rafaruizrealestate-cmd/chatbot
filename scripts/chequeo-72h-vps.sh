#!/usr/bin/env bash
# Pegar en el VPS (root@srv1536508) dentro de Cursor.
set -euo pipefail
cd /opt/whatsapp-chatbot
HOURS=72 bash scripts/audit-vps.sh 2>&1 | tee /tmp/audit-72h.log
echo ""
echo "=== Mensajes al cliente con comercial (72h) ==="
sqlite3 -header -column ./data/chatbot.db "
SELECT datetime(timestamp) AS at, phone_number, length(content) AS chars,
       substr(content, 1, 500) AS message
FROM conversations
WHERE timestamp >= datetime('now', '-72 hours')
  AND role = 'assistant'
  AND (
    lower(content) LIKE '%tu comercial es%'
    OR lower(content) LIKE '%contactará%'
    OR lower(content) LIKE '%contactara%'
    OR lower(content) LIKE '%se pondrá en contacto%'
    OR content LIKE '%Leo IA :)%'
    OR content LIKE 'Si tienes alguna duda o quieres concretar%'
  )
ORDER BY timestamp DESC
LIMIT 25;
"
echo ""
echo "=== CHEQUEO_72H_FIN ==="
