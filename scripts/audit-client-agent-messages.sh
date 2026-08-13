#!/usr/bin/env bash
# Mensajes de Leo AL CLIENTE (últimas N h) que mencionan comercial/teléfono/cierre de lead.
set -euo pipefail
HOURS="${HOURS:-48}"
ROOT="${ROOT:-/opt/whatsapp-chatbot}"
DB="${DB:-$ROOT/data/chatbot.db}"

cd "$ROOT"
echo "=== Mensajes al cliente con datos de agente (últimas ${HOURS}h) ==="
echo "commit: $(git log -1 --oneline 2>/dev/null || echo unknown)"
echo

sqlite3 -header -column "$DB" "
SELECT datetime(timestamp) AS at,
       phone_number,
       length(content) AS chars,
       substr(content, 1, 2000) AS message
FROM conversations
WHERE timestamp >= datetime('now', '-${HOURS} hours')
  AND role = 'assistant'
  AND (
    lower(content) LIKE '%miguel%'
    OR lower(content) LIKE '%josé%'
    OR lower(content) LIKE '%jose%'
    OR lower(content) LIKE '%david%'
    OR lower(content) LIKE '%álvaro%'
    OR lower(content) LIKE '%alvaro bazán%'
    OR lower(content) LIKE '%contactará%'
    OR lower(content) LIKE '%contactara%'
    OR lower(content) LIKE '%se pondrá en contacto%'
    OR lower(content) LIKE '%paso todos los datos%'
    OR lower(content) LIKE '%lead%'
    OR content GLOB '*620*555*'
    OR content GLOB '*663*057*'
    OR content GLOB '*692*682*'
    OR content GLOB '*646*424*'
  )
ORDER BY timestamp DESC
LIMIT 30;
"

echo
echo "=== Cierres estándar (segundo mensaje email→WhatsApp) últimas ${HOURS}h ==="
sqlite3 -header -column "$DB" "
SELECT datetime(timestamp) AS at, phone_number, content
FROM conversations
WHERE timestamp >= datetime('now', '-${HOURS} hours')
  AND role = 'assistant'
  AND content LIKE 'Si tienes alguna duda o quieres concretar algo más, escríbeme por aquí%'
ORDER BY timestamp DESC
LIMIT 15;
"

echo
echo "=== Fin ==="
